/**
 * The reception worker's decision logic, with nothing in it that a test cannot reach.
 *
 * ## Why this is not in the route file
 *
 * It was, and that made it the one file in the repository with real branching and no test
 * coverage — twenty-odd early returns, each of which is a decision about a customer's
 * reply or a tenant's money, and none of which anything checked. A Next.js route handler
 * is awkward to test for uninteresting reasons (module-scope clients, `next/server`, an
 * env read at import time), so the reasons win and the branches go unchecked.
 *
 * The fix is the shape `reception/handle.ts` and `reception/deps.ts` already use here:
 * the decision takes its effects as an argument and returns a value. The route becomes an
 * adapter thin enough that reading it is the same as verifying it.
 *
 * This module returns `{ status, body }` rather than a `NextResponse`, so it does not
 * import `next/server` either.
 *
 * ## The status codes are the contract with QStash, not decoration
 *
 * Three meanings, and confusing any two of them loses a customer's message or bills for it
 * twice:
 *
 *  - **503** — we could not determine something. QStash retries; nothing is lost.
 *  - **200 with a `dropped`/`refused` reason** — determinate and unanswerable. Retrying
 *    cannot change it, so a retry would be a loop against a state only a human can fix.
 *  - **401** — the signature failed. Not ours to process at all.
 *
 * A 200 for a transient failure drops the event forever. A 503 for a determinate one is a
 * redelivery loop. Every early return below is one of those three on purpose.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canDeliver } from '../channel/delivery.ts';
import { extractInboundMessages } from '../meta/extract.ts';
import { ensureContact, ensurePerson, openConversation, readHistory, recordInbound } from '../inbound/persist.ts';
import { loadReceptionContext } from '../reception/load.ts';
import { renderVolatile, tenantClock } from '../reception/volatile.ts';
import { RECEPTION_HISTORY_TURNS } from '../model/reception.ts';
import { withTenantRole } from '../guard/withTenantRole.ts';
import { claim } from '../outbound/claim.ts';
import { markEventState } from '../webhook/events.ts';
import { usdToNano } from '../money.ts';
import { isFresh, replyAgeLimitMinutes } from './freshness.ts';
import { runCommentJob, type CommentEffects, type CommentJobResult } from './comments.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { Turn } from '../inbound/persist.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import type { Reservation } from '../spend/reserve.ts';
import type { ReceptionContext } from '../reception/load.ts';

/**
 * What one Reception reply is expected to cost, reserved before the call and settled
 * against the real `usage` afterwards. From D-016's measured $0.0090/reply, rounded up:
 * an under-estimate lets a burst slip past the ceiling between reserve and settle.
 */
export const RECEPTION_REPLY_ESTIMATE = usdToNano(0.012);

export type GenerateArgs = {
  tenantId: string;
  channelId: string;
  conversationId: string;
  inboundExternalId: string;
  reservation: Reservation;
  customerMessage: string;
  history: readonly Turn[];
  eventAt: Date;
  promptVolatile: string;
  ctx: ReceptionContext;
  historyEmpty: boolean;
};

export type DeliverArgs = {
  tenantId: string;
  channelId: string;
  pageId: string;
  recipientId: string;
  outboundId: string;
  body: string;
  attempts: number;
  graphVersion: string;
};

/**
 * Everything the job does that is not a database read.
 *
 * `db` is here rather than injected per call because every query already goes through the
 * same stub shape the rest of this codebase's tests use — the point of the seam is the
 * effects a stub cannot express: a signature, a model call, an HTTP send, and the clock.
 */
export type WorkerEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (raw: string, signature: string | null) => Promise<boolean>;
  /** `META_GRAPH_VERSION`, read lazily so an unconfigured deployment fails at use. */
  graphVersionDefault: () => string;
  generateReply: (args: GenerateArgs) => Promise<ReceptionOutcome>;
  deliver: (args: DeliverArgs) => Promise<DeliverOutcome>;
  /**
   * §3.9's "Quality flag" on a refusal. Best-effort by construction: it is evidence for a
   * person to read later, never a control, and a flag that cannot be written must not
   * change what the customer gets.
   */
  flagQuality: (args: { tenantId: string; conversationId: string; code: string; detail: string }) => Promise<void>;
  /** Structured, and injected so a test can assert the REASON rather than the status. */
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
  /** The public-comment surface. Its own effects, because it is its own surface. */
  replyToComment: CommentEffects['replyToComment'];
};

export type JobResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): JobResult => ({ status: 200, body: { ok: true, ...body } });
const unavailable = (code: string): JobResult => ({ status: 503, body: { error: code } });

