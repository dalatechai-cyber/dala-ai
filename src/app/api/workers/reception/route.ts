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
import { sendSenderAction } from '@/lib/meta/send';
import { buildDeliverDeps } from '@/lib/outbound/deliverDeps';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '@/config/platform';
import { SECTION_LABELS } from '@/lib/prompt/tenant';
import { raiseAlert } from '@/lib/alerts/alert';
import { runReceptionJob, type WorkerEffects } from '@/lib/worker/reception';
import { serviceNamesFromPrefix } from '@/lib/quality/serviceNames';

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
          historyState: { known: true, empty: a.historyEmpty },
          canned: a.ctx.canned,
          tenantGuard: a.ctx.tenantGuard,
          cannedLabel: SECTION_LABELS.canned,
          serviceNames: serviceNamesFromPrefix(a.ctx.promptStable, SECTION_LABELS.priceList),
          cannedHash: a.ctx.cannedHash,
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
    showTyping: async ({ tenantId, channelId, recipientId }) => {
      try {
        const { data, error } = await db
          .from('tenant_channels').select('external_id').eq('id', channelId).maybeSingle();
        if (error !== null || data === null) return;
        const pageId = String((data as Record<string, unknown>)['external_id'] ?? '');
        if (pageId === '') return;
        const secret = await loadTenantSecret(db, { tenantId, channelId, kind: 'page_token' });
        if (!secret.ok) return;
        await sendSenderAction({
          pageId, recipientId, token: secret.secret,
          graphVersion: required('META_GRAPH_VERSION'), action: 'typing_on',
        });
      } catch {
        // Cosmetic. There is nothing to classify and nothing a caller could do.
      }
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

    /**
     * QStash has delivered this event for the last time and the worker refused it again.
     *
     * `critical` and `route: 'now'` because the subject is a customer who wrote to a live
     * business and is not going to get an answer from us. That is weighed against the
     * Telegram chat being shared with the people who send demo requests: this fires once
     * per event id, has no period in its key, and cannot repeat for a condition that has
     * not changed. `repeat: 'daily'` with no date in the key makes it an EVENT rather than
     * an episode (D-063) — one delivery run exhausting is a thing that happened and is
     * over, and it never resolves.
     *
     * The body states the delivery count AS A COUNT, which is the whole point. The alert
     * this sits in front of said "never delivered to the worker" about an event delivered
     * three times, because it inferred delivery history from `state`, and `state` does not
     * record it (D-110).
     */
    alertDeliveryExhausted: async ({ tenantId, eventId, attempts, ageMinutes, limitMinutes, code }) => {
      const age = Number.isFinite(ageMinutes) ? Math.floor(ageMinutes) : null;
      // Every arm below is reachable only from values that were actually READ. A NaN age or
      // a limit the job never got to is reported as unknown rather than substituted: this
      // alert exists because the last one asserted something it had not measured, and the
      // platform default (30) is twice Matrix's real limit (15), so a substitution here
      // would print a deadline that is wrong in the generous direction.
      const outcome = limitMinutes === null
        ? 'This delivery failed before the tenant\'s reply limit could be read, so how long a human '
          + 'has is UNKNOWN from here — read tenants.max_reply_age_minutes. Assume little time.'
        : age === null
          ? `Age unreadable, so whether this is still inside the tenant's ${limitMinutes}-minute reply `
            + 'limit is unknown; a human reply now beats a late bot reply.'
          : age < limitMinutes
            ? `A human can still answer: about ${limitMinutes - age} min left of this tenant's ${limitMinutes}-minute reply limit.`
            : `Past this tenant's ${limitMinutes}-minute reply limit; a human reply now beats a late bot reply.`;
      const res = await raiseAlert(db, {
        tenantId,
        severity: 'critical',
        kind: 'webhook.delivery_exhausted',
        dedupKey: `delivery_exhausted:${eventId}`,
        // Passed rather than defaulted. Both happen to be the defaults today, and this
        // alert's whole character — one Telegram message, once, never resolving — would
        // change silently if either default moved.
        route: 'now',
        repeat: 'daily',
        body: `Inbound event ${eventId} was delivered to the worker ${attempts} time(s) and refused every time `
          + `(last: ${code}). QStash has no retries left, so nothing else will pick it up. `
          + `${age === null ? 'Age unreadable' : `${age} min old`}. ${outcome} `
          + 'The delivery is in webhook_events.raw_payload.',
      });
      if (res.outcome === 'failed') {
        console.error('[worker] delivery_exhausted_alert_failed', { eventId, detail: res.detail });
      }
    },

    flagQuality: async ({ tenantId, conversationId, code, detail }) => {
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
        flag: code,
        detail: { detail },
        at: now.toISOString(),
      });
      if (error) console.error('[worker] quality_flag_write_failed', { code, detail: error.message });
    },

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
