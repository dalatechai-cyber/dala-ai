/**
 * Idempotency and leasing over `webhook_events`.
 *
 * ## The dedup key is GLOBAL, not per-tenant
 *
 * The table declares `unique (provider, dedup_key)` with no tenant_id in it, and that is
 * deliberate: a per-tenant key would let ONE Meta event process twice under two different
 * tenants — two model calls, two bills, two replies. Global is the only correct scope, so
 * this module never adds tenant_id to the conflict target.
 *
 * ## A duplicate is not the same as "already queued"
 *
 * The unique violation only says a row exists. It says nothing about whether that row was
 * ever handed to QStash — and on 2026-09-06 the difference cost a real customer message:
 * the first delivery claimed the row, the enqueue was rejected, the route 500'd, and both
 * of Meta's retries hit this branch, skipped the enqueue and returned **200**. Meta then
 * stopped retrying, and the event sat in `failed` with nothing to pick it up.
 *
 * So the result now carries `state`, and only two values mean "never reached QStash":
 * `received` (claimed, outcome never recorded) and `failed` (the enqueue was refused).
 * `failed` is written in exactly one place — the webhook, after a failed enqueue — so it
 * is unambiguous.
 *
 * ## Insert-first, resolve-after
 *
 * The row is claimed BEFORE any work, so a redelivery that arrives while the first is
 * still in flight loses the race at the database rather than at a check-then-act in
 * application code. `routing='unrouted'` carries `tenant_id = null`, which the table's
 * `unrouted_has_no_tenant` constraint enforces — an unrouted event belongs to nobody, and
 * the database says so rather than trusting us to remember.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type ClaimResult =
  /** We own this event. Proceed. */
  | { outcome: 'claimed'; eventId: number }
  /**
   * The row already exists — a Meta redelivery. It carries the existing row's id and
   * state, because "already claimed" and "already queued" are different facts and the
   * caller cannot tell them apart without the second one.
   */
  | { outcome: 'duplicate'; eventId: number; state: string }
  /** The ledger is unreachable. The caller must 500 so Meta retries. */
  | { outcome: 'unavailable'; detail: string };

export type ClaimInput = {
  provider: string;
  /** Globally unique per event. Meta's message id where present. */
  dedupKey: string;
  routing: 'routed' | 'unrouted' | 'provisional';
  tenantId: string | null;
  channelId: string | null;
  entryId: string | null;
  rawPayload: unknown;
  leaseSeconds: number;
};

export async function claimWebhookEvent(
  db: SupabaseClient,
  input: ClaimInput,
): Promise<ClaimResult> {
  if (input.routing === 'unrouted' && input.tenantId !== null) {
    // The database would refuse this anyway (unrouted_has_no_tenant); failing here makes
    // the programming error obvious instead of surfacing as a constraint violation.
    throw new Error('unrouted events must carry tenant_id = null');
  }

  const leaseUntil = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();

  const { data, error } = await db
    .from('webhook_events')
    .insert({
      provider: input.provider,
      dedup_key: input.dedupKey,
      source: 'meta',
      routing: input.routing,
      tenant_id: input.tenantId,
      channel_id: input.channelId,
      entry_id: input.entryId,
      state: 'received',
      raw_payload: input.rawPayload,
      lease_until: leaseUntil,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation on (provider, dedup_key): a genuine redelivery, which is
    // expected and correct, not a fault.
    if (error.code === '23505') {
      // Read back what already exists. A duplicate is not self-evidently safe to skip:
      // the first attempt may have claimed the row and then failed to enqueue, in which
      // case this redelivery is the only remaining chance to queue the message.
      const existing = await db
        .from('webhook_events')
        .select('id, state')
        .eq('provider', input.provider)
        .eq('dedup_key', input.dedupKey)
        .maybeSingle();
      if (existing.error) {
        // We know it exists and cannot see its state. Refusing is the only safe answer:
        // skipping would risk stranding it, re-enqueueing would risk doubling it.
        return { outcome: 'unavailable', detail: `duplicate row unreadable: ${existing.error.message}` };
      }
      if (existing.data === null) {
        return { outcome: 'unavailable', detail: 'unique violation, but no row to read back' };
      }
      const row = existing.data as Record<string, unknown>;
      return { outcome: 'duplicate', eventId: Number(row['id']), state: String(row['state'] ?? '') };
    }
    return { outcome: 'unavailable', detail: error.message };
  }
  if (data === null) return { outcome: 'unavailable', detail: 'insert returned no row' };

  return { outcome: 'claimed', eventId: Number((data as Record<string, unknown>)['id']) };
}

/**
 * Did this event get claimed WITHOUT ever being handed to QStash?
 *
 * Only two states can mean that, and both are written before the queue is involved:
 *
 *  - `received` — the insert default. Claimed, enqueue outcome never recorded: either
 *    another request is still in flight, or the function died between the two writes.
 *  - `failed` — written in exactly one place, the webhook route, after QStash refused.
 *
 * Every other value is written by the worker, which only runs on a job that was queued.
 *
 * This lives here rather than in the route because a branch in a route is a branch no
 * test can reach — the pattern the worker routes already follow. It was extracted after a
 * mutation proved the point: reverting the route to skip every duplicate broke nothing.
 */
export function neverReachedQueue(state: string): boolean {
  return state === 'received' || state === 'failed';
}

/** Advance an event's state. Best-effort: never turn a bookkeeping failure into a 500. */
export async function markEventState(
  db: SupabaseClient,
  eventId: number,
  state: 'pending_enqueue' | 'processed' | 'shed' | 'failed' | 'blocked_no_token' | 'standby_not_primary',
): Promise<void> {
  await db.from('webhook_events').update({ state }).eq('id', eventId);
}
