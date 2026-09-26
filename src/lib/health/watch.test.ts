import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSilenceWatch, DEFAULT_THRESHOLD_OPEN_MINUTES } from './watch.ts';

const NOW = new Date('2026-09-04T06:00:00Z');        // 14:00 in Ulaanbaatar
const FRESH = '2026-09-04T05:30:00Z';
const STALE = '2026-09-04T02:00:00Z';                // four open hours ago

const CHANNEL = {
  id: 'ch-1', tenant_id: 't-1', external_id: '100000000000001',
  last_webhook_at: null, expects_traffic_since: '2026-08-01T00:00:00Z',
};

const HOURS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '10:00', closes: '20:00', closed: false }));

type Answer = { data?: unknown; error?: unknown };

/**
 * A db that answers per table and records every write.
 *
 * An override may be a LIST, consumed in order, because `alerts` is read and written
 * several times in one run: `resolveOpenAlerts` selects then updates, and `raiseAlert` then
 * asks whether the key is already raised before inserting. A single value would answer all
 * four with the same row and make the suppression check see the episode it had just closed.
 */
function stub(over: Record<string, Answer | Answer[]> = {}) {
  const writes: { table: string; op: string; patch: Record<string, unknown> }[] = [];
  const reads: { table: string; filters: string[] }[] = [];
  const queues = new Map<string, Answer[]>();
  const answer = (table: string): Answer => {
    const o = over[table];
    if (Array.isArray(o)) {
      if (!queues.has(table)) queues.set(table, [...o]);
      // Running out is a test-setup bug, so it fails loudly rather than falling through to
      // a default that would quietly change what the run saw.
      const next = queues.get(table)?.shift();
      if (next === undefined) throw new Error(`stub: ran out of queued answers for ${table}`);
      return next;
    }
    if (o !== undefined) return o;
    if (table === 'tenants') return { data: { timezone: 'Asia/Ulaanbaatar' }, error: null };
    if (table === 'tenant_channels') return { data: [CHANNEL], error: null };
    if (table === 'business_hours') return { data: HOURS, error: null };
    if (table === 'alerts') return { data: null, error: null };
    return { data: [], error: null };
  };
  const from = (table: string) => {
    const rec = { table, filters: [] as string[] };
    reads.push(rec);
    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    chain['eq'] = (col: string, val: unknown) => (rec.filters.push(`${col}=${String(val)}`), chain);
    chain['gte'] = (col: string, val: unknown) => (rec.filters.push(`${col}>=${String(val)}`), chain);
    chain['in'] = (col: string, vals: readonly unknown[]) => (rec.filters.push(`${col} in ${vals.join(',')}`), chain);
    chain['is'] = (col: string, val: unknown) => (rec.filters.push(`${col} is ${String(val)}`), chain);
    chain['neq'] = (col: string, val: unknown) => (rec.filters.push(`${col}!=${String(val)}`), chain);
    chain['like'] = (col: string, val: unknown) => (rec.filters.push(`${col} like ${String(val)}`), chain);
    chain['order'] = () => chain;
    chain['limit'] = () => chain;
    for (const op of ['insert', 'update', 'upsert'] as const) {
      chain[op] = (patch: Record<string, unknown>) => {
        writes.push({ table, op, patch });
        return chain;
      };
    }
    chain['maybeSingle'] = async () => answer(table);
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(table));
    return chain;
  };
  return { writes, reads, db: { from } as never };
}

test('a healthy channel is recorded, and raises nothing', async () => {
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'healthy');
  assert.equal(writes.some((w) => w.table === 'alerts'), false, 'no alert for a healthy channel');
});

test('DONE-TEST: HEALTHY IS WRITTEN TOO — "checked and fine" must differ from "not checked"', async () => {
  // A watchdog that only writes on failure is indistinguishable from a watchdog that
  // stopped running, which is the failure mode of watchdogs generally. `observed_at` on
  // every run is what tells the two apart.
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  });
  await runSilenceWatch(db, { now: NOW });
  const health = writes.find((w) => w.table === 'channel_health');
  assert.equal(health?.patch['healthy'], true);
  assert.equal(health?.patch['state'], 'healthy');
  assert.equal(health?.patch['observed_at'], NOW.toISOString());
});

