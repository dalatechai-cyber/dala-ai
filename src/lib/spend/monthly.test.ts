import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countShed, groupDigits, monthlySpendBlock, readMonthlySpend, shedLine, spendLevel, tenantSpendLine,
  type TenantMonthSpend,
} from './monthly.ts';
import { CLIENT_MONTHLY_NORMAL_LIMIT_MNT } from '../../config/platform.ts';

type Reply = { data: unknown; error: { message: string } | null };

/**
 * A PostgREST stand-in: each table answers from a queue, and every call's filters and range
 * are recorded so a test can say what was asked for.
 */
function stubDb(tables: Record<string, Reply[]>) {
  const calls: { table: string; filters: [string, string, unknown][]; range?: [number, number] }[] = [];
  const from = (table: string) => {
    const rec: (typeof calls)[number] = { table, filters: [] };
    calls.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'neq', 'gte', 'lt', 'in', 'is']) {
      chain[m] = (k: string, v: unknown) => { rec.filters.push([m, k, v]); return chain; };
    }
    chain['select'] = () => chain;
    chain['order'] = () => chain;
    chain['range'] = (a: number, b: number) => { rec.range = [a, b]; return chain; };
    chain['then'] = (res: (v: unknown) => unknown) => {
      const q = tables[table] ?? [];
      return res(q.length > 1 ? q.shift() : (q[0] ?? { data: [], error: null }));
    };
    return chain;
  };
  return { calls, db: { from } as never };
}

const UNTIL = '2026-09-25T16:00:00.000Z'; // 00:00 Ulaanbaatar on 09-26: the report covers 09-25.
const RUN = new Date('2026-09-25T16:05:00.000Z'); // the 00:05 run
const TENANTS: Reply = { data: [{ id: 't1', display_name: 'Salon A', timezone: 'Asia/Ulaanbaatar' }], error: null };

function tenant(over: Partial<TenantMonthSpend> = {}): TenantMonthSpend {
  return { tenant: 'Salon A', month: '2026-09', mntCents: 0, usd: 0n, daysCovered: 25, daysInMonth: 30, ...over };
}

test('the rulebook figure is 20,000 ₮ (rulebook §3.1) — a change here is the founder\'s', () => {
  assert.equal(CLIENT_MONTHLY_NORMAL_LIMIT_MNT, 20_000);
});

test('groups digits without the runtime locale', () => {
  assert.equal(groupDigits(0), '0');
  assert.equal(groupDigits(999), '999');
  assert.equal(groupDigits(20000), '20,000');
  assert.equal(groupDigits(1234567), '1,234,567');
});

test('SUMS EVERY PAGE, stopping only on an EMPTY page (a short page is not the last one)', async () => {
  // Two short pages: a server row cap below the requested page would look exactly like this.
  const { db, calls } = stubDb({
    tenants: [TENANTS],
    spend_ledger: [
      { data: [{ id: 1, cost_mnt: '100.25', cost_nanousd: 28_000_000 }, { id: 2, cost_mnt: 50, cost_nanousd: 14_000_000 }], error: null },
      { data: [{ id: 3, cost_mnt: '10.00', cost_nanousd: 3_000_000 }], error: null },
      { data: [], error: null },
    ],
  });
  const s = await readMonthlySpend(db, RUN);
  assert.ok(s.ok);
  assert.equal(s.tenants[0]?.mntCents, 16_025);
  assert.equal(s.tenants[0]?.usd, 45_000_000n);
  assert.equal(s.tenants[0]?.month, '2026-09');
  assert.equal(s.tenants[0]?.daysCovered, 25);
  assert.equal(s.tenants[0]?.daysInMonth, 30);

  const ledger = calls.filter((c) => c.table === 'spend_ledger');
  assert.equal(ledger.length, 3);
  assert.deepEqual(ledger.map((c) => c.range?.[0]), [0, 2, 3], 'the offset follows rows received, not the page size');
  const f = ledger[0]?.filters ?? [];
  assert.ok(f.some(([m, k, v]) => m === 'eq' && k === 'tenant_id' && v === 't1'));
  assert.ok(f.some(([m, k, v]) => m === 'neq' && k === 'budget_bucket' && v === 'platform_ops'), 'Dalatech\'s own quality spend is not the client\'s');
  // The month starts at 00:00 Ulaanbaatar on the 1st, which is 16:00 UTC on the 31st before.
  assert.ok(f.some(([m, k, v]) => m === 'gte' && k === 'at' && v === '2026-08-31T16:00:00.000Z'));
  assert.ok(f.some(([m, k, v]) => m === 'lt' && k === 'at' && v === UNTIL));
});

test('the report at 00:05 on the 1st reports the month that JUST ENDED', async () => {
  const { db, calls } = stubDb({ tenants: [TENANTS], spend_ledger: [{ data: [], error: null }] });
  const s = await readMonthlySpend(db, new Date('2026-09-30T16:05:00.000Z')); // 00:05 UB on 10-01
  assert.ok(s.ok);
  assert.equal(s.tenants[0]?.month, '2026-09');
  assert.equal(s.tenants[0]?.daysCovered, 30);
  assert.ok(calls.find((c) => c.table === 'spend_ledger')?.filters.some(([m, , v]) => m === 'gte' && v === '2026-08-31T16:00:00.000Z'));
});

