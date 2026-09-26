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
import { draftOnce, replyDedupKey } from '../outbound/claim.ts';
import { markCalled, release, type Reservation } from '../spend/reserve.ts';
import {
  alertCacheCold, alertModelAccount, alertModelRetired, alertModelSwapped, checkCacheHealth, checkServedModel,
  resolveModelHealth,
} from '../model/health.ts';
import { dayKey } from '../spend/periods.ts';
import { settle, type Usage } from '../spend/settle.ts';
import type { ReceptionDeps } from './handle.ts';

export type DepsInput = {
  db: SupabaseClient;
  /** The tenant's cache mode, so a tenant paying full rate on purpose never alarms. */
  cacheMode: 'off' | '5m' | '1h';
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
      //
      // It is not discarded either, which it was until 2026-09-14 — a `void answeredBy`
      // sat here and three columns the schema has carried since `0001` were written by
      // nothing. The caller records it against the INBOUND message, alongside the revision
      // and prompt hash that produced the answer, because that is the row a reader has when
      // they ask what answered this customer. See `traceAnswer`.
      const r = await draftOnce(db, {
        tenantId,
        kind: 'reply',
        dedupKey: replyDedupKey(input.inboundExternalId),
        body,
        channelId: input.channelId,
        conversationId,
      });
      return r.ok ? { ok: true, id: r.row.id } : { ok: false, detail: r.detail };
    },

    markCalled: () => markCalled(db, reservation.id, now),

    settle: async (usage: Usage, modelId: string) => {
      const r = await settle(db, {
        reservation, usage, modelId,
        // The tenant's mode decides the write multiplier, and picking the wrong one
        // halves or doubles the miss cost — most of the cost on a cold conversation.
        // This was the literal '1h' for every tenant until 2026-09-07: correct for Matrix
        // by coincidence, and 1.6x over for a 5m tenant, in the column D-004's margin is
        // checked against. It is the same value `checkCacheHealth` is already given.
        cacheTtl: input.cacheMode,
        conversationId,
        now,
      });
      return r.ok ? { ok: true } : { ok: false, detail: r.detail };
    },

    release: () => release(db, reservation, now),

    /**
     * §6.10.5's two bills-not-errors. Every branch is best-effort: an observability
     * failure must never refuse a reply the customer is owed.
     */
    observe: async ({ requestedModel, servedModel, terminalReason, terminalDetail }) => {
      // The tenant's calendar, off the reservation this reply already holds. Reading it
      // there rather than from a second source is what stops an alert about a day's spend
      // from naming a different day than the counter it is about.
      const period = dayKey(now, reservation.timezone);

      if (terminalReason === 'model_not_found') {
        await alertModelRetired(db, { modelId: requestedModel, detail: 'the API returned 404 for this model id' });
        return;   // A retired model makes every other signal meaningless.
      }
      if (terminalReason === 'auth' || terminalReason === 'billing') {
        // The account, not this request: every tenant is on the handoff line (2026-09-25).
        await alertModelAccount(db, { fault: terminalReason, modelId: requestedModel, detail: terminalDetail ?? '' });
        return;
      }

      // A call on this id answered, so a retired-model episode for it is over and the next
      // 404 must page again (D-128). Only on a clean answer — the narrowest reading of "a call
      // on that id succeeded". Best-effort like everything here: a failed resolve leaves the
      // episode open (the digest keeps listing it), which is the safe direction. Issued now
      // and awaited beside the cache read below, so it adds a statement per reply but no
      // serial round trip — this runs before the reply is drafted.
      const clearing = terminalReason === undefined
        ? resolveModelHealth(db, { modelId: requestedModel, now }).then((cleared) => {
          if (!cleared.ok) {
            console.warn('[reception] model_episode_unresolvable', { modelId: requestedModel, detail: cleared.detail });
          } else if (cleared.resolved > 0) {
            console.info('[reception] model_episode_resolved', { modelId: requestedModel, resolved: cleared.resolved });
          }
        }, (err: unknown) => {
          // In flight while the swap alert is awaited, so a rejection here must be handled
          // here: unhandled, Node would take the process down mid-reply. A thrown resolve is
          // the same outcome as a refused one — the episode stays open.
          console.warn('[reception] model_episode_unresolvable', {
            modelId: requestedModel, detail: err instanceof Error ? err.message : String(err),
          });
        })
        : Promise.resolve();

      const served = checkServedModel(requestedModel, servedModel);
      if (served.verdict === 'swapped') {
        await alertModelSwapped(db, { tenantId, requested: served.requested, served: served.served, dayKey: period });
      }

      const [cache] = await Promise.all([
        checkCacheHealth(db, { tenantId, surface: 'reception', cacheMode: input.cacheMode }),
        clearing,
      ]);
      if (cache.verdict === 'cold_run') {
        await alertCacheCold(db, { tenantId, surface: 'reception', dayKey: period, sample: cache.sample });
      } else if (cache.verdict === 'unavailable') {
        // Silence because the check could not run looks exactly like silence because the
        // cache is fine, so it is at least visible in the log.
        console.warn('[reception] cache_health_unavailable', { tenantId, detail: cache.detail });
      }
    },

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
