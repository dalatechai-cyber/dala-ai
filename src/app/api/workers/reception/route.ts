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
import { buildDeliverDeps } from '@/lib/outbound/deliverDeps';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '@/config/platform';
import { SECTION_LABELS } from '@/lib/prompt/tenant';
import { raiseAlert } from '@/lib/alerts/alert';
import { runReceptionJob, type WorkerEffects } from '@/lib/worker/reception';

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