test('DONE-TEST: a silent channel alerts once per EPISODE, not once per day', async () => {
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: STALE }], error: null },
    conversations: { data: [{ last_message_at: STALE }], error: null },
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'no_webhooks');

  const alert = writes.find((w) => w.table === 'alerts');
  assert.equal(alert?.patch['severity'], 'critical');
  assert.equal(alert?.patch['kind'], 'channel.no_webhooks');
  // DIGEST, not `now` (2026-09-20). It paged immediately until eight criticals in eight
  // days turned out to be ordinary quiet mornings. `on_change` is still what stops the
  // second, third and seventh; the route is what stops the first one waking anybody.
  // The outage path survives in `planDigest`: an open critical older than
  // ESCALATE_AFTER_DAYS gets its own message on every run.
  assert.equal(alert?.patch['route'], 'digest');
  assert.equal(alert?.patch['repeat_policy'], 'on_change');
  // The Page id, so the notification itself is actionable.
  assert.match(String(alert?.patch['body']), /100000000000001/);
});

test('THE DEDUP KEY CARRIES THE STATE, so a worsening fault is not suppressed', async () => {
  // A channel that degrades from `no_messages` to `no_webhooks` on the same day is a new
  // fact — the remedy changes from a Page setting to the token. Keying on the channel and
  // the day alone would swallow the second one as a duplicate of the first.
  const standby = stub({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: STALE }], error: null },
  });
  await runSilenceWatch(standby.db, { now: NOW });
  const dead = stub({
    webhook_events: { data: [{ received_at: STALE }], error: null },
    conversations: { data: [{ last_message_at: STALE }], error: null },
  });
  await runSilenceWatch(dead.db, { now: NOW });

  const keyOf = (w: typeof standby.writes) => String(w.find((x) => x.table === 'alerts')?.patch['dedup_key']);
  assert.notEqual(keyOf(standby.writes), keyOf(dead.writes));
});

test('DONE-TEST: a failed read makes the channel UNKNOWN, never skipped', async () => {
  // The tempting `continue` here would give the watchdog the exact defect it exists to
  // detect: something is wrong and nothing says so.
  const { db, writes } = stub({ business_hours: { data: null, error: { message: 'connection reset' } } });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'unknown');
  assert.match(r.ok ? r.verdicts[0]?.diagnosis.reason ?? '' : '', /business_hours unreadable/);
  assert.equal(writes.find((w) => w.table === 'alerts')?.patch['severity'], 'warn');
});

test('DONE-TEST: A PROVISIONING GAP IS RECORDED AND RAISES NOTHING', async () => {
  // The live false alarm, at the layer that decides. Tenant #0's channel went live before
  // its `business_hours` were entered, and the daily `channel.unknown` it raised is the
  // alert the founder was trying to learn to trust. Recorded — so the gap is visible to
  // anyone who looks at the table — and never paged.
  const { db, writes } = stub({ business_hours: { data: [], error: null } });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'not_provisioned');

  const health = writes.find((w) => w.table === 'channel_health');
  assert.equal(health?.patch['healthy'], false);
  assert.match(String(health?.patch['reason']), /business_hours/);
  // 0017: the verdict itself, so a reader can tell an unfinished form from a dead token
  // without parsing an alert sentence. The boolean alone would put this row and a revoked
  // token in the same bucket.
  assert.equal(health?.patch['state'], 'not_provisioned');
  assert.equal(writes.some((w) => w.table === 'alerts'), false, 'a provisioning gap must not alert');
});

test('an unreadable channel list refuses the whole run rather than reporting zero', async () => {
  // "Checked 0 channels" and "could not read the channel list" look identical in a log and
  // mean opposite things.
  const { db } = stub({ tenant_channels: { data: null, error: { message: 'timeout' } } });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok, false);
});

