/**
 * The reception worker. QStash calls this; customers never do.
 *
 * **Everything this route decides lives in `@/lib/worker/reception`**, which takes its
 * effects as an argument and returns `{ status, body }`. What is left here is the binding:
 * which Supabase key, which clock, which signature verifier, and how a reply is actually
 * generated and sent. That split is the same one `reception/handle.ts` and
 * `reception/deps.ts` already use, and it exists because a route handler is awkward to
 * test for uninteresting reasons — so the reasons win, and twenty-odd branches about a
 * customer's reply and a tenant's money go unchecked.
 *
 * The rule that keeps it honest: **nothing in this file may branch.** A condition here is
 * a condition no test can reach, so it belongs one module down.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { required } from '@/lib/env';
import { handleReception } from '@/lib/reception/handle';
import { buildDeps } from '@/lib/reception/deps';
import { deliverOutbound } from '@/lib/outbound/deliver';
import { loadTenantSecret } from '@/lib/secrets/tenantSecret';
import { sendCommentReply } from '@/lib/comments/send';
import { sendMessage, sendSenderAction } from '@/lib/meta/send';
import { lookupComment } from '@/lib/comments/lookup';
import { raiseCommentComplaint } from '@/lib/comments/complaint';
import { buildDeliverDeps } from '@/lib/outbound/deliverDeps';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '@/config/platform';
import { SECTION_LABELS } from '@/lib/prompt/tenant';
import { raiseAlert } from '@/lib/alerts/alert';
import { runReceptionJob, type WorkerEffects } from '@/lib/worker/reception';
import { raiseDeliveryExhausted } from '@/lib/worker/exhaustedAlert';
import { servicesFromPrefix, sectionRows, faqAnswersFromPrefix } from '@/lib/quality/serviceNames';
import { salesShadowEffect } from '@/lib/sales/shadow';

export const runtime = 'nodejs';
export const maxDuration = 60;

function effects(now: Date): WorkerEffects {
  const db = supabaseWorker();
  return {
    db,
    now,
    verifySignature: (raw, signature) => verifyQStashSignature(raw, signature),
    graphVersionDefault: () => required('META_GRAPH_VERSION'),

    alertStandby: async ({ tenantId, channelId, dayKey, events }) => {
      await raiseAlert(db, {
        tenantId,
        severity: 'critical',
        kind: 'channel.standby_not_primary',
        dedupKey: `standby:${channelId}:${dayKey}`,
        body:
          `Channel ${channelId}: Meta delivered ${events} message(s) into entry.standby, so another app ` +
          '(almost always the Page Inbox) is the PRIMARY receiver for this Page. Reception cannot answer ' +
          'anyone here until that is changed in the Page settings.',
      });
    },

    generateReply: (a) =>
      handleReception(
        buildDeps({
          db,
          tenantId: a.tenantId,
          channelId: a.channelId,
          conversationId: a.conversationId,
          cacheMode: a.ctx.cacheMode,
          inboundExternalId: a.inboundExternalId,
          reservation: a.reservation,
          now,
        }),
        {
          customerMessage: a.customerMessage,
          customerAttachments: a.customerAttachments,
          customerSentPhoto: a.customerSentPhoto,
          history: a.history,
          eventAt: a.eventAt,
          now,
          promptStable: a.ctx.promptStable,
          promptVolatile: a.promptVolatile,
          modelId: MODEL_REGISTRY.reception,
          cacheMode: a.ctx.cacheMode,
          timeoutMs: RECEPTION_UPSTREAM_TIMEOUT_MS,
          rules: a.ctx.rules,
          deterministic: a.ctx.deterministic,
          days: a.ctx.days,
          historyState: { known: true, empty: a.historyEmpty },
          canned: a.ctx.canned,
          tenantGuard: a.ctx.tenantGuard,
          cannedLabel: SECTION_LABELS.canned,
          serviceNames: servicesFromPrefix(a.ctx.promptStable, SECTION_LABELS.priceList),
          serviceAliases: a.ctx.serviceAliases,
          spellings: a.ctx.spellings,
          depositRows: sectionRows(a.ctx.promptStable, SECTION_LABELS.deposits),
          faqAnswers: faqAnswersFromPrefix(a.ctx.promptStable, SECTION_LABELS.faqs),
          branches: a.ctx.branches,
          cannedHash: a.ctx.cannedHash,
          fallbackLine: a.ctx.fallbackLine,
          // The Page's inbox is read by a person, so the handoff line's promise holds.
          noInbox: false,
          complaintRules: a.ctx.complaintRules,
          sales: a.ctx.sales,
          replyStyle: a.ctx.replyStyle,
        },
      ),

    deliver: (a) =>
      deliverOutbound(
        buildDeliverDeps({
          db,
          tenantId: a.tenantId,
          channelId: a.channelId,
          outboundId: a.outboundId,
          attempts: a.attempts,
          now,
        }),
        a,
      ),

    /**
     * The typing bubble. Cosmetic, and it must stay cosmetic.
     *
     * Every failure resolves quietly: no credential, no channel, a Graph refusal, a
     * timeout. The worker does not await this, so a rejected promise here would be an
     * unhandled rejection on a lambda mid-reply — and the thing it decorates is worth
     * nothing next to the reply itself.
     *
     * The token is loaded per call rather than hoisted, for the reason in
     * `secrets/tenantSecret.ts`: a warm lambda is reused across tenants and a cached
     * credential is one refactor from being the wrong salon's.
     */
    showTyping: async ({ tenantId, channelId, recipientId, action }) => {
      // One line per bubble, so the live logs can say whether it was shown (D-124): until
      // this line nothing recorded the outcome, and "the bubble works" could not be read
      // from production at all.
      const started = Date.now();
      let outcome = 'sent';
      try {
        const { data, error } = await db
          .from('tenant_channels').select('external_id').eq('id', channelId).maybeSingle();
        const pageId = error !== null || data === null ? '' : String((data as Record<string, unknown>)['external_id'] ?? '');
        const secret = pageId === '' ? null : await loadTenantSecret(db, { tenantId, channelId, kind: 'page_token' });
        const ok = secret === null || !secret.ok ? false : await sendSenderAction({
          pageId, recipientId, token: secret.secret,
          graphVersion: required('META_GRAPH_VERSION'), action: action ?? 'typing_on',
        });
        outcome = pageId === '' ? 'no_channel' : secret === null || !secret.ok ? 'no_credential' : ok ? 'sent' : 'refused';
      } catch {
        // Cosmetic. There is nothing to classify and nothing a caller could do.
        outcome = 'threw';
      }
      console.info('[worker] typing_indicator', { action: action ?? 'typing_on', outcome, ms: Date.now() - started });
    },

    // The public surface, on the same per-request token as the DM path. `loadTenantSecret`
    // is called per reply rather than hoisted, for the reason in secrets/tenantSecret.ts:
    // a warm lambda is reused across tenants and there must be nothing cached to leak.
    replyToComment: async ({ tenantId, channelId, commentId, body, graphVersion }) => {
      const secret = await loadTenantSecret(db, { tenantId, channelId, kind: 'page_token' });
      if (!secret.ok) {
        return {
          outcome: 'failed', failure: 'unknown', retryable: secret.retryable,
          code: null, subcode: null, status: null,
          detail: `no credential: ${secret.code}`,
        };
      }
      return sendCommentReply({ commentId, body, token: secret.secret, graphVersion });
    },

    // The private message to a commenter (D-122): the Messenger send, addressed by comment.
    sendPrivateReply: async ({ tenantId, channelId, pageId, commentId, body, graphVersion }) => {
      const secret = await loadTenantSecret(db, { tenantId, channelId, kind: 'page_token' });
      if (!secret.ok) {
        return { outcome: 'failed', retryable: secret.retryable, failure: 'unknown', detail: `no credential: ${secret.code}` };
      }
      const sent = await sendMessage({
        pageId, recipientId: '', recipientCommentId: commentId, text: body, token: secret.secret, graphVersion,
      });
      return sent.outcome === 'sent' ? { outcome: 'sent', providerMessageId: sent.providerMessageId } : sent;
    },

    // Tags and post age (D-122). An unloadable credential is two unknowns, which refuse.
    lookupComment: async ({ tenantId, channelId, pageId, commentId, postId, graphVersion }) => {
      const secret = await loadTenantSecret(db, { tenantId, channelId, kind: 'page_token' });
      if (!secret.ok) return { tagsPerson: null, postCreatedAt: null, problems: [`no credential: ${secret.code}`] };
      return lookupComment({ commentId, postId, pageId, token: secret.secret, graphVersion });
    },

    alertComplaint: async (input) => {
      const outcome = await raiseCommentComplaint(db, input);
      if (outcome.outcome === 'failed' || outcome.outcome === 'recorded_undelivered') {
        console.error('[worker] comment_complaint_alert_undelivered', { commentId: input.commentId, ...outcome });
      }
    },

    /**
     * QStash's quick retries are spent and the worker refused every one. The decision —
     * page the founder, or record a lost mirror draft when the Page answered the customer
     * anyway — lives in `worker/exhaustedAlert.ts`, where a test can reach it.
     */
    alertDeliveryExhausted: async (input) => {
      const outcome = await raiseDeliveryExhausted(db, input);
      if (outcome === 'alert_failed') {
        console.error('[worker] delivery_exhausted_alert_failed', { eventId: input.eventId });
      }
    },

    flagQuality: async ({ tenantId, conversationId, code, detail, messageId }) => {
      // Best-effort, exactly as `reception/deps.ts` treats its own flags: evidence for a
      // person to read later, never a control. A flag that cannot be written must not
      // change what the customer gets.
      //
      // `tenant_id` is NOT NULL and part of the composite FK to `conversations`, so
      // omitting it is not a tidier insert — it is a write that every stub accepts and
      // PostgREST rejects. A test pins that this key is present.
      const { error } = await db.from('quality_flags').insert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        // The message the flag is about, when the caller has one: the catch-up sweep finds a
        // held message by it (`channel/catchup.ts`).
        message_id: messageId ?? null,
        flag: code,
        detail: { detail },
        at: now.toISOString(),
      });
      if (error) console.error('[worker] quality_flag_write_failed', { code, detail: error.message });
    },

    // The sales shadow (D-127): reads the drafted reply, writes `quality_flags`, never rejects.
    salesShadow: (a) =>
      salesShadowEffect(db, {
        tenantId: a.tenantId,
        conversationId: a.conversationId,
        messageId: a.messageId,
        outboundId: a.outboundId,
        customerMessage: a.customerMessage,
        customerSentPhoto: a.customerSentPhoto,
        history: a.history,
        refusal: a.refusal,
        threadControl: a.threadControl,
        promptStable: a.ctx.promptStable,
        canned: a.ctx.canned,
        deterministic: a.ctx.deterministic,
        spellings: a.ctx.spellings,
        now,
      }),

    log: (level, event, fields) => console[level](`[worker] ${event}`, fields ?? {}),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runReceptionJob(effects(new Date()), {
    rawBody: await request.text(),
    signature: request.headers.get('upstash-signature'),
  });
  return NextResponse.json(result.body, { status: result.status });
}
