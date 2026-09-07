/**
 * Bind the delivery decision to real modules.
 *
 * The mirror of `reception/deps.ts`: `deliverOutbound` declares what it needs and knows
 * nothing about where it comes from, so the flow stays testable without a database and
 * every module it uses is the one merged and tested on its own.
 *
 * The two writes that follow a Graph `190` are joined here rather than in `deliverOutbound`
 * because they are two tables — `tenant_secrets.status` and `tenant_channels` — and the
 * decision layer should not know how many statements "revoke this credential" takes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { MESSENGER_SEND_UNIT_COST } from '../../config/platform.ts';
import { haltChannelOutbound } from '../channel/halt.ts';
import { runCredentialBreaker } from '../channel/breaker.ts';
import { sendMessage } from '../meta/send.ts';
import { raiseAlert } from '../alerts/alert.ts';
import { loadTenantSecret, recordSecretError, recordSecretOk, revokeSecret, type SecretRef } from '../secrets/tenantSecret.ts';
import { markFailed, markIndeterminate, markSent } from './claim.ts';
import type { DeliverDeps } from './deliver.ts';

export type DeliverDepsInput = {
  db: SupabaseClient;
  tenantId: string;
  channelId: string;
  outboundId: string;
  attempts: number;
  /**
   * The job's clock, for things that legitimately describe the job — `recordSecretOk`'s
   * `last_ok_at`, which is about this attempt, not about a moment inside it.
   */
  now: Date;
  /**
   * Read at the moment of use, NOT once at job start. `sent_at` is the one field here that
   * names an instant rather than an attempt, and the two are far apart: measured on both
   * real sends, the job clock precedes the draft row's own `created_at` by 11.2s and 16.0s,
   * because the model call happens in between. So `sent_at` claimed the reply was sent
   * before its text existed.
   *
   * Injected rather than called inline so a test can still pin it. Defaults to the real
   * clock, which is what the route wants and what a caller forgetting it should get.
   */
  clock?: () => Date;
};

export function buildDeliverDeps(input: DeliverDepsInput): DeliverDeps {
  const { db, tenantId, channelId, outboundId, now } = input;
  const clock = input.clock ?? (() => new Date());
  const ref: SecretRef = { tenantId, channelId, kind: 'page_token' };
  const scope = { id: outboundId, tenantId };

  return {
    loadSecret: () => loadTenantSecret(db, ref),

    // The real `fetch`, and the token passed in by the caller rather than fetched here.
    send: (i) => sendMessage(i),

    // `clock()`, not `now`: this runs AFTER the Graph call returned, and that is the
    // instant `sent_at` claims to record.
    markSent: (providerMessageId) =>
      markSent(db, { ...scope, providerMessageId, unitCost: MESSENGER_SEND_UNIT_COST, now: clock() }),

    markFailed: (reason) => markFailed(db, { ...scope, attempts: input.attempts, reason }),

    markIndeterminate: (reason) => markIndeterminate(db, { ...scope, reason }),

    recordSecretOk: () => recordSecretOk(db, ref, now),

    recordSecretError: (code) => recordSecretError(db, ref, code),

    /**
     * One transition, two tables. `haltChannelOutbound` must write `delivery_mode = 'off'`
     * alongside `token_status = 'revoked'` or the CHECK rejects it on a live channel —
     * see the note there. Both are attempted even if the first fails, because a revoked
     * secret with a still-live channel is the worse of the two half-states: the platform
     * would keep claiming outbound messages it cannot send.
     */
    revokeCredential: async (code) => {
      const secret = await revokeSecret(db, ref, code);
      const channel = await haltChannelOutbound(db, { tenantId, channelId });
      if (secret.ok && channel.ok) return { ok: true };
      return {
        ok: false,
        detail: [secret.ok ? null : secret.detail, channel.ok ? null : channel.detail]
          .filter((d): d is string => d != null)
          .join('; '),
      };
    },

    alert: (a) => raiseAlert(db, { tenantId, severity: a.severity, kind: a.kind, dedupKey: a.dedupKey, body: a.body }),

    /**
     * Best-effort by construction. The customer's message has already failed to send and
     * the caller already knows why; a breaker that cannot read `outbound_messages` must
     * not turn that into a different outcome. It logs and returns.
     */
    onCredentialFailure: async (code) => {
      const decision = await runCredentialBreaker(
        db,
        {
          alert: (a) => raiseAlert(db, { tenantId, severity: a.severity, kind: a.kind, dedupKey: a.dedupKey, body: a.body }),
          log: (level, event, fields) => console[level](`[breaker] ${event}`, fields ?? {}),
        },
        { tenantId, channelId, code, now },
      );
      if (decision.action === 'unreadable') {
        console.error('[breaker] unreadable', { channelId, detail: decision.detail });
      }
    },
  };
}
