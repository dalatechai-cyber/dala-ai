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
  now: Date;
};

export function buildDeliverDeps(input: DeliverDepsInput): DeliverDeps {
  const { db, tenantId, channelId, outboundId, now } = input;
  const ref: SecretRef = { tenantId, channelId, kind: 'page_token' };
  const scope = { id: outboundId, tenantId };

  return {
    loadSecret: () => loadTenantSecret(db, ref),

    // The real `fetch`, and the token passed in by the caller rather than fetched here.
    send: (i) => sendMessage(i),

    markSent: (providerMessageId) =>
      markSent(db, { ...scope, providerMessageId, unitCost: MESSENGER_SEND_UNIT_COST, now }),

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
  };
}
