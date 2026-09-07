import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './settle.ts';
import type { Reservation } from './reserve.ts';

const UB = 'Asia/Ulaanbaatar';
const RESERVATION: Reservation = {
  id: 'res-1', tenantId: 't-1', surface: 'reception', estimate: 12_000_000n, timezone: UB,
};
const USAGE = { input_tokens: 1000, output_tokens: 200 };

const PRICE_ROW = {
  input_nanousd_per_token: '2000',
  output_nanousd_per_token: '10000',
  cache_read_nanousd_per_token: '200',
  cache_write_5m_nanousd_per_token: '2500',
  cache_write_1h_nanousd_per_token: '4000',
};

/**
 * Records every filter each table was asked for, because the thing under test here is a
 * QUERY PARAMETER — the date the FX lookup asks for. A stub that only answers rows would
 * pass under either convention.
 */
function stub(over: { fxRow?: unknown } = {}) {
  const filters: { table: string; op: string; col: string; val: unknown }[] = [];
  const rows: Record<string, unknown>[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    chain['order'] = () => chain;
    chain['limit'] = () => chain;
    for (const op of ['eq', 'lte'] as const) {
      chain[op] = (col: string, val: unknown) => (filters.push({ table, op, col, val }), chain);
    }
    chain['insert'] = (row: Record<string, unknown>) => {
      rows.push({ ...row, __table: table });
      return chain;
    };
    chain['update'] = () => chain;
    chain['maybeSingle'] = async () => {
      if (table === 'model_prices') return { data: PRICE_ROW, error: null };
      if (table === 'fx_rates') {
        return { data: over.fxRow === undefined ? { mnt_per_unit: '3500.0000' } : over.fxRow, error: null };
      }
      return { data: null, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: null, error: null });
    return chain;
  };
  const db = { from, rpc: async () => ({ data: null, error: null }) } as never;
  return { db, filters, rows };
}

const run = (db: never, now: Date, over: { cacheTtl?: 'off' | '5m' | '1h'; usage?: typeof USAGE } = {}): Promise<unknown> =>
  settle(db, {
    reservation: RESERVATION, usage: over.usage ?? USAGE, modelId: 'claude-sonnet-5',
    cacheTtl: over.cacheTtl ?? '1h', now,
  });

test('DONE-TEST: THE FX RATE IS ASKED FOR BY THE PLATFORM\'S DATE, NOT UTC\'S', async () => {
  // `fx_rates.effective_from` is a bare `date` and the rate is a Mongolian one, so its day
  // is a day in Ulaanbaatar. 2026-09-06T18:57Z — the instant of a real settle on this
  // project — is already the 7th here. Asked for by the UTC date, a rate published for the
  // 7th would not be picked up until 08:00 local: eight hours of ledger rows snapshotting
  // yesterday's ₮ figure, with nothing in the data to reveal it.
  const { db, filters } = stub();
  await run(db, new Date('2026-09-06T18:57:16Z'));

  const fx = filters.find((f) => f.table === 'fx_rates' && f.op === 'lte');
  assert.equal(fx?.col, 'effective_from');
  assert.equal(fx?.val, '2026-09-07');
  assert.notEqual(fx?.val, '2026-09-06', 'the UTC date is a different day here');
});

test('the ₮ figure is snapshotted onto the row, never left to be re-derived', async () => {
  // A rate looked up later restates last month's margin, and D-004's formula is only
  // checkable after the fact if the row carries the rate it was priced at.
  const { db, rows } = stub();
  await run(db, new Date('2026-09-06T18:57:16Z'));
  const ledger = rows.find((r) => r['__table'] === 'spend_ledger');
  assert.equal(ledger?.['fx_mnt_per_usd'], 3500);
  // 1000 × 2000 + 200 × 10000 = 4,000,000 nanoUSD = $0.004 → ₮14.00
  assert.equal(ledger?.['cost_nanousd'], 4_000_000);
  assert.equal(ledger?.['cost_mnt'], 14);
});

