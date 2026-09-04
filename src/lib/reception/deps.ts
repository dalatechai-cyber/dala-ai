/**
 * Bind the reception flow's effects to real modules.
 *
 * `handleReception` declares what it needs and nothing about where it comes from. This is
 * the one place those are joined, so the flow stays a pure decision and every module it
 * uses is the same one merged and tested on its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env.ts';
import { callReception } from '../model/reception.ts';
import { draftOnce } from '../outbound/claim.ts';
import { markCalled, release, type Reservation } from '../spend/reserve.ts';
import { settle, type Usage } from '../spend/settle.ts';
import type { ReceptionDeps } from './handle.ts';

export type DepsInput = {
  db: SupabaseClient;
  tenantId: string;
  channelId: string;
  conversationId: string;
  /** Meta's message id. The reply's idempotency key is derived from it. */
  inboundExternalId: string;
  reservation: Reservation;
  now: Date;
};

export function buildDeps(input: DepsInput): ReceptionDeps {
  const { db, tenantId, conversationId, reservation, now } = input;

  return {
    // The API key is read HERE, per request, never at module scope — CLAUDE.md rule 7,
    // because warm lambdas are reused across tenants.
    callModel: (req) => callReception(req, required('ANTHROPIC_API_KEY')),

    draft: async ({ body, answeredBy }) => {
      // The dedup key is the INBOUND message id, so a redelivery of the same customer
      // message finds the reply already written instead of generating a second one.
      // `answeredBy` is deliberately not in the key: whether the model or a canned line
      // answered must not create a second reply to one question.
      const r = await draftOnce(db, {
        tenantId,
        kind: 'reply',
        dedupKey: `in:${input.inboundExternalId}`,
        body,
        channelId: input.channelId,
        conversationId,
      });
      void answeredBy;
      return r.ok ? { ok: true, id: r.row.id } : { ok: false, detail: r.detail };
    },

    markCalled: () => markCalled(db, reservation.id, now),

    settle: async (usage: Usage, modelId: string) => {
      const r = await settle(db, {
        reservation, usage, modelId,
        // The tenant's mode decides the write multiplier, and picking the wrong one
        // halves or doubles the miss cost — most of the cost on a cold conversation.
        cacheTtl: '1h',
        conversationId,
        now,
      });
      return r.ok ? { ok: true } : { ok: false, detail: r.detail };
    },

    release: () => release(db, reservation.id),

    flag: async ({ code, detail, attempted }) => {
      // Best-effort: a flag that cannot be written must not refuse a customer's reply.
      // It is evidence for the Quality layer, not a control.
      const { error } = await db.from('quality_flags').insert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        flag: code,
        detail: attempted === undefined ? { detail } : { detail, attempted },
        at: now.toISOString(),
      });
      if (error) console.error('[reception] quality_flag_write_failed', { code, detail: error.message });
    },
  };
}
