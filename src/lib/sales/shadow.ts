/**
 * The sales shadow on the live reply path (D-127): after a reply is drafted, record whether
 * a next step WOULD have been offered, which one, and whether the customer's message was a
 * lead. Nothing here can change what the customer is sent.
 *
 * ## Why it cannot alter a reply
 *
 *  - It runs AFTER `handleReception` returned `drafted`: the outbound row exists and its body
 *    is the one the send path will read. This module READS that body; it never writes to
 *    `outbound_messages`, and it has no model call, no Graph call and no alert.
 *  - Its only write is `quality_flags` — one `sales_next_step_shadow` row per reply, and one
 *    `sales_lead_shadow` row when the message carries a phone number.
 *  - It is called through a worker effect that is awaited for a bounded time beside the
 *    claim, and whose failures are logged and swallowed (`worker/reception.ts`). A shadow
 *    that cannot read its tables records nothing and returns why.
 *
 * ## Nothing in a record is customer text
 *
 * `quality_flags` is not reached by the retention purge, so a record here outlives the
 * message it describes. The detail is ids, kinds and verdicts; a phone number is stored as
 * «7600****» and never as digits (`sales/phone.ts`).
 *
 * ## Its own reads, never the context load
 *
 * `loadReceptionContext` is the reply path, and a table it reads that the project lacks
 * 503s every reply (CLAUDE.md, the `canned_hash` lesson). These reads are separate, so an
 * unpushed `0051` costs the shadow and nothing else.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CannedRow } from '../gate/match.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';
import type { CommentRule } from '../comments/classify.ts';
import { respell, type Spelling } from '../mn/latin.ts';
import { servicesFromPrefix } from '../quality/serviceNames.ts';
import { SECTION_LABELS } from '../prompt/tenant.ts';
import { wholeMessageMatches } from '../mn/match.ts';
import { publishedNumbers } from './phone.ts';
import { sendTelegram } from '../alerts/alert.ts';
import {
  LEAD_FLAG, NEXT_STEP_FLAG, classifyReply, decide, leadDetail, nextStepDetail, parsePlaybook, stepHosts,
  type Decision, type Playbook,
} from './nextStep.ts';

export type SalesShadowInput = {
  tenantId: string;
  conversationId: string;
  /** The customer's stored inbound message. */
  messageId: string;
  /** The reply `handleReception` drafted. */
  outboundId: string;
  customerMessage: string;
  customerSentPhoto: boolean;
  /** Turns BEFORE this message, oldest first. */
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  /** `outcome.refusal` was set: the handoff line was served for a refusal. */
  refusal: boolean;
  /** `conversations.thread_control` as the worker read it, or 'unreadable'. */
  threadControl: string;
  promptStable: string;
  canned: readonly CannedRow[];
  deterministic: readonly DeterministicRule[];
  spellings: readonly Spelling[];
  now: Date;
};

export type SalesShadowOutcome =
  | { outcome: 'off' }
  | { outcome: 'recorded'; decision: Decision }
  | { outcome: 'unusable'; detail: string };

type Loaded = {
  playbook: Playbook | null;
  complaintRules: CommentRule[];
  body: string | null;
  offeredBefore: boolean;
  leadBefore: boolean;
  relatedBefore: boolean;
};