test('DONE-TEST: NO FX ROW REFUSES — the ledger never records a null rate', async () => {
  // Same posture as `priceCall`: a spend we cannot express in ₮ is not written with a
  // guess. The caller alerts rather than refusing the customer's reply, which is already
  // sent by this point.
  const { db, rows } = stub({ fxRow: null });
  const r = await run(db, new Date('2026-09-06T18:57:16Z')) as { ok: boolean; detail?: string };
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /no FX rate/);
  assert.equal(rows.some((x) => x['__table'] === 'spend_ledger'), false, 'and nothing is written');
});

test('the settle addresses the same counters the reservation charged', async () => {
  // Including the tenant's own calendar, which rides on the reservation: a settle that
  // recomputed the day would credit the actual to one row and leave the estimate held on
  // another.
  const { db } = stub();
  const calls: { targets: { scope: string; period_key: string }[] }[] = [];
  const spy = {
    from: (db as unknown as { from: (t: string) => unknown }).from,
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      calls.push({ targets: args['p_targets'] as { scope: string; period_key: string }[] });
      return { data: null, error: null };
    },
  } as never;
  await run(spy, new Date('2026-09-06T18:57:16Z'));
  assert.equal(calls[0]?.targets.find((t) => t.scope === 'tenant')?.period_key, '2026-09-07');
  assert.equal(calls[0]?.targets.find((t) => t.scope === 'platform')?.period_key, '2026-09-07');
});

// ---------------------------------------------------------------------------
// The write multiplier is the TENANT'S, not a constant.
// ---------------------------------------------------------------------------

const WROTE = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 10_000 };

test('DONE-TEST: A 5m TENANT\'S WRITE IS PRICED AT THE 5m RATE', async () => {
  // `deps.ts` passed a literal '1h' for every tenant until 2026-09-07 — correct for Matrix
  // by coincidence and 1.6x over for a 5m tenant, in `cost_nanousd`, which is the column
  // D-004's margin is checked against. Nothing else in the system would have disagreed.
  const { db, rows } = stub();
  await run(db, new Date('2026-09-06T18:57:16Z'), { cacheTtl: '5m', usage: WROTE });
  // 1000×2000 + 200×10000 + 10000×2500 = 29,000,000
  assert.equal(rows.find((r) => r['__table'] === 'spend_ledger')?.['cost_nanousd'], 29_000_000);
});

test('and a 1h tenant\'s at the 1h rate — twice the 5m one', async () => {
  const { db, rows } = stub();
  await run(db, new Date('2026-09-06T18:57:16Z'), { cacheTtl: '1h', usage: WROTE });
  // 1000×2000 + 200×10000 + 10000×4000 = 44,000,000
  assert.equal(rows.find((r) => r['__table'] === 'spend_ledger')?.['cost_nanousd'], 44_000_000);
});

test('DONE-TEST: CACHING OFF PRICES NO WRITE, AND REFUSES IF THE API RETURNS ONE', async () => {
  // `off` is a third mode and it is not a rate. A tenant with caching off sends no
  // cache_control, so a write coming back means the provider and our configuration
  // disagree about what was asked for — and pricing it at a rate nobody chose puts a
  // number in the ledger that describes a request that was never made.
  const quiet = stub();
  await run(quiet.db, new Date('2026-09-06T18:57:16Z'), { cacheTtl: 'off' });
  assert.equal(quiet.rows.find((r) => r['__table'] === 'spend_ledger')?.['cost_nanousd'], 4_000_000,
    'no writes, so the write rate never enters the sum');

  const surprising = stub();
  const r = await run(surprising.db, new Date('2026-09-06T18:57:16Z'),
    { cacheTtl: 'off', usage: WROTE }) as { ok: boolean; detail?: string };
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /did not ask for/);
  assert.equal(surprising.rows.some((x) => x['__table'] === 'spend_ledger'), false);
});
