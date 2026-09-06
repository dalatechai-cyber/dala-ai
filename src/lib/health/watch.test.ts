import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSilenceWatch, DEFAULT_THRESHOLD_OPEN_MINUTES } from './watch.ts';

const NOW = new Date('2026-09-04T06:00:00Z');        // 14:00 in Ulaanbaatar
const FRESH = '2026-09-04T05:30:00Z';
const STALE = '2026-09-04T02:00:00Z';                // four open hours ago

const CHANNEL = {
  id: 'ch-1', tenant_id: 't-1', external_id: '100000000000001',
  last_webhook_at: null, went_live_at: '2026-08-01T00:00:00Z',
};

const HOURS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '10:00', closes: '20:00', closed: false }));

/** A db that answers per table and records every write. */
function stub(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const writes: { table: string; op: string; patch: Record<string, unknown> }[] = [];
  const reads: { table: string; filters: string[] }[] = [];
  const answer = (table: string): { data?: unknown; error?: unknown } => {
    if (over[table] !== undefined) return over[table];
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

test('DONE-TEST: a silent channel alerts, once per state per day', async () => {
  const { db, writes } = stub({
    webhook_events: { data: [{ received_at: STALE }], error: null },
    conversations: { data: [{ last_message_at: STALE }], error: null },
  });
  const r = await runSilenceWatch(db, { now: NOW });
  assert.equal(r.ok && r.verdicts[0]?.diagnosis.state, 'no_webhooks');

  const alert = writes.find((w) => w.table === 'alerts');
  assert.equal(alert?.patch['severity'], 'critical');
  assert.equal(alert?.patch['kind'], 'channel.no_webhooks');
  assert.match(String(alert?.patch['dedup_key']), /channel_silence:ch-1:no_webhooks:2026-09-04$/);
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

test('only LIVE channels are watched', async () => {
  const { db, reads } = stub();
  await runSilenceWatch(db, { now: NOW });
  assert.ok(reads.find((c) => c.table === 'tenant_channels')?.filters.includes('delivery_mode=live'));
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
