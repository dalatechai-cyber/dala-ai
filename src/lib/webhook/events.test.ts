import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimWebhookEvent, neverReachedQueue } from './events.ts';

/**
 * `results` is consumed in order: the first is the INSERT's answer, the second (when the
 * insert conflicts) is the read-back of the existing row. A single-element array repeats,
 * which keeps every pre-existing call site unchanged.
 */
function stubDb(
  results: { data: unknown; error: unknown } | { data: unknown; error: unknown }[],
  capture?: (row: unknown) => void,
) {
  const queue = Array.isArray(results) ? [...results] : [results];
  const chain: Record<string, unknown> = {};
  chain['from'] = () => chain;
  chain['insert'] = (row: unknown) => { capture?.(row); return chain; };
  chain['select'] = () => chain;
  chain['eq'] = () => chain;
  chain['maybeSingle'] = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  return chain as never;
}

const base = {
  provider: 'facebook_page', dedupKey: 'k1', source: 'meta' as const, routing: 'routed' as const,
  tenantId: 't-1', channelId: 'c-1', entryId: 'e-1', rawPayload: {}, leaseSeconds: 60,
};

test('a first delivery is claimed', async () => {
  const res = await claimWebhookEvent(stubDb({ data: { id: 42 }, error: null }), base);
  assert.deepEqual(res, { outcome: 'claimed', eventId: 42 });
});

test('a redelivery loses the race at the database and is a duplicate, not an error', async () => {
  // 23505 = unique_violation on (provider, dedup_key). Expected and correct.
  const res = await claimWebhookEvent(
    stubDb([{ data: null, error: { code: '23505' } }, { data: { id: 7, state: 'pending_enqueue' }, error: null }]),
    base,
  );
  assert.equal(res.outcome, 'duplicate');
});

test('a duplicate reports the existing row: which one, and what state', async () => {
  // "Already claimed" and "already queued" are different facts, and the caller cannot act
  // correctly on the first without the second. On 2026-09-06 that gap lost a real message.
  const res = await claimWebhookEvent(
    stubDb([{ data: null, error: { code: '23505' } }, { data: { id: 7, state: 'failed' }, error: null }]),
    base,
  );
  assert.deepEqual(res, { outcome: 'duplicate', eventId: 7, state: 'failed' });
});

test('a duplicate whose existing row cannot be read is UNAVAILABLE, not a skip', async () => {
  // We know it exists and cannot see its state. Skipping risks stranding the message;
  // re-enqueueing risks doubling it. 500 and let Meta retry is the only honest answer.
  const res = await claimWebhookEvent(
    stubDb([{ data: null, error: { code: '23505' } }, { data: null, error: { code: '08006', message: 'gone' } }]),
    base,
  );
  assert.equal(res.outcome, 'unavailable');
});

test('a duplicate with no row to read back is unavailable, never a silent duplicate', async () => {
  const res = await claimWebhookEvent(
    stubDb([{ data: null, error: { code: '23505' } }, { data: null, error: null }]),
    base,
  );
  assert.equal(res.outcome, 'unavailable');
});

test('an unreachable ledger is unavailable — the caller must 500, never 200', async () => {
  const res = await claimWebhookEvent(
    stubDb({ data: null, error: { code: '08006', message: 'connection failure' } }), base,
  );
  assert.equal(res.outcome, 'unavailable');
});

test('the dedup key carries NO tenant_id — it is global across all tenants', async () => {
  // A per-tenant key would let ONE Meta event process twice under two tenants: two model
  // calls, two bills, two replies. The table declares unique (provider, dedup_key).
  let row: Record<string, unknown> | undefined;
  await claimWebhookEvent(stubDb({ data: { id: 1 }, error: null }, (r) => { row = r as never; }), base);
  assert.equal(row?.['dedup_key'], 'k1');
  assert.ok(!String(row?.['dedup_key']).includes('t-1'), 'dedup_key must not be scoped by tenant');
});

test('an unrouted event may not carry a tenant — the constraint is enforced here too', async () => {
  await assert.rejects(() =>
    claimWebhookEvent(stubDb({ data: { id: 1 }, error: null }), {
      ...base, routing: 'unrouted', tenantId: 't-1',
    }));
});

// ---------------------------------------------------------------------------
// Which duplicates must be re-enqueued
// ---------------------------------------------------------------------------

test('only received and failed mean the event never reached the queue', () => {
  assert.equal(neverReachedQueue('received'), true);
  assert.equal(neverReachedQueue('failed'), true);
});

test('DONE-TEST: every state the WORKER writes means the job was already queued', () => {
  // Enumerated from markEventState's own union and the table's CHECK. If a new state is
  // added that the webhook writes before enqueueing, this test is where it must be
  // considered — the alternative is a message silently skipped on redelivery.
  for (const state of [
    'pending_enqueue', 'processed', 'shed', 'blocked_no_token',
    'standby_not_primary', 'persist_deferred', 'routed_provisionally',
  ]) {
    assert.equal(neverReachedQueue(state), false, state);
  }
});

test('an unknown state is NOT re-enqueued — a value this code does not understand is not one to re-drive', () => {
  assert.equal(neverReachedQueue(''), false);
  assert.equal(neverReachedQueue('some_future_state'), false);
});