async function load(db: SupabaseClient, input: SalesShadowInput): Promise<{ ok: true; value: Loaded } | { ok: false; detail: string }> {
  const [pb, steps, pairs, rules, prior, reply] = await Promise.all([
    db.from('sales_playbooks').select('mode, lead_route, small_talk').eq('tenant_id', input.tenantId).maybeSingle(),
    db.from('sales_next_steps')
      .select('kind, body, reviewed_at, link, priority, is_default, intent_matcher, enabled')
      .eq('tenant_id', input.tenantId),
    db.from('service_pairings').select('service_name, related_name, enabled, provenance').eq('tenant_id', input.tenantId),
    db.from('comment_rules').select('rule_key, verdict, matcher')
      .eq('tenant_id', input.tenantId).eq('enabled', true).eq('verdict', 'escalate'),
    db.from('quality_flags').select('flag, detail')
      .eq('tenant_id', input.tenantId).eq('conversation_id', input.conversationId)
      .in('flag', [NEXT_STEP_FLAG, LEAD_FLAG]).limit(500),
    db.from('outbound_messages').select('body').eq('tenant_id', input.tenantId).eq('id', input.outboundId).maybeSingle(),
  ]);
  if (pb.error) return { ok: false, detail: `sales_playbooks unreadable: ${pb.error.message}` };
  if (pb.data === null) {
    return { ok: true, value: { playbook: null, complaintRules: [], body: null, offeredBefore: false, leadBefore: false, relatedBefore: false } };
  }
  for (const [name, r] of [['sales_next_steps', steps], ['service_pairings', pairs], ['comment_rules', rules],
    ['quality_flags', prior], ['outbound_messages', reply]] as const) {
    if (r.error) return { ok: false, detail: `${name} unreadable: ${r.error.message}` };
  }
  const row = pb.data as Record<string, unknown>;
  const parsed = parsePlaybook({
    mode: row['mode'],
    lead_route: row['lead_route'],
    small_talk: row['small_talk'],
    steps: (steps.data ?? []) as Record<string, unknown>[],
    pairings: (pairs.data ?? []) as Record<string, unknown>[],
  });
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  const flags = (prior.data ?? []) as { flag: string; detail: Record<string, unknown> | null }[];
  const bodyRow = reply.data as Record<string, unknown> | null;
  return {
    ok: true,
    value: {
      playbook: parsed.playbook,
      complaintRules: ((rules.data ?? []) as Record<string, unknown>[]).map((r) => ({
        ruleKey: String(r['rule_key']), verdict: 'escalate' as const, matcher: r['matcher'],
      })),
      body: bodyRow === null || typeof bodyRow['body'] !== 'string' ? null : bodyRow['body'],
      offeredBefore: flags.some((f) => f.flag === NEXT_STEP_FLAG
        && (f.detail?.['verdict'] === 'offer' || f.detail?.['verdict'] === 'in_reply')),
      leadBefore: flags.some((f) => f.flag === LEAD_FLAG),
      relatedBefore: flags.some((f) => f.flag === NEXT_STEP_FLAG && f.detail?.['related'] !== undefined),
    },
  };
}

/**
 * A LIVE playbook's new lead, sent where the playbook says (D-132). Only `founder_telegram` is
 * built: the platform's own chat, which is DalaTech's. The number is the whole point of the
 * message — somebody has to call it — so it is sent as digits here, and only here: the flag
 * rows keep the masked form. A repeat of a number already given is not sent twice.
 */
export function leadNotice(input: { decision: Decision; playbook: Playbook; customerMessage: string; conversationId: string }): string | null {
  const l = input.decision.lead;
  if (input.playbook.mode !== 'live' || !l.detected || l.repeat || input.playbook.leadRoute !== 'founder_telegram') return null;
  const digits = [...new Set(input.decision.phones.map((p) => p.digits))];
  const said = [...input.customerMessage.replace(/\s+/gu, ' ').trim()];
  const text = said.length <= 200 ? said.join('') : `${said.slice(0, 199).join('')}…`;
  return `📞 New lead: ${digits.join(', ')}\nThey wrote: «${text}»\nConversation ${input.conversationId}`;
}