test('every channel that EXPECTS traffic is watched, not only the ones that answer', async () => {
  // This asserted `delivery_mode=live` and was right about the code and wrong about the
  // world: Matrix mirrored real customer traffic in `shadow` for a fortnight with nothing
  // looking at it, so a broken subscription would have shown up as an empty table and a
  // mirror reporting a good number from no data.
  //
  // A positive allow-list, asserted as one: a delivery_mode added later must be unwatched
  // until somebody decides otherwise, never watched by accident.
  const { db, reads } = stub();
  await runSilenceWatch(db, { now: NOW });
  const filters = reads.find((c) => c.table === 'tenant_channels')?.filters ?? [];
  assert.deepEqual(filters, ['delivery_mode in shadow_routing,shadow,live']);
  assert.equal(filters.some((f) => f === 'delivery_mode=live'), false, 'no longer live-only');
});

test('a comment the platform FETCHED is not evidence Meta is delivering (D-146)', async () => {
  // The Instagram poller writes `webhook_events` rows with `source = 'poll'`. Counted here,
  // they would keep a channel whose webhook died reading healthy for as long as its posts
  // get comments. Both delivery reads — attributed and unattributed — exclude them.
  const { db, reads } = stub();
  await runSilenceWatch(db, { now: NOW });
  const eventReads = reads.filter((c) => c.table === 'webhook_events');
  assert.equal(eventReads.length, 2);
  for (const r of eventReads) assert.ok(r.filters.includes('source!=poll'), r.filters.join(' '));
});

test('DONE-TEST: NO DATE IN THE KEY — that is what made it repeat', async () => {
  // This test used to assert the opposite, and was right about the bug it was written for.
  // The key was `channel_silence:{channel}:{state}:{localDate}` and the day had been moved
  // from UTC to the tenant's clock because a channel silent across a Ulaanbaatar morning
  // raised TWO alerts for one trading day — the UTC day rolls at 08:00 local, an hour
  // before a salon opens. That fix was right about the boundary and wrong about there being
  // a boundary at all.
  //
  // Measured 2026-09-14: one unchanged condition had produced a critical Telegram every
  // morning for six days, ten of the eleven rows the table then held, in the chat that also
  // carries the demo-request notifications. The date is the mechanism that did it, so the
  // date is gone and the policy is `on_change`.
  //
  // 2026-09-04T18:30:00Z is 02:30 on the 5th in Ulaanbaatar, the exact instant the old test
  // used to prove the day had rolled. Now nothing about the key may move with it.
  const lateUtc = new Date('2026-09-04T18:30:00Z');
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: '2026-08-20T00:00:00Z' }], error: null },
  });
  await runSilenceWatch(db, { now: lateUtc });
  const key = String(writes.find((w) => w.table === 'alerts')?.patch['dedup_key']);
  assert.equal(key, 'channel_silence:ch-1:no_webhooks', key);
  assert.doesNotMatch(key, /\d{4}-\d{2}-\d{2}/, 'a date in the key IS the daily repeat');
});

test('DONE-TEST: A RECOVERY IS SAID OUT LOUD, not just recorded', async () => {
  // Closing an episode silently would mean an operator paged about a dead channel is never
  // told it came back — and cannot tell that from an alarm that quietly stopped working,
  // which is D-062's whole subject arriving inside the fix for it.
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
    // In call order: the open-episode select, the resolve update, raiseAlert's
    // already-raised check (nothing), then its insert.
    alerts: [
      { data: [{
        id: 42, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
        dedup_key: 'channel_silence:ch-1:no_webhooks', body: 'Page 100000000000001: dead',
        at: '2026-09-01T00:00:00Z', notified_at: '2026-09-01T00:00:00Z',
      }], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 99 }, error: null },
    ],
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'healthy');

  const resolved = writes.find((w) => w.table === 'alerts' && w.op === 'update');
  assert.equal(resolved?.patch['resolved_at'], NOW.toISOString(), 'the episode is closed');

  const recovery = writes.find((w) => w.table === 'alerts' && w.op === 'insert');
  assert.equal(recovery?.patch['kind'], 'channel.recovered');
  assert.equal(recovery?.patch['severity'], 'info');
  // Keyed on the episode it closes, so it is unrepeatable by construction — and `once`, so
  // it can never become a standing item in the digest. A recovery is an event.
  assert.equal(recovery?.patch['dedup_key'], 'channel_recovered:42');
  assert.equal(recovery?.patch['repeat_policy'], 'once');
});

