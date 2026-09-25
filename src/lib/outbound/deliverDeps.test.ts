import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliverDeps } from './deliverDeps.ts';

/**
 * `sent_at` is the one field in these deps that names an INSTANT rather than an attempt.
 *
 * It used to be written from the job's `now`, captured once when the QStash job started —
 * so it recorded a moment before the model had produced the reply. Measured on both real
 * sends this platform has made: `sent_at` preceded the draft row's own `created_at` by
 * 11.2s (2026-09-07 00:31:59.812 against 00:32:10.974) and by 16.0s (2026-09-06
 * 19:12:45.674 against 19:13:01.686). The column said the reply was sent before its text
 * existed.
 *
 * Nothing read it yet, which is exactly why it was worth fixing before something did — the
 * mirror phase wants reply latency, and every such number would have been ~11-16 seconds
 * short with no way to see it from the data.
 */
function stub() {
  const patches: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['eq', 'select', 'insert']) chain[m] = () => chain;
  chain['update'] = (patch: Record<string, unknown>) => { patches.push(patch); return chain; };
  chain['maybeSingle'] = async () => ({ data: null, error: null });
  chain['then'] = (res: (v: unknown) => unknown) => res({ data: null, error: null });
  return { db: { from: () => chain } as never, patches };
}

const JOB_START = new Date('2026-09-07T00:31:59.812Z');
const SEND_MOMENT = new Date('2026-09-07T00:32:11.400Z');

const deps = (db: never, clock?: () => Date) => buildDeliverDeps({
  db, tenantId: 't-1', channelId: 'ch-1', outboundId: 'om-1', attempts: 0,
  now: JOB_START, ...(clock === undefined ? {} : { clock }),
});

test('DONE-TEST: sent_at IS THE SEND MOMENT, NOT THE JOB START', async () => {
  const { db, patches } = stub();
  await deps(db, () => SEND_MOMENT).markSent('mid.1');
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!['sent_at'], SEND_MOMENT.toISOString());
  assert.notEqual(patches[0]!['sent_at'], JOB_START.toISOString(),
    'the job clock is 11.6s early here — that gap is the model call');
});

test('the clock is read at the moment of use, not once when the deps are built', async () => {
  // A clock captured at build time would return the same value twice. The failure this
  // guards is subtle: `clock: () => d` and `now: d` are indistinguishable in a test that
  // only ever sends once.
  const { db, patches } = stub();
  const times = [new Date('2026-09-07T00:32:11.000Z'), new Date('2026-09-07T00:33:22.000Z')];
  let i = 0;
  const d = deps(db, () => times[i++]!);
  await d.markSent('mid.1');
  await d.markSent('mid.2');
  assert.equal(patches[0]!['sent_at'], times[0]!.toISOString());
  assert.equal(patches[1]!['sent_at'], times[1]!.toISOString());
});

test('with no clock supplied it uses the real one, never the job start', async () => {
  // The route does not pass a clock, so the default is what production actually runs.
  const { db, patches } = stub();
  const before = Date.now();
  await deps(db).markSent('mid.1');
  const written = Date.parse(String(patches[0]!['sent_at']));
  assert.ok(written >= before, 'a real clock, read now');
  assert.ok(written > JOB_START.getTime(), 'and not the job clock it replaced');
});

// ---------------------------------------------------------------------------
// D-128: the alert binding, and the resolve on a successful send
// ---------------------------------------------------------------------------

/** Records every call on `alerts` as `method(args)`, and every insert's row. */
function alertsDb() {
  const ops: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    let inserted = false;
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'update', 'order', 'like']) {
      chain[m] = (...args: unknown[]) => { ops.push(`${table}.${m}(${JSON.stringify(args)})`); return chain; };
    }
    chain['insert'] = (row: Record<string, unknown>) => { inserts.push(row); inserted = true; return chain; };
    chain['maybeSingle'] = async () => ({ data: inserted ? { id: 1 } : null, error: null });
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: [{ id: 7 }], error: null });
    return chain;
  };
  return { db: { from } as never, ops, inserts };
}

test('DONE-TEST: a QUIET delivery alert is routed by DAILY_REPORT_V2, and only a quiet one', async () => {
  const saved = { v2: process.env['DAILY_REPORT_V2'], alerts: process.env['ALERTS_ENABLED'] };
  process.env['ALERTS_ENABLED'] = 'false';
  try {
    for (const [flag, want] of [[undefined, 'now'], ['true', 'digest'], ['false', 'now'], ['TRUE', 'now']] as const) {
      if (flag === undefined) delete process.env['DAILY_REPORT_V2']; else process.env['DAILY_REPORT_V2'] = flag;
      const { db, inserts } = alertsDb();
      const d = deps(db);
      await d.alert({ severity: 'warn', kind: 'outbound.reply_indeterminate', dedupKey: 'k1', body: 'b', quiet: true });
      await d.alert({ severity: 'critical', kind: 'outbound.token_revoked', dedupKey: 'k2', body: 'b', repeat: 'on_change' });
      assert.equal(inserts[0]?.['route'], want, `quiet under DAILY_REPORT_V2=${String(flag)}`);
      assert.equal(inserts[1]?.['route'], 'now', 'a critical is never demoted');
      assert.equal(inserts[1]?.['repeat_policy'], 'on_change');
      assert.equal(inserts[0]?.['repeat_policy'], 'daily', 'no repeat given keeps the default');
    }
  } finally {
    if (saved.v2 === undefined) delete process.env['DAILY_REPORT_V2']; else process.env['DAILY_REPORT_V2'] = saved.v2;
    if (saved.alerts === undefined) delete process.env['ALERTS_ENABLED']; else process.env['ALERTS_ENABLED'] = saved.alerts;
  }
});

test('resolveAlerts is ONE conditional update over open on_change rows with exactly those keys', async () => {
  const { db, ops } = alertsDb();
  const r = await deps(db, () => SEND_MOMENT).resolveAlerts(['a:1', 'b:2']);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(ops, [
    `alerts.update(${JSON.stringify([{ resolved_at: SEND_MOMENT.toISOString() }])})`,
    `alerts.in(${JSON.stringify(['dedup_key', ['a:1', 'b:2']])})`,
    `alerts.is(${JSON.stringify(['resolved_at', null])})`,
    `alerts.eq(${JSON.stringify(['repeat_policy', 'on_change'])})`,
    `alerts.select(${JSON.stringify(['id'])})`,
  ]);
});
