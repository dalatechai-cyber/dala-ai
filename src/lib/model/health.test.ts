import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertCacheCold, alertModelRetired, alertModelSwapped,
  CACHE_WINDOW, checkCacheHealth, checkServedModel,
} from './health.ts';

// The SEND is suppressed, never the row — so these tests still prove the condition was
// detected exactly once, which is what the dedup is for.
process.env['ALERTS_ENABLED'] = 'false';

function ledgerDb(rows: unknown, error: unknown = null) {
  const captured: Record<string, unknown>[] = [];
  const from = (table: string) => {
    // The op matters: raiseAlert first READS `alerts` to see whether the key was already
    // raised, then INSERTS to claim it. A stub that answers both the same way makes every
    // alert look like a duplicate and never reaches the insert at all.
    const rec = { op: 'select' };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
    chain['insert'] = (patch: Record<string, unknown>) => { rec.op = 'insert'; captured.push(patch); return chain; };
    chain['update'] = () => { rec.op = 'update'; return chain; };
    chain['maybeSingle'] = async () => {
      if (table === 'alerts') {
        // Not yet raised on the read; the claiming insert wins.
        return { data: rec.op === 'insert' ? { id: 1 } : null, error: null };
      }
      return { data: null, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: rows, error });
    return chain;
  };
  return { captured, db: { from } as never };
}

const cold = Array.from({ length: CACHE_WINDOW }, () => ({ cache_read_tokens: 0 }));
const base = { tenantId: 't-1', surface: 'reception', cacheMode: '1h' as const };

// ---------------------------------------------------------------------------
// The cache alarm.
// ---------------------------------------------------------------------------

test('a full window of cold calls is the alarm', async () => {
  const r = await checkCacheHealth(ledgerDb(cold).db, base);
  assert.equal(r.verdict, 'cold_run');
});

test('ONE warm call in the window is enough — a cold call is not a fault', async () => {
  // The first request after a TTL expiry always writes rather than reads. Alarming on a
  // single cold call would fire constantly and train the channel to be ignored.
  const mixed = [...cold.slice(1), { cache_read_tokens: 8800 }];
  const r = await checkCacheHealth(ledgerDb(mixed).db, base);
  assert.equal(r.verdict, 'warm');
  assert.equal(r.verdict === 'warm' && r.reads, 1);
});

test('below the window it is INSUFFICIENT DATA, not a clean bill of health', async () => {
  // Three cold calls could be three genuine cold starts. Reporting "warm" here would be
  // a false reassurance; reporting the alarm would be a false positive.
  const r = await checkCacheHealth(ledgerDb(cold.slice(0, 3)).db, base);
  assert.equal(r.verdict, 'insufficient_data');
  assert.equal(r.verdict === 'insufficient_data' && r.sample, 3);
});

test('a tenant with caching OFF never alarms — that is a choice, not a regression', async () => {
  const { db } = ledgerDb(cold);
  const r = await checkCacheHealth(db, { ...base, cacheMode: 'off' });
  assert.equal(r.verdict, 'not_expected');
});

test('an unreadable ledger is unavailable, never "warm"', async () => {
  // Silence because the check could not run looks exactly like silence because the cache
  // is fine.
  const r = await checkCacheHealth(ledgerDb(null, { message: 'timeout' }).db, base);
  assert.equal(r.verdict, 'unavailable');
});

test('a non-numeric cache_read_tokens does not count as a read', async () => {
  const junk = Array.from({ length: CACHE_WINDOW }, () => ({ cache_read_tokens: null }));
  assert.equal((await checkCacheHealth(ledgerDb(junk).db, base)).verdict, 'cold_run');
});

test('THE DEDUP KEY CARRIES THE DAY, so a still-broken cache re-announces itself', async () => {
  // Without the period the first alarm silences every later one forever, and a cache that
  // breaks again next month is invisible.
  const { db, captured } = ledgerDb([]);
  await alertCacheCold(db, { tenantId: 't-1', surface: 'reception', dayKey: '2026-09-04', sample: 10 });
  assert.equal(String(captured[0]?.['dedup_key']).includes('2026-09-04'), true);
  assert.equal(captured[0]?.['kind'], 'model.cache_cold_run');
});

test('the cache alarm says it is a bill, not an error', async () => {
  const { db, captured } = ledgerDb([]);
  await alertCacheCold(db, { tenantId: 't-1', surface: 'reception', dayKey: '2026-09-04', sample: 10 });
  const body = String(captured[0]?.['body']);
  assert.equal(body.includes('not an error'), true);
  assert.equal(body.includes('2.5x'), true);
});

// ---------------------------------------------------------------------------
// The served-model check.
// ---------------------------------------------------------------------------

test('the same id is not a finding', () => {
  assert.deepEqual(checkServedModel('claude-sonnet-5', 'claude-sonnet-5'), { verdict: 'as_requested' });
});

test('a different id IS a finding', () => {
  const r = checkServedModel('claude-sonnet-5', 'claude-haiku-4-5');
  assert.equal(r.verdict, 'swapped');
  assert.equal(r.verdict === 'swapped' && r.served, 'claude-haiku-4-5');
});

test('COMPARISON IS EXACT — no prefix matching, no "close enough"', () => {
  // Any leniency here is a rule about which differences do not matter, and that judgement
  // belongs to a person reading an alert, not to a string comparison.
  assert.equal(checkServedModel('claude-sonnet-5', 'claude-sonnet-5-20260401').verdict, 'swapped'); // not-a-pin: a dated id here is the thing being DETECTED, never called
  assert.equal(checkServedModel('claude-sonnet-5', 'Claude-Sonnet-5').verdict, 'swapped');
});

test('an unreported model is not a swap — absence of evidence is not evidence', () => {
  assert.deepEqual(checkServedModel('claude-sonnet-5', ''), { verdict: 'unreported' });
});

test('the swap alarm dedups on the PAIR, so a second, different swap still alerts', async () => {
  const { db, captured } = ledgerDb([]);
  await alertModelSwapped(db, { tenantId: 't-1', requested: 'a', served: 'b', dayKey: '2026-09-04' });
  assert.equal(String(captured[0]?.['dedup_key']), 'model_swap:a:b:2026-09-04');
});

// ---------------------------------------------------------------------------
// The retired-model alarm.
// ---------------------------------------------------------------------------

test('a retired model is CRITICAL and carries no tenant — it is every tenant', async () => {
  const { db, captured } = ledgerDb([]);
  await alertModelRetired(db, { modelId: 'claude-sonnet-5', detail: '404' });
  assert.equal(captured[0]?.['severity'], 'critical');
  assert.equal(captured[0]?.['tenant_id'], null);
});

test('the retired-model dedup key carries NO period — it is an event, not a condition', async () => {
  // Repeating it daily would add noise to an outage rather than information. It stays
  // true until somebody changes the registry.
  const { db, captured } = ledgerDb([]);
  await alertModelRetired(db, { modelId: 'claude-sonnet-5', detail: '404' });
  assert.equal(String(captured[0]?.['dedup_key']), 'model_not_found:claude-sonnet-5');
});

test('it says never to fall back, because that is the tempting wrong fix', async () => {
  const { db, captured } = ledgerDb([]);
  await alertModelRetired(db, { modelId: 'x', detail: '404' });
  assert.equal(String(captured[0]?.['body']).includes('Never fall back'), true);
});