test('DONE-TEST: A PROVISIONING GAP DOES NOT CLOSE AN OPEN EPISODE', async () => {
  // Losing the ability to measure a channel is no evidence the channel is well. If this
  // resolved, deleting a `business_hours` row would silence a real outage — the watchdog
  // acquiring the defect it exists to detect, by way of a data entry mistake.
  const { db, writes } = stub({
    business_hours: { data: [], error: null },
    alerts: { data: [{
      id: 7, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
      dedup_key: 'channel_silence:ch-1:no_webhooks', body: 'Page 100000000000001: dead',
      at: '2026-09-01T00:00:00Z', notified_at: null,
    }], error: null },
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'not_provisioned');
  assert.equal(writes.some((w) => w.table === 'alerts'), false,
    'a gap neither alerts nor resolves');
});

test('a degrade supersedes the episode it replaces, so the digest cannot list one channel twice', async () => {
  // `no_messages` and `no_webhooks` are two episodes for one channel. Without superseding,
  // both stay open for ever and the 09:00 digest lists the channel twice — one entry naming
  // a fault it no longer has, which is worse than not listing it at all.
  const { db, writes, reads } = stub({
    webhook_events: { data: [{ received_at: STALE }], error: null },
    conversations: { data: [{ last_message_at: STALE }], error: null },
    alerts: [
      { data: [{
        id: 11, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_messages',
        dedup_key: 'channel_silence:ch-1:no_messages', body: 'Page 100000000000001: standby',
        at: '2026-09-02T00:00:00Z', notified_at: '2026-09-02T00:00:00Z',
      }], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 12 }, error: null },
    ],
  });
  await runSilenceWatch(db, { now: NOW });

  // Read by PREFIX — the state is in the key, so an exact match could never find the
  // episode being replaced.
  const byPrefix = reads.find((r) => r.table === 'alerts'
    && r.filters.some((f) => f === 'dedup_key like channel_silence:ch-1:%'));
  assert.ok(byPrefix, `must look for the channel's other episodes: ${JSON.stringify(reads)}`);

  assert.equal(writes.find((w) => w.table === 'alerts' && w.op === 'update')?.patch['resolved_at'],
    NOW.toISOString(), 'the superseded episode is closed');
  assert.equal(writes.find((w) => w.table === 'alerts' && w.op === 'insert')?.patch['dedup_key'],
    'channel_silence:ch-1:no_webhooks', 'and the new state is raised');
});

test('DONE-TEST: the cached last_webhook_at survives retention purging the events', async () => {
  // `webhook_events` carries `purge_after`, so the rows proving this channel once worked
  // can be deleted while it is still live. Without the cached column a purge turns "the
  // token died" into "this never worked" — two faults with two different remedies.
  const { db, writes } = stub({
    webhook_events: { data: [], error: null },       // every event purged
    conversations: { data: [{ last_message_at: STALE }], error: null },
    tenant_channels: { data: [{ ...CHANNEL, last_webhook_at: STALE }], error: null },
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'no_webhooks');
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state === 'no_webhooks' && r.verdicts[0].diagnosis.everReceived, true,
    'it HAS received before — the purge must not make this look like a dead subscription');
  // Nothing observed, so nothing is written back over the cached value.
  assert.equal(writes.some((w) => w.table === 'tenant_channels'), false);
});

test('what the events say is written back, so the fact outlives them', async () => {
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  });
  await runSilenceWatch(db, { now: NOW });
  const written = String(writes.find((w) => w.table === 'tenant_channels')?.patch['last_webhook_at']);
  assert.equal(new Date(written).getTime(), new Date(FRESH).getTime());
});