test('A FAILED LEDGER READ IS UNREADABLE, NEVER ZERO', async () => {
  const { db } = stubDb({ tenants: [TENANTS], spend_ledger: [{ data: null, error: { message: 'timeout' } }] });
  const s = await readMonthlySpend(db, RUN);
  assert.ok(s.ok);
  assert.equal(s.tenants[0]?.mntCents, null);
  assert.match(tenantSpendLine(s.tenants[0] as TenantMonthSpend), /UNREADABLE — spend_ledger unreadable: timeout/);
});

test('an unparsable ₮ figure makes the tenant UNREADABLE rather than skipping the row', async () => {
  const { db } = stubDb({ tenants: [TENANTS], spend_ledger: [{ data: [{ id: 9, cost_mnt: 'abc', cost_nanousd: 1 }], error: null }] });
  const s = await readMonthlySpend(db, RUN);
  assert.ok(s.ok);
  assert.equal(s.tenants[0]?.mntCents, null);
});

test('a ledger that never ends is UNREADABLE after the page limit, not a partial sum', async () => {
  const page: Reply = { data: [{ id: 1, cost_mnt: 1, cost_nanousd: 1 }], error: null };
  const { db } = stubDb({ tenants: [TENANTS], spend_ledger: [page] }); // the one reply repeats for ever
  const s = await readMonthlySpend(db, RUN);
  assert.ok(s.ok);
  assert.equal(s.tenants[0]?.mntCents, null);
  assert.match(s.tenants[0]?.detail ?? '', /pages/);
});

test('an unreadable tenants table fails the whole block, and the block says so', async () => {
  const { db } = stubDb({ tenants: [{ data: null, error: { message: 'down' } }] });
  const s = await readMonthlySpend(db, RUN);
  assert.equal(s.ok, false);
  assert.match(monthlySpendBlock(s), /UNREADABLE — tenants unreadable: down/);
});

test('LEVELS: under 70% is plain, 70% alerts, 100% is over — and none says replies stop', () => {
  const under = tenant({ mntCents: 1_399_999 });
  const at70 = tenant({ mntCents: 1_400_000 });
  const over = tenant({ mntCents: 2_000_000 });
  assert.equal(spendLevel(under), 'ok');
  assert.equal(spendLevel(at70), 'alert');
  assert.equal(spendLevel(over), 'over');
  assert.doesNotMatch(tenantSpendLine(under), /ALERT|OVER|🟠|🔴/);
  assert.match(tenantSpendLine(at70), /^🟠 .*₮14,000 = 70%.*70% ALERT/);
  assert.match(tenantSpendLine(over), /^🔴 .*OVER the normal limit\. Replies continue/);
});

test('the pace figure projects the month from the days covered', () => {
  // ₮12,500 over 25 of 30 days is on pace for ₮15,000.
  assert.match(tenantSpendLine(tenant({ mntCents: 1_250_000 })), /on pace for ₮15,000 by month end/);
  // The whole month covered: no projection.
  assert.doesNotMatch(tenantSpendLine(tenant({ mntCents: 1_250_000, daysCovered: 30 })), /on pace/);
});

test('the block lists alerts first and says it never stops replies', () => {
  const text = monthlySpendBlock({
    ok: true,
    tenants: [tenant({ tenant: 'Quiet', mntCents: 100 }), tenant({ tenant: 'Busy', mntCents: 1_500_000 })],
  });
  assert.match(text, /normal limit ₮20,000 per client, alert at 70%; alerts only, never stops replies/);
  assert.ok(text.indexOf('Busy') < text.indexOf('Quiet'));
});

test('SHED: counted per tenant by name, «none» said, UNREADABLE never zero', async () => {
  const { db } = stubDb({
    webhook_events: [{ data: [{ tenant_id: 't1' }, { tenant_id: 't1' }], error: null }],
    tenants: [{ data: [{ id: 't1', display_name: 'Salon A' }], error: null }],
  });
  const s = await countShed(db, 'a', 'b');
  assert.match(shedLine(s), /^🔴 .*customer got no reply.*Salon A ×2/);
  assert.equal(shedLine({ ok: true, byTenant: [], capped: false }), 'No Messenger messages refused by a daily cap (yesterday)');
  const failed = await countShed(stubDb({ webhook_events: [{ data: null, error: { message: 'x' } }] }).db, 'a', 'b');
  assert.match(shedLine(failed), /UNREADABLE/);
});

test('a tenant EAST of Ulaanbaatar still gets its own whole previous month on the 1st', async () => {
  const { db, calls } = stubDb({
    tenants: [{ data: [{ id: 't9', display_name: 'Tokyo', timezone: 'Asia/Tokyo' }], error: null }],
    spend_ledger: [{ data: [], error: null }],
  });
  // 00:05 Ulaanbaatar on 10-01 is 01:05 in Tokyo on 10-01: Tokyo's last whole day is 09-30.
  const s = await readMonthlySpend(db, new Date('2026-09-30T16:05:00.000Z'));
  assert.ok(s.ok);
  assert.equal(s.tenants[0]?.month, '2026-09');
  assert.equal(s.tenants[0]?.daysCovered, 30);
  const f = calls.find((c) => c.table === 'spend_ledger')?.filters ?? [];
  assert.ok(f.some(([m, , v]) => m === 'lt' && v === '2026-09-30T15:00:00.000Z'), 'ends at Tokyo midnight');
});
