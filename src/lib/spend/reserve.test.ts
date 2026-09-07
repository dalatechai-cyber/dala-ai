import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayTargets, effectiveDailyCeiling, release, reserve } from './reserve.ts';
import { CAPS } from '../../config/platform.ts';
import { toDb } from '../money.ts';

const TENANT = 't-1';
const NOW = new Date('2026-09-06T04:00:00Z');   // 12:00 in Ulaanbaatar, so the day key is the 6th
const UB = 'Asia/Ulaanbaatar';

type Call = { fn: string; args: Record<string, unknown> };

function stub(over: { budgetRow?: unknown; budgetError?: unknown; rpcError?: unknown; holdRow?: unknown } = {}) {
  const calls: Call[] = [];
  const writes: { table: string; op: string }[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
    for (const m of ['insert', 'update', 'upsert'] as const) {
      chain[m] = () => { writes.push({ table, op: m }); return chain; };
    }
    chain['maybeSingle'] = async () => {
      if (table === 'tenant_budgets') return { data: over.budgetRow ?? null, error: over.budgetError ?? null };
      if (table === 'spend_reservations') return { data: over.holdRow ?? { id: 'res-1' }, error: null };
      return { data: null, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: null, error: null });
    return chain;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { data: over.rpcError === undefined, error: over.rpcError ?? null };
  };
  return { db: { from, rpc } as never, calls, writes };
}

const input = { tenantId: TENANT, surface: 'reception' as const, estimate: 12_000_000n, now: NOW, timezone: UB };

// ---- the ceiling read ------------------------------------------------------

test('a tenant with NO budget row gets the compiled cap, not a refusal', async () => {
  // Measured on the live project 2026-09-06 and worth pinning: an empty `tenant_budgets`
  // was blamed for a `guard_unavailable` it had nothing to do with.
  const { db } = stub();
  const r = await effectiveDailyCeiling(db, TENANT, 'reception');
  assert.deepEqual(r, { ok: true, ceiling: CAPS.perTenantPerSurfacePerDay });
});

test('an unreadable tenant_budgets refuses — it never falls back to the compiled cap', async () => {
  const { db } = stub({ budgetError: { message: 'down' } });
  const r = await effectiveDailyCeiling(db, TENANT, 'reception');
  assert.equal(r.ok, false);
});

// ---- the targets -----------------------------------------------------------

test('DONE-TEST: one definition names every counter a reservation touches', async () => {
  // `reserve`, `release` and `settle` must address the SAME set. Two lists spelled
  // separately is how a refund misses a counter the reservation charged.
  const t = dayTargets(TENANT, NOW, UB);
  assert.deepEqual(t, [
    { scope: 'tenant', scope_key: TENANT, period_kind: 'day', period_key: '2026-09-06' },
    { scope: 'platform', scope_key: 'platform', period_kind: 'day', period_key: '2026-09-06' },
  ]);
});

test('DONE-TEST: THE TENANT\'S COUNTER FOLLOWS THE TENANT\'S CALENDAR', () => {
  // 2026-09-06T20:00Z is 04:00 on the 7th in Ulaanbaatar and 16:00 on the 6th in New
  // York. The tenant's row must carry the tenant's day, or the ceiling they were sold as
  // daily is not the day they live in.
  const late = new Date('2026-09-06T20:00:00Z');
  assert.equal(dayTargets(TENANT, late, UB)[0]?.period_key, '2026-09-07');
  assert.equal(dayTargets(TENANT, late, 'America/New_York')[0]?.period_key, '2026-09-06');
});

test('DONE-TEST: THE PLATFORM\'S COUNTER DOES NOT — A SHARED CAP CANNOT HAVE A PER-TENANT DAY', () => {
  // The failure this guards is silent and it fails OPEN, which is the direction this
  // codebase never fails. Key the platform row by whichever tenant happened to spend and
  // two tenants in different zones open two platform rows for one platform day: the
  // $10/day cap that stands between a platform-wide bug and the Anthropic invoice becomes
  // $10 per zone, and nothing anywhere reports a number that looks wrong.
  const late = new Date('2026-09-06T20:00:00Z');
  const fromUb = dayTargets(TENANT, late, UB);
  const fromNy = dayTargets('t-2', late, 'America/New_York');

  assert.notEqual(fromUb[0]?.period_key, fromNy[0]?.period_key, 'the two tenants are on different days');
  assert.equal(fromUb[1]?.period_key, fromNy[1]?.period_key,
    'and they still charge ONE platform counter');
  assert.equal(fromUb[1]?.period_key, '2026-09-07', 'the platform is on PLATFORM_TIMEZONE');
});