export async function recordSalesShadow(
  db: SupabaseClient,
  input: SalesShadowInput,
  notify: (text: string) => Promise<unknown> = sendTelegram,
): Promise<SalesShadowOutcome> {
  const loaded = await load(db, input);
  if (!loaded.ok) return { outcome: 'unusable', detail: loaded.detail };
  const { playbook } = loaded.value;
  if (playbook === null || playbook.mode === 'off') return { outcome: 'off' };

  const bookingLine = input.canned.find((c) => c.kind === 'booking_line' && c.reviewedAt !== null)?.body;
  // The tenant's small-talk rows: whole-message rows that answer on their own (a greeting,
  // «who are you»). Their bodies classify the REPLY; their phrases classify the MESSAGE.
  const smallTalk = input.deterministic.filter((r) => r.enabled && r.placement === 'replace' && r.matchMode === 'whole_message');
  const facts = classifyReply({
    body: loaded.value.body,
    refusal: input.refusal,
    canned: input.canned,
    smallTalkBodies: smallTalk.map((r) => r.body),
    hosts: stepHosts(playbook.steps, bookingLine === undefined ? [] : [bookingLine]),
  });

  const decision = decide({
    playbook,
    customerMessage: input.customerMessage,
    respelled: respell(input.customerMessage, input.spellings),
    customerSentPhoto: input.customerSentPhoto,
    earlierCustomerMessages: input.history.filter((h) => h.role === 'user').map((h) => h.content),
    reply: facts,
    threadControl: input.threadControl,
    offeredBefore: loaded.value.offeredBefore,
    leadBefore: loaded.value.leadBefore,
    relatedBefore: loaded.value.relatedBefore,
    customerSmallTalk: smallTalk.some((r) => wholeMessageMatches(input.customerMessage, r.stems))
      || wholeMessageMatches(input.customerMessage, playbook.smallTalk ?? []),
    complaintRules: loaded.value.complaintRules,
    ownNumbers: publishedNumbers([input.promptStable, ...input.canned.map((c) => c.body)]),
    serviceNames: servicesFromPrefix(input.promptStable, SECTION_LABELS.priceList).map((s) => s.name),
  });

  const ids = { outbound_id: input.outboundId, mode: playbook.mode };
  // Two literal inserts rather than one array, so `scripts/verify/query-columns.ts` can read
  // every key against the schema. The lead row is rare; its extra round trip is off the reply.
  const step = await db.from('quality_flags').insert({
    tenant_id: input.tenantId,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    flag: NEXT_STEP_FLAG,
    detail: nextStepDetail(decision, ids),
    at: input.now.toISOString(),
  });
  if (step.error) return { outcome: 'unusable', detail: `quality_flags insert failed: ${step.error.message}` };
  if (decision.lead.detected) {
    const lead = await db.from('quality_flags').insert({
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      flag: LEAD_FLAG,
      detail: leadDetail(decision.lead, ids),
      at: input.now.toISOString(),
    });
    if (lead.error) return { outcome: 'unusable', detail: `quality_flags lead insert failed: ${lead.error.message}` };
    const notice = leadNotice({ decision, playbook, customerMessage: input.customerMessage, conversationId: input.conversationId });
    if (notice !== null) {
      // After the lead row, so a lead that could not be sent is still on record (masked).
      const sent = await notify(notice).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
      if ((sent as { ok?: boolean } | undefined)?.ok === false) {
        console.error('[worker] sales_lead_notice_failed', { tenantId: input.tenantId, conversationId: input.conversationId });
      }
    }
  }
  return { outcome: 'recorded', decision };
}

/**
 * The worker effect: `recordSalesShadow`, logged, and never rejecting. A shadow failure is
 * one line in the log and nothing else — the reply it describes has already been decided.
 * The log carries kinds and verdicts only, like the rows.
 */
export async function salesShadowEffect(db: SupabaseClient, input: SalesShadowInput): Promise<void> {
  try {
    const r = await recordSalesShadow(db, input);
    if (r.outcome === 'unusable') {
      console.warn('[worker] sales_shadow_unusable', { tenantId: input.tenantId, detail: r.detail });
    } else if (r.outcome === 'recorded') {
      const n = r.decision.nextStep;
      console.info('[worker] sales_shadow', {
        tenantId: input.tenantId,
        verdict: n.verdict,
        ...(n.verdict === 'offer' ? { kind: n.kind, row: n.row } : n.verdict === 'skip' ? { reason: n.reason } : {}),
        lead: r.decision.lead.detected,
      });
    }
  } catch (e) {
    console.error('[worker] sales_shadow_threw', { tenantId: input.tenantId, detail: e instanceof Error ? e.message : String(e) });
  }
}
