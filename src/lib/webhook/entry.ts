/**
 * One Meta entry, decided. The webhook route is the adapter; this is the decision.
 *
 * ## Why this is not in the route any more
 *
 * The route carried it, and the repository's own rule says why that was wrong: *a branch
 * in a route is a branch no test can reach.* On 2026-09-06 the branch that lived here read
 *
 * ```ts
 * if (claim.outcome === 'duplicate') continue;   // before the enqueue
 * ```
 *
 * and it answered Meta **200** for a message that had never been handed to QStash. Meta
 * stopped retrying; the event sat in `failed` for ever. The fix (D-028) was one line, and
 * the reason it could ship broken in the first place is that nothing could drive this code
 * without a Next.js request, a signature, and an environment.
 *
 * Now it is a function taking three effects, so `replay.test.ts` can call it twice with
 * the same entry and assert what a redelivery is supposed to do.
 *
 * ## Nothing here decides an HTTP status
 *
 * The outcomes are facts about the entry; the route maps them to 200 or 500. That split is
 * deliberate — "we could not read the registry" and "this Page is not ours" are different
 * facts that happen to share a transport, and the mapping belongs where the transport is.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EnqueueResult } from '../queue/qstash.ts';
import { resolveTenantForEntry } from '../tenant/resolve.ts';
import { claimWebhookEvent, markEventState, neverReachedQueue, type EventSource } from './events.ts';
import { dedupKeyForEntry } from './identity.ts';

export type MetaEntry = { id?: unknown; messaging?: unknown[] };

export type EntryDeps = {
  db: SupabaseClient;
  enqueue: (job: {
    provider: string; dedupKey: string; eventId: number; tenantId: string; channelId: string;
  }) => Promise<EnqueueResult>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

export type EntryOutcome =
  /** No `entry.id` to route on. Reported rather than dropped — see below. */
  | { outcome: 'no_entry_id'; idType: string }
  /** TRANSIENT: we do not know whether we serve this Page. The caller must 500. */
  | { outcome: 'registry_unavailable'; detail: string }
  /** PERMANENT: a Page we do not serve. Persisted tenant-less so it is diagnosable. */
  | { outcome: 'unrouted'; externalId: string }
  /** The app-vs-identity cross-check refused. Nothing is written. */
  | { outcome: 'app_mismatch'; expected: string; matched: string }
  /** The ledger is unreachable. The caller must 500 so Meta retries. */
  | { outcome: 'ledger_unavailable'; detail: string }
  /** A redelivery of an event that DID reach the queue. Correctly skipped. */
  | { outcome: 'already_queued'; eventId: number; state: string }
  /** The enqueue was refused. The row says `failed`; the caller must 500. */
  | { outcome: 'enqueue_failed'; eventId: number; detail: string }
  /** Handed to the queue. `redelivery` is true when a previous attempt never got here. */
  | { outcome: 'queued'; eventId: number; redelivery: boolean };

export type EntryInput = {
  provider: string;
  entry: MetaEntry;
  /** Index within this POST — part of the dedup key, so two entries never collide. */
  index: number;
  matchedAppSlug: string;
  /**
   * How this delivery reached us: straight from Meta, or forwarded by the incumbent
   * during a mirror. Descriptive only — it is NOT in the dedup key, because a mirrored
   * copy of an event Meta also delivered directly is the same event and must dedup
   * against it. Defaults to `meta`.
   */
  source?: EventSource;
  leaseSeconds?: number;
};

export async function handleMetaEntry(deps: EntryDeps, input: EntryInput): Promise<EntryOutcome> {
  const { db } = deps;
  const entry = input.entry;

  // `entry.id` is the ground truth for routing, and a non-string one used to `continue`
  // in silence. On 2026-09-06 a signed delivery produced no row and no log line, and
  // there was nothing left to say which of the two silent paths it took. The type is in
  // the outcome so the next one is answerable; the VALUE is not logged by the caller,
  // because an id we did not recognise is still somebody's Page.
  const externalId = typeof entry.id === 'string' ? entry.id : null;
  if (externalId === null) return { outcome: 'no_entry_id', idType: typeof entry.id };

  const resolution = await resolveTenantForEntry(db, input.provider, externalId);
  if (resolution.outcome === 'registry_unavailable') {
    return { outcome: 'registry_unavailable', detail: resolution.detail };
  }

  // Meta's own ids for what the entry carries, not the length of the envelope that
  // carried it. `identity.ts` has the measurement that condemned the old key.
  const dedupKey = dedupKeyForEntry({
    externalId, index: input.index, entry, matchedAppSlug: input.matchedAppSlug,
  });
  const leaseSeconds = input.leaseSeconds ?? 60;
  const source: EventSource = input.source ?? 'meta';

  if (resolution.outcome === 'unknown_channel') {
    await claimWebhookEvent(db, {
      provider: input.provider, dedupKey, source, routing: 'unrouted', tenantId: null, channelId: null,
      entryId: externalId, rawPayload: entry, leaseSeconds,
    });
    return { outcome: 'unrouted', externalId };
  }

  const { tenant } = resolution;

  // The app-vs-identity cross-check. During cutover a Page is legitimately subscribed to
  // two apps; without this, a leaked second app secret authenticates events for a Page we
  // believe is elsewhere and nothing notices. It costs one string comparison.
  if (tenant.appSlug !== null && tenant.appSlug !== input.matchedAppSlug) {
    return { outcome: 'app_mismatch', expected: tenant.appSlug, matched: input.matchedAppSlug };
  }

  const claim = await claimWebhookEvent(db, {
    provider: input.provider, dedupKey, source, routing: 'routed', tenantId: tenant.tenantId,
    channelId: tenant.channelId, entryId: externalId, rawPayload: entry, leaseSeconds,
  });
  if (claim.outcome === 'unavailable') return { outcome: 'ledger_unavailable', detail: claim.detail };

  // A redelivery is only safe to skip if the FIRST attempt actually reached QStash. It is
  // not enough that a row exists (D-028).
  const redelivery = claim.outcome === 'duplicate';
  if (redelivery && !neverReachedQueue(claim.state)) {
    return { outcome: 'already_queued', eventId: claim.eventId, state: claim.state };
  }

  const enqueued = await deps.enqueue({
    provider: input.provider, dedupKey, eventId: claim.eventId,
    tenantId: tenant.tenantId, channelId: tenant.channelId,
  });
  await markEventState(db, claim.eventId, enqueued.ok ? 'pending_enqueue' : 'failed');
  if (!enqueued.ok) return { outcome: 'enqueue_failed', eventId: claim.eventId, detail: enqueued.detail };

  return { outcome: 'queued', eventId: claim.eventId, redelivery };
}
