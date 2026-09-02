import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimWebhookEvent } from './events.ts';

function stubDb(result: { data: unknown; error: unknown }, capture?: (row: unknown) => void) {
  const chain: Record<string, unknown> = {};
  chain['from'] = () => chain;
  chain['insert'] = (row: unknown) => { capture?.(row); return chain; };
  chain['select'] = () => chain;
  chain['maybeSingle'] = async () => result;
  return chain as never;
}

const base = {
  provider: 'facebook_page', dedupKey: 'k1', routing: 'routed' as const,
  tenantId: 't-1', channelId: 'c-1', entryId: 'e-1', rawPayload: {}, leaseSeconds: 60,
};

test('a first delivery is claimed', async () => {
  const res = await claimWebhookEvent(stubDb({ data: { id: 42 }, error: null }), base);
  assert.deepEqual(res, { outcome: 'claimed', eventId: 42 });
});

test('a redelivery loses the race at the database and is a duplicate, not an error', async () => {
  // 23505 = unique_violation on (provider, dedup_key). Expected and correct.
  const res = await claimWebhookEvent(stubDb({ data: null, error: { code: '23505' } }), base);
  assert.equal(res.outcome, 'duplicate');
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
