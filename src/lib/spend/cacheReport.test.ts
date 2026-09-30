import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheBlock, cacheLine, readCacheStats } from './cacheReport.ts';

type Reply = { data: unknown; error: { message: string } | null };

function stubDb(tables: Record<string, Reply[]>) {
  const calls: { table: string; filters: [string, string, unknown][] }[] = [];
  const from = (table: string) => {
    const rec: (typeof calls)[number] = { table, filters: [] };
    calls.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'neq', 'gte', 'lt']) chain[m] = (k: string, v: unknown) => { rec.filters.push([m, k, v]); return chain; };
    for (const m of ['select', 'order', 'range']) chain[m] = () => chain;
    chain['then'] = (res: (v: unknown) => unknown) => {
      const q = tables[table] ?? [];
      return res(q.length > 1 ? q.shift() : (q[0] ?? { data: [], error: null }));
    };
    return chain;
  };
  return { calls, db: { from } as never };
}

const TENANTS: Reply = { data: [{ id: 't1', display_name: 'Salon A', prompt_cache_mode: '5m' }], error: null };
const DATE = '2026-10-14'; // the reported Ulaanbaatar day

test('WINDOWS: the reported day, the 14 days ending with it, and the 14 before', async () => {
  const { db, calls } = stubDb({
    tenants: [TENANTS],
    spend_ledger: [
      { data: [
        { id: 1, at: '2026-10-14T03:00:00Z', cost_mnt: '300.00', cache_write_tokens: 16000 }, // yesterday, cold
        { id: 2, at: '2026-10-14T03:02:00Z', cost_mnt: 20, cache_write_tokens: 0 },           // yesterday, warm
        { id: 3, at: '2026-10-05T03:00:00Z', cost_mnt: 100, cache_write_tokens: 0 },          // last 14
        { id: 4, at: '2026-09-25T03:00:00Z', cost_mnt: 230, cache_write_tokens: 16000 },      // before
      ], error: null },
      { data: [], error: null },
    ],
  });
  const s = await readCacheStats(db, DATE);
  assert.ok(s.ok);
  const t = s.tenants[0];
  assert.ok(t !== undefined && !('unreadable' in t));
  assert.deepEqual(t.yesterday, { calls: 2, cold: 1, mntCents: 32_000, coldMntCents: 30_000 });
  assert.deepEqual(t.last, { calls: 3, cold: 1, mntCents: 42_000, coldMntCents: 30_000 });
  assert.deepEqual(t.before, { calls: 1, cold: 1, mntCents: 23_000, coldMntCents: 23_000 });
  const f = calls.find((c) => c.table === 'spend_ledger')?.filters ?? [];
  // 28 Ulaanbaatar days: from 00:00 UB on 09-17 (16:00 UTC on 09-16) to 00:00 UB on 10-15.
  assert.ok(f.some(([m, k, v]) => m === 'gte' && k === 'at' && v === '2026-09-16T16:00:00.000Z'));
  assert.ok(f.some(([m, k, v]) => m === 'lt' && k === 'at' && v === '2026-10-14T16:00:00.000Z'));
  assert.ok(f.some(([m, k, v]) => m === 'neq' && k === 'budget_bucket' && v === 'platform_ops'));
  assert.match(cacheLine(t), /^Salon A \[5m\]: yesterday 2 calls, 1 cold · last 14d ₮140\/call, 33% cold, ₮300\/cold call · the 14d before ₮230\/call, 100% cold, ₮230\/cold call$/);
});

test('A FAILED READ IS UNREADABLE, never zero; a quiet tenant is left out', async () => {
  const failed = await readCacheStats(stubDb({ tenants: [TENANTS], spend_ledger: [{ data: null, error: { message: 'timeout' } }] }).db, DATE);
  assert.ok(failed.ok);
  assert.match(cacheBlock(failed), /Salon A \[5m\]: UNREADABLE — spend_ledger unreadable: timeout/);
  const quiet = await readCacheStats(stubDb({ tenants: [TENANTS], spend_ledger: [{ data: [], error: null }] }).db, DATE);
  assert.match(cacheBlock(quiet), /no model calls in 28 days/);
  const down = await readCacheStats(stubDb({ tenants: [{ data: null, error: { message: 'x' } }] }).db, DATE);
  assert.match(cacheBlock(down), /UNREADABLE — tenants unreadable: x/);
});

test('an unparsable row makes the tenant UNREADABLE rather than skipping it', async () => {
  const s = await readCacheStats(stubDb({
    tenants: [TENANTS],
    spend_ledger: [{ data: [{ id: 9, at: '2026-10-14T03:00:00Z', cost_mnt: 'abc', cache_write_tokens: 0 }], error: null }],
  }).db, DATE);
  assert.match(cacheBlock(s), /UNREADABLE — spend_ledger row 9 unreadable/);
});

test('a tenant with caching OFF says «cache off», never «0% cold»', () => {
  const w = { calls: 2, cold: 0, mntCents: 20_000, coldMntCents: 0 };
  const line = cacheLine({ tenant: 'Salon B', mode: 'off', yesterday: w, last: w, before: w });
  assert.match(line, /^Salon B \[off\]: cache off/);
  assert.doesNotMatch(line, /% cold/);
});

test('a row with a missing write count or a null cost is UNREADABLE, not warm or ₮0', async () => {
  for (const bad of [
    { id: 5, at: '2026-10-14T03:00:00Z', cost_mnt: null, cache_write_tokens: 0 },
    { id: 6, at: '2026-10-14T03:00:00Z', cost_mnt: 10 },
  ]) {
    const s = await readCacheStats(stubDb({ tenants: [TENANTS], spend_ledger: [{ data: [bad], error: null }] }).db, DATE);
    assert.match(cacheBlock(s), /UNREADABLE — spend_ledger row \d unreadable/);
  }
});
