import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeps } from './deps.ts';
import type { Reservation } from '../spend/reserve.ts';

/**
 * The seam this file exists for.
 *
 * `buildDeps` is where a tenant's settings become the arguments the spend path is called
 * with, and it had a literal `'1h'` in it for every tenant — correct for Matrix by
 * coincidence. Nothing tested this join, because `settle` has its own tests and `deps` had
 * none, and a hardcode between two well-tested things is invisible to both.
 */
const RESERVATION: Reservation = {
  id: 'res-1', tenantId: 't-1', surface: 'reception', estimate: 12_000_000n,
  timezone: 'Asia/Ulaanbaatar',
};

const PRICE_ROW = {
  input_nanousd_per_token: '2000',
  output_nanousd_per_token: '10000',
  cache_read_nanousd_per_token: '200',
  cache_write_5m_nanousd_per_token: '2500',
  cache_write_1h_nanousd_per_token: '4000',
};

function stub() {
  const rows: Record<string, unknown>[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit', 'eq', 'lte', 'update']) chain[m] = () => chain;
    chain['insert'] = (row: Record<string, unknown>) => (rows.push({ ...row, __table: table }), chain);
    chain['maybeSingle'] = async () => {
      if (table === 'model_prices') return { data: PRICE_ROW, error: null };
      if (table === 'fx_rates') return { data: { mnt_per_unit: '3500.0000' }, error: null };
      return { data: null, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: null, error: null });
    return chain;
  };
  return { db: { from, rpc: async () => ({ data: null, error: null }) } as never, rows };
}

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 10_000 };

function depsFor(cacheMode: 'off' | '5m' | '1h', db: never) {
  return buildDeps({
    db, cacheMode, tenantId: 't-1', channelId: 'ch-1', conversationId: 'conv-1',
    inboundExternalId: 'mid-1', reservation: RESERVATION, now: new Date('2026-09-07T04:00:00Z'),
  });
}

test('DONE-TEST: THE TENANT\'S CACHE MODE REACHES THE LEDGER, not a literal', async () => {
  // 10,000 write tokens at the 5m rate is 25,000,000 nanoUSD; at the 1h rate, 40,000,000.
  // A hardcoded '1h' bills a 5m tenant 1.6x on the whole row — in `cost_nanousd`, the
  // column D-004's margin is checked against, with nothing else in the system disagreeing.
  const fiveMin = stub();
  await depsFor('5m', fiveMin.db).settle(USAGE, 'claude-sonnet-5');
  assert.equal(fiveMin.rows.find((r) => r['__table'] === 'spend_ledger')?.['cost_nanousd'], 29_000_000);

  const oneHour = stub();
  await depsFor('1h', oneHour.db).settle(USAGE, 'claude-sonnet-5');
  assert.equal(oneHour.rows.find((r) => r['__table'] === 'spend_ledger')?.['cost_nanousd'], 44_000_000);
});

test('a tenant with caching off refuses a write it never asked for', async () => {
  // Not a hypothetical shape: `off` is tenant #0's mode today. If a write comes back
  // anyway, the provider and our configuration disagree about the request that was made,
  // and there is no rate that honestly describes it.
  const { db, rows } = stub();
  const r = await depsFor('off', db).settle(USAGE, 'claude-sonnet-5');
  assert.equal(r.ok, false);
  assert.equal(rows.some((x) => x['__table'] === 'spend_ledger'), false);
});

test('and prices a cached read normally when nothing was written', async () => {
  const { db, rows } = stub();
  const r = await depsFor('off', db).settle({ input_tokens: 1000, output_tokens: 200 }, 'claude-sonnet-5');
  assert.equal(r.ok, true);
  assert.equal(rows.find((x) => x['__table'] === 'spend_ledger')?.['cost_nanousd'], 4_000_000);
});

// ── D-128: a clean answer on a model id closes its retired-model episode ─────────────

/** Records every statement on `alerts` as a list of `method(args)` calls, one list per `from`. */
function alertsStub() {
  const statements: string[][] = [];
  const from = (table: string) => {
    const ops: string[] = [];
    if (table === 'alerts') statements.push(ops);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit', 'eq', 'is', 'in', 'update', 'insert']) {
      chain[m] = (...args: unknown[]) => { ops.push(`${m}(${JSON.stringify(args)})`); return chain; };
    }
    chain['maybeSingle'] = async () => ({ data: null, error: null });
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: [], error: null });
    return chain;
  };
  return { db: { from, rpc: async () => ({ data: null, error: null }) } as never, statements };
}

test('DONE-TEST: A SUCCESSFUL CALL RESOLVES THE MODEL EPISODE IN ONE CONDITIONAL UPDATE', async () => {
  // Before 2026-09-25 a retired-model alert fired once in the life of the project. Now the
  // next clean answer on the same id closes the episode, so the next 404 pages again.
  const { db, statements } = alertsStub();
  await depsFor('1h', db).observe({ requestedModel: 'claude-sonnet-5', servedModel: 'claude-sonnet-5' });
  assert.equal(statements.length, 1, 'exactly one statement on alerts per clean reply');
  assert.deepEqual(statements[0], [
    `update(${JSON.stringify([{ resolved_at: '2026-09-07T04:00:00.000Z' }])})`,
    `in(${JSON.stringify(['dedup_key', ['model_not_found:claude-sonnet-5']])})`,
    `is(${JSON.stringify(['resolved_at', null])})`,
    `eq(${JSON.stringify(['repeat_policy', 'on_change'])})`,
    `select(${JSON.stringify(['id'])})`,
  ]);
});

test('a terminal outcome resolves nothing; a 404 raises the episode instead', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const refused = alertsStub();
  await depsFor('1h', refused.db).observe({ requestedModel: 'claude-sonnet-5', servedModel: '', terminalReason: 'refusal' });
  assert.ok(refused.statements.every((ops) => !ops.some((o) => o.startsWith('update('))), 'no resolve on a terminal');

  const gone = alertsStub();
  await depsFor('1h', gone.db).observe({ requestedModel: 'claude-sonnet-5', servedModel: '', terminalReason: 'model_not_found' });
  const insert = gone.statements.flat().find((o) => o.startsWith('insert('));
  assert.match(insert ?? '', /"dedup_key":"model_not_found:claude-sonnet-5"/);
  assert.match(insert ?? '', /"repeat_policy":"on_change"/);
  assert.ok(!gone.statements.flat().some((o) => o.startsWith('update([{"resolved_at"')), 'a 404 never closes its own episode');
});
