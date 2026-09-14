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

/**
 * How a delivery reached us. `webhook_events.source` has carried this CHECK since `0001`
 * and nothing had ever written anything but the default, so every row said `meta` whether
 * it was one or not — the same shape as `expires_at`, `duration_minutes` and the rest of
 * the columns this repository has had to go back for. During a mirror the incumbent
 * forwards a copy of each delivery, and after the fact there was no way to tell a
 * forwarded event from one Meta sent here directly.
 */
export type EventSource = 'meta' | 'mirror';

export type ClaimInput = {
  provider: string;
  /** Globally unique per event: `identity.ts` derives it from Meta's own ids. */
  dedupKey: string;
  /** Defaults to `meta` at the caller, so a forgotten value is the conservative one. */
  source: EventSource;
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
      source: input.source,
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
export const UNQUEUED_STATES = ['received', 'failed'] as const;

export function neverReachedQueue(state: string): boolean {
  return (UNQUEUED_STATES as readonly string[]).includes(state);
}

/**
 * Claimed, published to QStash — and still not finished.
 *
 * Separate from `UNQUEUED_STATES` on purpose, and the separation is the whole safety
 * argument. `neverReachedQueue` gates whether a META redelivery re-publishes, and a
 * redelivery arriving while a QStash job is still in flight is the ordinary case: adding
 * `pending_enqueue` there would re-publish on every Meta retry of a healthy event.
 *
 * What this list is for is the OTHER reader — the stranded sweep, which waits out QStash's
 * own retry horizon first. Until it existed, a row QStash accepted and never delivered was
 * swept by nothing and alerted by nothing: every completed worker run leaves a terminal
 * state, so a row still reading `pending_enqueue` an hour later has not been processed and
 * nothing was ever going to notice (D-040).
 *
 * `persist_deferred` and `routed_provisionally` belong here the day anything writes them.
 * Neither is written today, which is why neither is listed — a state in this array that no
 * code produces is a sweep arm no test can reach.
 */
export const QUEUED_STATES = ['pending_enqueue'] as const;

/**
 * Advance an event's state.
 *
 * Never throws — a bookkeeping failure must not turn a delivered reply into a 500 — but it
 * does REPORT, because one caller cares: the stranded sweep marks `expired_unqueued` after
 * telling the founder, and an unreported failure there would leave the row in a state
 * nobody was told about while the sweep believed it was handled.
 */
export async function markEventState(
  db: SupabaseClient,
  eventId: number,
  state: 'pending_enqueue' | 'processed' | 'shed' | 'failed' | 'blocked_no_token'
       | 'standby_not_primary' | 'expired_unqueued',
  /**
   * When this event produced a reply. Omit when it did not — an echo, a read receipt, a
   * channel that cannot generate — because the two are different facts.
   *
   * `replied_at` was READ and never written until 2026-09-14. `sweepStrandedEvents`
   * filters `.is('replied_at', null)`, which looked like a safety check and could not
   * exclude anything, because every row in the table satisfied it. It was harmless only
   * because the `state` filter beside it carried the whole load — and it would have become
   * load-bearing the moment somebody trusted it while widening that list. Written now, so
   * the filter means what it says.
   *
   * A DRAFT counts. In `shadow` the reply is generated and deliberately withheld, and the
   * question this column answers is "did this delivery produce an answer", not "did Meta
   * accept it" — `outbound_messages.sent_at` is the second question and already has a
   * column of its own.
   */
  repliedAt?: Date,
): Promise<{ ok: boolean; detail: string | null }> {
  // TWO LITERAL PAYLOADS, not one with a conditional spread.
  //
  // The spread version worked and cost something specific: `scripts/verify/postgrest.ts`
  // parses every write payload in `src/` and asserts each column exists on the live profile,
  // and a spread is not statically resolvable — so the site reported as UNRESOLVED and this
  // write's columns stopped being checked by CI. The count in that summary line went from
  // one to two, which is the number D-057 says to read as a warning rather than a total.
  //
  // Spelling both shapes out keeps the check able to see them. It also says plainly that
  // omitting `replied_at` is not the same as writing null: the sweeper marks
  // `expired_unqueued` later, and a null in that payload would erase the fact that an
  // earlier attempt did answer.
  const { error } = repliedAt === undefined
    ? await db.from('webhook_events').update({ state }).eq('id', eventId)
    : await db.from('webhook_events')
        .update({ state, replied_at: repliedAt.toISOString() })
        .eq('id', eventId);
  return error ? { ok: false, detail: error.message } : { ok: true, detail: null };
}