test('DONE-TEST: release addresses the day the hold was TAKEN from', async () => {
  // The reservation carries its own zone so a refund cannot land on a different row than
  // the charge. A `release` that recomputed the calendar from a caller's idea of it would
  // credit yesterday and leave today's counter permanently short — invisible until a
  // ceiling refused a reply nobody had spent.
  const { db, calls } = stub();
  await release(db, { id: 'res-9', tenantId: TENANT, surface: 'reception', estimate: 12_000_000n,
    timezone: 'America/New_York' }, new Date('2026-09-06T20:00:00Z'));
  const call = calls.find((c) => c.fn === 'release_spend');
  const targets = call?.args['p_targets'] as { scope: string; period_key: string }[];
  assert.equal(targets[0]?.period_key, '2026-09-06', 'the tenant\'s own day');
  assert.equal(targets[1]?.period_key, '2026-09-07', 'and the platform\'s, unchanged by it');
});

// ---- reserve ---------------------------------------------------------------

test('a reservation asks for every counter in ONE call', async () => {
  // It used to be a loop, and the loop is what leaked: the tenant counter moved, the
  // platform one refused, and nothing gave the first one back.
  const { db, calls } = stub();
  const r = await reserve(db, input);
  assert.equal(r.outcome, 'reserved');
  const reserveCalls = calls.filter((c) => c.fn === 'reserve_spend_all');
  assert.equal(reserveCalls.length, 1, JSON.stringify(calls.map((c) => c.fn)));
  assert.deepEqual(reserveCalls[0]?.args['p_targets'], dayTargets(TENANT, NOW, UB));
});

test('DONE-TEST: a 23514 is the ceiling refusing — 429, and the budget is given back', async () => {
  const { db, calls } = stub({ rpcError: { code: '23514', message: 'ceiling_reached' } });
  const r = await reserve(db, input);
  assert.deepEqual(r, { outcome: 'refused', reason: 'ceiling_reached' });
  assert.ok(calls.some((c) => c.fn === 'release_spend'), 'the held reservation is released');
});

test('DONE-TEST: any OTHER error is 503, never a degradation', async () => {
  // Reading an outage as "the ceiling refused" answers the customer with the degradation
  // ladder and never retries. A 503 costs a redelivery.
  const { db } = stub({ rpcError: { code: '40001', message: 'deadlock detected' } });
  const r = await reserve(db, input);
  assert.equal(r.outcome, 'unavailable');
  assert.match(r.outcome === 'unavailable' ? r.detail : '', /deadlock detected/);
});

test('a surface budgeted at zero refuses before any counter is touched', async () => {
  const { db, calls } = stub({ budgetRow: { daily_ceiling_nanousd: '1000', surface_fractions: { reception: 0 } } });
  const r = await reserve(db, input);
  assert.deepEqual(r, { outcome: 'refused', reason: 'ceiling_reached' });
  assert.equal(calls.length, 0, 'and it asks the database for nothing');
});

// ---- release ---------------------------------------------------------------

test('DONE-TEST: release GIVES THE BUDGET BACK, with the same targets and amount', async () => {
  // Until 2026-09-06 this set a state and touched no counter, so every 503 after a
  // successful reserve consumed the estimate permanently — once per QStash retry.
  const { db, calls, writes } = stub();
  await release(db, { id: 'res-1', tenantId: TENANT, surface: 'reception', estimate: 12_000_000n, timezone: UB }, NOW);

  const call = calls.find((c) => c.fn === 'release_spend');
  assert.ok(call !== undefined, JSON.stringify(calls.map((c) => c.fn)));
  assert.equal(call?.args['p_reservation_id'], 'res-1');
  assert.equal(call?.args['p_amount_nanousd'], toDb(12_000_000n), 'the estimate, in the ledger\'s own representation');
  assert.deepEqual(call?.args['p_targets'], dayTargets(TENANT, NOW, UB));
  assert.equal(writes.some((w) => w.table === 'spend_reservations'), false,
    'and the state change happens inside the function, where the refund can be conditional on it');
});