export async function runReceptionJob(
  fx: WorkerEffects,
  request: { rawBody: string; signature: string | null },
): Promise<JobResult> {
  if (!(await fx.verifySignature(request.rawBody, request.signature))) {
    return { status: 401, body: { error: 'worker.signature_invalid' } };
  }

  let job: { eventId?: unknown; tenantId?: unknown; channelId?: unknown };
  try {
    job = JSON.parse(request.rawBody) as typeof job;
  } catch {
    // Malformed after a VALID signature means WE published it wrong. Retrying cannot fix
    // that, so 200 to stop the redelivery loop and let the log carry it.
    fx.log('error', 'job_not_json');
    return ok({ dropped: 'job_not_json' });
  }

  const eventId = typeof job.eventId === 'number' ? job.eventId : null;
  const tenantId = typeof job.tenantId === 'string' ? job.tenantId : null;
  const channelId = typeof job.channelId === 'string' ? job.channelId : null;
  if (eventId === null || tenantId === null || channelId === null) {
    fx.log('error', 'job_missing_fields');
    return ok({ dropped: 'job_missing_fields' });
  }

  const { db, now } = fx;

  // --- The stored entry. One source, parsed once, at the point of use. -------
  const { data: event, error: eventErr } = await db
    .from('webhook_events')
    .select('raw_payload')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) {
    fx.log('error', 'event_unreadable', { eventId, detail: eventErr.message });
    return unavailable('worker.event_unreadable');
  }
  if (event === null) {
    fx.log('error', 'event_missing', { eventId });
    return ok({ dropped: 'event_missing' });
  }

  const rawPayload = (event as Record<string, unknown>)['raw_payload'];
  const { messages, skipped } = extractInboundMessages(rawPayload);

  // --- Tenant settings and the compiled context, read once for the whole entry.
  const { data: tenantRow, error: tenantErr } = await db
    .from('tenants')
    .select('default_locale, prompt_cache_mode, timezone, max_reply_age_minutes')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantErr || tenantRow === null) {
    fx.log('error', 'tenant_unreadable', { tenantId, detail: tenantErr?.message });
    return unavailable('worker.tenant_unreadable');
  }
  const t = tenantRow as Record<string, unknown>;
  const settings = {
    defaultLocale: String(t['default_locale'] ?? 'mn-MN'),
    promptCacheMode: String(t['prompt_cache_mode'] ?? 'off') as 'off' | '5m' | '1h',
  };
  const timezone = String(t['timezone'] ?? 'Asia/Ulaanbaatar');
  const replyAgeLimit = replyAgeLimitMinutes(t['max_reply_age_minutes']);
  // "Today" is a question about the tenant's clock, so the date the closure query filters
  // on is computed here rather than in SQL's `current_date`, which is the server's.
  const localDate = tenantClock(now, timezone).date;

  // --- The channel: where a reply would go, and whether it may go at all. ---
  const { data: channelRow, error: channelErr } = await db
    .from('tenant_channels')
    .select('external_id, delivery_mode, graph_version_override, comment_policy, comment_max_post_age_days, ignore_commenter_ids')
    .eq('id', channelId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (channelErr) {
    fx.log('error', 'channel_unreadable', { tenantId, channelId, detail: channelErr.message });
    return unavailable('worker.channel_unreadable');
  }
  if (channelRow === null) {
    // Unreadable is transient and a missing channel is not: the job named a binding that
    // does not belong to this tenant, which retrying cannot fix.
    fx.log('error', 'channel_missing', { tenantId, channelId });
    return ok({ dropped: 'channel_missing' });
  }
  const c = channelRow as Record<string, unknown>;
  const pageId = String(c['external_id'] ?? '');
  const delivery = canDeliver(String(c['delivery_mode'] ?? ''));
  const override = c['graph_version_override'];
  const graphVersion = typeof override === 'string' && override !== '' ? override : fx.graphVersionDefault();

  // --- The public surface. A `feed` entry has no `messaging`, so this is where a
  // comments-only event is handled; a `messages` entry yields no comments and skips it.
  let commentResult: CommentJobResult | null = null;
  if (String(c['comment_policy'] ?? 'none') !== 'none') {
    commentResult = await runCommentJob(
      { db, now, replyToComment: fx.replyToComment, log: fx.log },
      {
        tenantId,
        channelId,
        pageExternalId: pageId,
        deliveryMode: String(c['delivery_mode'] ?? ''),
        graphVersion,
        locale: settings.defaultLocale,
        config: {
          policy: String(c['comment_policy'] ?? 'none'),
          maxPostAgeDays: Number(c['comment_max_post_age_days'] ?? 30),
          ignoreCommenterIds: Array.isArray(c['ignore_commenter_ids'])
            ? (c['ignore_commenter_ids'] as unknown[]).map(String)
            : [],
        },
        rawPayload,
      },
    );
    if (commentResult.retry) return unavailable('worker.comment_retry');
  }

  if (messages.length === 0) {
    // Nothing answerable in the DM sense — an echo, a receipt, a sticker, or a `feed`
    // entry that carried only comments. Seen and declined is a different fact from
    // vanished, so the reason is recorded and the event is processed.
    fx.log('info', 'nothing_to_answer', { eventId, skipped });
    await markEventState(db, eventId, 'processed');
    return ok({ eventId, skipped, ...(commentResult === null ? {} : { comments: commentResult }) });
  }

  const loaded = await loadReceptionContext(db, { tenantId, channel: 'facebook_page', settings, localDate });
  if (!loaded.ok) {
    fx.log('error', 'context_unavailable', { tenantId, code: loaded.code, detail: loaded.detail });
    if (loaded.code === 'not_provisioned') {
      // Determinate: retrying cannot provision a tenant. ACK and let the operator alert
      // carry it, rather than looping QStash against a state only a human can change.
      await markEventState(db, eventId, 'blocked_no_token');
      return ok({ refused: loaded.code });
    }
    return unavailable(loaded.code);
  }
  const ctx = loaded.context;

  /**
   * L4, the volatile tail. Its own `system` block with no `cache_control`, which is what
   * makes the ancestor's trap structurally unavailable: it concatenates its closure
   * section onto the cached base prompt, so anything date-shaped added there invalidates
   * every entry, silently, and the bill roughly triples.
   */
  const promptVolatile = renderVolatile({
    now, timezone, channel: 'facebook_page', hours: ctx.hours, closures: ctx.closures,
  });

  // --- One message, one reservation, one reply. -----------------------------
  const drafted: string[] = [];
  const sent: string[] = [];
  const stale: string[] = [];

  for (const message of messages) {
    // A missing Meta timestamp arrives as an invalid date; treating it as `now` stops it
    // reading as 1970 and being dropped as stale for the wrong reason.
    const eventAt = Number.isNaN(message.sentAt.getTime()) ? now : message.sentAt;

    const contact = await ensureContact(db, { tenantId, channelId, externalId: message.senderId, now });
    if (!contact.ok) {
      fx.log('error', 'contact_failed', { detail: contact.detail });
      return unavailable('worker.contact_failed');
    }
    if (contact.value.personId === null) {
      // Best-effort: the person layer exists for consent, and a first message should not
      // fail because it had a bad day. A missing person is visible in the row.
      const person = await ensurePerson(db, {
        tenantId, contactId: contact.value.contactId, kind: 'psid', externalId: message.senderId,
      });
      if (!person.ok) fx.log('error', 'person_failed', { detail: person.detail });
    }

    const conversation = await openConversation(db, {
      tenantId, contactId: contact.value.contactId, channelId, now,
    });
    if (!conversation.ok) {
      fx.log('error', 'conversation_failed', { detail: conversation.detail });
      return unavailable('worker.conversation_failed');
    }
    const conversationId = conversation.value.conversationId;

    const stored = await recordInbound(db, {
      tenantId, conversationId, externalId: message.externalId, body: message.text, now,
    });
    if (!stored.ok) {
      fx.log('error', 'message_failed', { detail: stored.detail });
      return unavailable('worker.message_failed');
    }
    // A redelivery: this exact customer message is already stored, so it has already been
    // answered or is being answered. Generating again would double-reply and double-bill.
    if (stored.value.duplicate) continue;

    // §3.9's check 7. AFTER the message is persisted — §3.4.5's "persist everything,
    // generate nothing" — and before the reservation, so a message nobody wants answered
    // costs three rows and not a reservation, a model call or a send.
    if (!isFresh(eventAt, now, replyAgeLimit)) {
      const ageMinutes = Math.round((now.getTime() - eventAt.getTime()) / 60_000);
      fx.log('warn', 'reply_too_late', { tenantId, externalId: message.externalId, ageMinutes, limitMinutes: replyAgeLimit });
      // The customer's question is stored and now visible to the Quality layer as one
      // nobody answered, which is exactly what it is.
      await fx.flagQuality({
        tenantId,
        conversationId,
        code: 'reply_too_late',
        detail: `${ageMinutes} minutes old; the tenant's limit is ${replyAgeLimit}`,
      });
      stale.push(message.externalId);
      continue;
    }

    // History is read AFTER storing, so the turn just received is not also passed as
    // history — the model would otherwise see the question twice.
    const history = await readHistory(db, { tenantId, conversationId, limit: RECEPTION_HISTORY_TURNS + 1 });
    if (!history.ok) {
      // An unreadable history is never an empty one: without the distinction a hiccup
      // makes the bot greet an existing customer from scratch.
      fx.log('error', 'history_failed', { detail: history.detail });
      return unavailable('worker.history_failed');
    }
    const priorTurns = history.value.slice(0, -1);

    // The chokepoint. Nothing downstream may re-implement any part of this.
    const guard = await withTenantRole(db, {
      tenantId, role: 'reception', surface: 'reception', channel: 'facebook_page',
      estimate: RECEPTION_REPLY_ESTIMATE, conversationId, webhookEventId: eventId, now,
    });

    if (!guard.ok) {
      const { refusal } = guard;
      fx.log('warn', 'refused', { code: refusal.code, tenantId, eventId });
      // 503 means "we could not determine" — QStash must retry, so nothing is lost.
      if (refusal.status === 503) return unavailable(refusal.code);
      // 403/429 are determinate. Retrying cannot change them, so ACK and let the §5.7
      // degradation ladder answer the customer. Never silence.
      await markEventState(db, eventId, refusal.status === 429 ? 'shed' : 'blocked_no_token');
      return ok({ refused: refusal.code });
    }

    const outcome = await fx.generateReply({
      tenantId, channelId, conversationId,
      inboundExternalId: message.externalId,
      reservation: guard.reservation,
      customerMessage: message.text,
      history: priorTurns,
      eventAt,
      promptVolatile,
      ctx,
      // The history was read successfully or we would have 503'd above. `empty` is about
      // the turns BEFORE this one — the inbound row was stored a moment ago, so a first
      // message leaves priorTurns empty.
      historyEmpty: priorTurns.length === 0,
    });

    if (outcome.kind === 'retry') {
      fx.log('error', 'reception_retry', { detail: outcome.detail });
      return unavailable('worker.reception_retry');
    }
    if (outcome.kind === 'dropped') {
      fx.log('warn', 'reception_dropped', { reason: outcome.reason });
      continue;
    }
    drafted.push(outcome.outboundId);
    if (outcome.refusal !== undefined) {
      fx.log('warn', 'answered_with_handoff', { code: outcome.refusal, conversationId });
    }

    // --- H14: claim the draft and put it on the wire. ---------------------
    if (!delivery.deliver) {
      // Generated and deliberately not sent. The row stays `draft`, so the day the
      // channel goes live it is claimable rather than lost.
      fx.log('info', 'not_delivering', { tenantId, channelId, detail: delivery.detail });
      continue;
    }

    const held = await claim(db, { id: outcome.outboundId, tenantId, now });
    if (held.outcome === 'unavailable') {
      fx.log('error', 'claim_unavailable', { detail: held.detail });
      return unavailable('worker.claim_unavailable');
    }
    if (held.outcome !== 'claimed') {
      // Already sent, or another worker holds a live lease. Both mean this reply is
      // somebody else's business; neither is an error.
      fx.log('info', 'not_ours', { outboundId: outcome.outboundId, outcome: held.outcome });
      continue;
    }

    const delivered = await fx.deliver({
      tenantId, channelId, pageId,
      recipientId: message.senderId,
      outboundId: held.id,
      // The STORED body, never the one just generated: on a redelivery `claim` returns
      // what was written the first time, and re-reading it here is what makes a retry a
      // re-send rather than a second answer.
      body: held.body,
      attempts: held.attempts,
      graphVersion,
    });

    if (delivered.outcome === 'sent') {
      sent.push(held.id);
      if (delivered.bookkeeping !== undefined) {
        // The customer has the message. Everything after that is bookkeeping, and a
        // bookkeeping failure must never make the next redelivery send it again.
        fx.log('error', 'send_bookkeeping_failed', { outboundId: held.id, detail: delivered.bookkeeping });
      }
      continue;
    }
    if (delivered.outcome === 'indeterminate') {
      // Parked, alerted, and outside CLAIMABLE. 200 so QStash does not retry it — the
      // whole point is that no automatic retry may touch this row.
      fx.log('warn', 'send_indeterminate', { outboundId: held.id, detail: delivered.detail });
      continue;
    }
    if (delivered.retryable) {
      // 613 or a 5xx. The lease is released and the stored body is intact, so the
      // redelivery re-sends rather than re-generating.
      fx.log('warn', 'send_retryable', { outboundId: held.id, failure: delivered.failure });
      return unavailable(`worker.send_${delivered.failure}`);
    }
    fx.log('error', 'send_terminal', { outboundId: held.id, failure: delivered.failure, detail: delivered.detail });
  }

  // Every message in the entry is accounted for.
  await markEventState(db, eventId, 'processed');
  return ok({
    eventId, drafted: drafted.length, sent: sent.length, stale: stale.length, skipped,
    ...(commentResult === null ? {} : { comments: commentResult }),
  });
}
