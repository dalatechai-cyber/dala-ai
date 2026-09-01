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
  /** Someone already has it — a Meta redelivery. Do nothing and 200. */
  | { outcome: 'duplicate' }
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
    if (error.code === '23505') return { outcome: 'duplicate' };
    return { outcome: 'unavailable', detail: error.message };
  }
  if (data === null) return { outcome: 'unavailable', detail: 'insert returned no row' };

  return { outcome: 'claimed', eventId: Number((data as Record<string, unknown>)['id']) };
}

/** Advance an event's state. Best-effort: never turn a bookkeeping failure into a 500. */
export async function markEventState(
  db: SupabaseClient,
  eventId: number,
  state: 'pending_enqueue' | 'processed' | 'shed' | 'failed' | 'blocked_no_token',
): Promise<void> {
  await db.from('webhook_events').update({ state }).eq('id', eventId);
}
