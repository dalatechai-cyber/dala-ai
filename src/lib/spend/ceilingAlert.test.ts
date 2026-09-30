import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertCeilingReached, ceilingBody, ceilingPagesLine, readCeilingPages, ceilingEpisodeKey, closeStaleCeilingEpisodes, whichCeiling, CEILING_KIND,
} from './ceilingAlert.ts';

type Reply = { data: unknown; error: { message: string; code?: string } | null };

/** Every builder method returns the chain; the terminal answers from the table's queue. */
function stubDb(tables: Record<string, Reply[]>, opts: { hang?: boolean } = {}) {
  const writes: { table: string; op: string; patch: unknown; filters: [string, unknown][] }[] = [];
  const from = (table: string) => {
    let op = 'select';
    let patch: unknown = null;
    const filters: [string, unknown][] = [];
    const answer = (): Promise<Reply> => {
      if (opts.hang) return new Promise(() => {});
      if (op !== 'select') writes.push({ table, op, patch, filters });
      const q = tables[`${table}:${op}`] ?? tables[table] ?? [];
      return Promise.resolve(q.length > 1 ? (q.shift() as Reply) : (q[0] ?? { data: null, error: null }));
    };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'like', 'order', 'limit', 'gte', 'lt', 'neq']) {
      chain[m] = (k?: unknown, v?: unknown) => { if (m !== 'select') filters.push([String(k), v]); return chain; };
    }
    for (const m of ['insert', 'update', 'upsert']) chain[m] = (p: unknown) => { op = m; patch = p; return chain; };
    chain['maybeSingle'] = answer;
    chain['single'] = answer;
    chain['then'] = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => answer().then(res, rej);
    return chain;
  };
  return { writes, db: { from } as never };
}

const T = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-09-25T05:00:00Z'); // 13:00 Ulaanbaatar

test('the episode key carries NO period (D-063, D-128): one page per brake, not per message', () => {
  assert.equal(ceilingEpisodeKey(T, 'reception'), `${CEILING_KIND}:${T}:reception`);
  assert.doesNotMatch(ceilingEpisodeKey(T, 'reception'), /\d{4}-\d{2}-\d{2}/);
});