test('an unparseable timestamp is not a time', async () => {
  // `new Date('yesterday')` is NaN, and every comparison against NaN is false — which reads
  // as healthy. It must read as absent instead.
  const { db } = stub({
    webhook_events: { data: [{ received_at: 'yesterday' }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'no_webhooks');
});

test('the threshold is a platform constant, not a per-tenant knob', () => {
  // A per-tenant threshold invites tuning a real alert into silence one channel at a time.
  assert.equal(DEFAULT_THRESHOLD_OPEN_MINUTES, 180);
});

test('DONE-TEST: THE WATCH ASKS FOR DELIVERIES IT COULD NOT ATTRIBUTE, BY PAGE ID', () => {
  // The routed query filters on tenant_id AND channel_id, so an unrouted row — both null —
  // is invisible to it by construction. Matrix spent five days being told its subscription
  // never worked while two deliveries naming its own Page sat in the same table.
  //
  // Asserted on the FILTERS rather than on a verdict, because the filters are the thing
  // that was wrong: a query that forgets `.is('tenant_id', null)` would match routed rows
  // and quietly report every channel as delivering.
  const { db, reads } = stub();
  return runSilenceWatch(db, { now: NOW }).then(() => {
    const unrouted = reads.filter((r) => r.table === 'webhook_events'
      && r.filters.some((f) => f === 'tenant_id is null'));
    assert.equal(unrouted.length, 1, 'exactly one query for unattributed deliveries');
    assert.ok(unrouted[0]?.filters.includes('entry_id=100000000000001'),
      `must look the Page up by entry_id: ${JSON.stringify(unrouted[0]?.filters)}`);
  });
});

// The asymmetry is deliberate and is the reason nothing goes silent: the fault is recorded
// quietly, the RECOVERY still speaks. It is `info` and once per episode, and its body names
// the fault it closes, so a reader learns both that the condition existed and that it is
// over — from one message instead of two. D-063 forbids a recovery nobody is told about.
test('the recovery still pages, so a demoted fault never becomes a silent one', async () => {
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
    alerts: { data: [{ id: 7, kind: 'channel.no_webhooks', dedup_key: 'channel_silence:ch-1:no_webhooks' }], error: null },
  });
  await runSilenceWatch(db, { now: NOW });
  const recovery = writes.find((w) => w.table === 'alerts' && w.patch['kind'] === 'channel.recovered');
  if (recovery !== undefined) {
    assert.equal(recovery.patch['route'], 'now', 'a recovery is still said out loud');
    assert.equal(recovery.patch['repeat_policy'], 'once');
  }
});

// D-128. Under DAILY_REPORT_V2 the recovery joins its fault in the daily report — the fault
// was digest-routed already (founder, 2026-09-20), so an immediate «recovered» was mostly
// news of an outage nobody had been told about. It is still RECORDED, and the report's
// «Yesterday» section lists it with the fault's name in its body, so it is never silent.
test('DONE-TEST: under DAILY_REPORT_V2 the recovery is routed to the daily report; unset, it pages as before', async () => {
  const saved = process.env['DAILY_REPORT_V2'];
  const recoveryRoute = async () => {
    const { db, writes } = stub({
      webhook_events: { data: [{ received_at: FRESH }], error: null },
      conversations: { data: [{ last_message_at: FRESH }], error: null },
      alerts: [
        { data: [{
          id: 42, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
          dedup_key: 'channel_silence:ch-1:no_webhooks', body: 'Page 100000000000001: dead',
          at: '2026-09-01T00:00:00Z', notified_at: '2026-09-01T00:00:00Z',
        }], error: null },
        { data: null, error: null },
        { data: null, error: null },
        { data: { id: 99 }, error: null },
      ],
    });
    await runSilenceWatch(db, { now: NOW });
    const recovery = writes.find((w) => w.table === 'alerts' && w.op === 'insert');
    assert.equal(recovery?.patch['kind'], 'channel.recovered');
    assert.equal(recovery?.patch['repeat_policy'], 'once', 'an event, so the report lists it under «Yesterday»');
    return recovery?.patch['route'];
  };
  try {
    process.env['DAILY_REPORT_V2'] = 'true';
    assert.equal(await recoveryRoute(), 'digest');
    delete process.env['DAILY_REPORT_V2'];
    assert.equal(await recoveryRoute(), 'now');
  } finally {
    if (saved === undefined) delete process.env['DAILY_REPORT_V2']; else process.env['DAILY_REPORT_V2'] = saved;
  }
});