test('WHICH CEILING: tenant, platform, both, a zero budget, or honestly unknown', () => {
  const at = (used: bigint, ceiling: bigint) => ({ used, ceiling });
  const est = 41_000_000n;
  assert.match(whichCeiling(at(1_990_000_000n, 2_000_000_000n), at(0n, 10_000_000_000n), est), /tenant's daily cap/);
  assert.match(whichCeiling(at(0n, 2_000_000_000n), at(9_990_000_000n, 10_000_000_000n), est), /platform's daily cap/);
  assert.match(whichCeiling(at(1_990_000_000n, 2_000_000_000n), at(9_990_000_000n, 10_000_000_000n), est), /both/);
  // `reserve.ts` refuses a zero budget BEFORE seeding a counter: no tenant row, platform under.
  assert.match(whichCeiling('absent', at(0n, 10_000_000_000n), est), /gives this surface nothing/);
  // An absent tenant row beside an unreadable platform row is not guessed at.
  assert.match(whichCeiling('absent', null, est), /no longer show which/);
  assert.match(whichCeiling(null, null, est), /no longer show which/);
});

test('THE BODY says what the customer gets, what is spent, and that the cap did not move', () => {
  const body = ceilingBody({
    name: 'Salon A', channel: 'messenger', surface: 'reception', timezone: 'Asia/Ulaanbaatar', now: NOW,
    which: 'the tenant\'s daily cap',
    tenant: { used: 1_990_000_000n, ceiling: 2_000_000_000n }, platform: null,
  });
  assert.match(body, /on a live channel customers get the tenant's reviewed hand-off line where it has one/);
  assert.match(body, /otherwise no reply/);
  assert.match(body, /nothing more is spent/);
  assert.match(body, /Tenant 2026-09-25: \$1\.99 of \$2\.00/);
  assert.match(body, /Platform today: UNREADABLE/, 'an unreadable counter is said, never shown as $0');
  assert.match(body, /The cap is unchanged/);
});

test('RAISES ONE critical on_change episode, routed now, with the tenant\'s name', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, writes } = stubDb({
    tenants: [{ data: { display_name: 'Salon A' }, error: null }],
    spend_counters: [{ data: { ceiling_nanousd: 2_000_000_000, reserved_nanousd: 0, settled_nanousd: 1_990_000_000 }, error: null }],
    'alerts:select': [{ data: null, error: null }],
    'alerts:insert': [{ data: { id: 7 }, error: null }],
  });
  const out = await alertCeilingReached(db, {
    tenantId: T, surface: 'reception', timezone: 'Asia/Ulaanbaatar', now: NOW, channel: 'messenger', estimate: 41_000_000n,
  });
  assert.match(out, /recorded_undelivered/);
  const ins = writes.find((w) => w.table === 'alerts' && w.op === 'insert')?.patch as Record<string, unknown>;
  assert.equal(ins['severity'], 'critical');
  assert.equal(ins['route'], 'now');
  assert.equal(ins['repeat_policy'], 'on_change');
  assert.equal(ins['dedup_key'], ceilingEpisodeKey(T, 'reception'));
  assert.match(String(ins['body']), /Salon A/);
  // It never touches the money: no reservation, counter or ledger write.
  assert.ok(writes.every((w) => w.table === 'alerts'), JSON.stringify(writes.map((w) => w.table)));
  delete process.env['ALERTS_ENABLED'];
});

test('an OPEN episode suppresses the page for every later refusal', async () => {
  const { db, writes } = stubDb({
    tenants: [{ data: { display_name: 'Salon A' }, error: null }],
    spend_counters: [{ data: null, error: null }],
    'alerts:select': [{ data: { id: 3 }, error: null }],
  });
  const out = await alertCeilingReached(db, {
    tenantId: T, surface: 'reception', timezone: 'Asia/Ulaanbaatar', now: NOW, channel: 'messenger', estimate: 1n,
  });
  assert.equal(out, 'suppressed_duplicate');
  assert.equal(writes.length, 0);
});

test('A HUNG DATABASE cannot hold the worker: the alert gives up at its bound and resolves', async () => {
  const { db } = stubDb({}, { hang: true });
  const t0 = Date.now();
  const out = await alertCeilingReached(db, {
    tenantId: T, surface: 'reception', timezone: 'Asia/Ulaanbaatar', now: NOW, channel: 'web', estimate: 1n,
  }, 50);
  assert.match(out, /timed_out after 50ms/);
  assert.ok(Date.now() - t0 < 2_000);
});

test('a THROWING database is a returned label, never a rejection', async () => {
  const db = { from: () => { throw new Error('boom'); } } as never;
  const out = await alertCeilingReached(db, {
    tenantId: T, surface: 'reception', timezone: 'Asia/Ulaanbaatar', now: NOW, channel: 'web', estimate: 1n,
  });
  assert.match(out, /^failed: boom/);
});

test('CLOSE: only once BOTH the tenant\'s and the platform\'s day have rolled over', async () => {
  const opened = '2026-09-25T02:00:00Z'; // 10:00 UB on 09-25
  const open: Reply = { data: [{ id: 1, tenant_id: T, dedup_key: ceilingEpisodeKey(T, 'reception'), at: opened }], error: null };
  const zones: Reply = { data: [{ id: T, timezone: 'Asia/Ulaanbaatar' }], error: null };

  const same = stubDb({ 'alerts:select': [open], tenants: [zones] });
  const r1 = await closeStaleCeilingEpisodes(same.db, new Date('2026-09-25T15:59:00Z')); // 23:59 UB, same day
  assert.deepEqual(r1, { ok: true, closed: 0 });
  assert.equal(same.writes.length, 0, 'still the same day: the brake may still be on');

  const next = stubDb({ 'alerts:select': [open], tenants: [zones], 'alerts:update': [{ data: [{ id: 1 }], error: null }] });
  const r2 = await closeStaleCeilingEpisodes(next.db, new Date('2026-09-25T16:01:00Z')); // 00:01 UB, next day
  assert.deepEqual(r2, { ok: true, closed: 1 });
  assert.deepEqual(next.writes[0]?.filters.find(([k]) => k === 'id')?.[1], [1]);
});

test('CLOSE leaves an episode open when the tenant\'s zone cannot be read', async () => {
  const s = stubDb({
    'alerts:select': [{ data: [{ id: 1, tenant_id: T, dedup_key: 'k', at: '2026-09-20T00:00:00Z' }], error: null }],
    tenants: [{ data: [], error: null }],
  });
  assert.deepEqual(await closeStaleCeilingEpisodes(s.db, NOW), { ok: true, closed: 0 });
});

test('CLOSE reports an unreadable alerts table instead of claiming nothing was open', async () => {
  const s = stubDb({ 'alerts:select': [{ data: null, error: { message: 'down' } }] });
  const r = await closeStaleCeilingEpisodes(s.db, NOW);
  assert.equal(r.ok, false);
});

test('an ABSENT tenant counter reads as absent, not UNREADABLE', () => {
  const body = ceilingBody({
    name: 'Salon A', channel: 'messenger', surface: 'reception', timezone: 'Asia/Ulaanbaatar', now: NOW,
    which: 'x', tenant: 'absent', platform: { used: 0n, ceiling: 10_000_000_000n },
  });
  assert.match(body, /Tenant 2026-09-25: no counter yet today/);
  assert.doesNotMatch(body, /UNREADABLE/);
});

test('CLOSE: an episode whose tenant was deleted closes on the platform\'s day alone', async () => {
  const s = stubDb({
    'alerts:select': [{ data: [{ id: 4, tenant_id: null, dedup_key: 'k', at: '2026-09-20T00:00:00Z' }], error: null }],
    'alerts:update': [{ data: [{ id: 4 }], error: null }],
  });
  assert.deepEqual(await closeStaleCeilingEpisodes(s.db, NOW), { ok: true, closed: 1 });
});

test('THE DAY\'S PAGES are read whatever their resolved state, and an undelivered one is named', async () => {
  const s = stubDb({
    alerts: [{ data: [{ tenant_id: T, delivered: false }], error: null }],
    tenants: [{ data: [{ id: T, display_name: 'Salon A' }], error: null }],
  });
  const r = await readCeilingPages(s.db, 'a', 'b');
  assert.deepEqual(r, { ok: true, pages: [{ tenant: 'Salon A', delivered: false }] });
  assert.match(ceilingPagesLine(r), /Salon A \(NOT DELIVERED/);
  assert.equal(ceilingPagesLine({ ok: false }), 'Daily-cap pages (yesterday): UNREADABLE');
});
