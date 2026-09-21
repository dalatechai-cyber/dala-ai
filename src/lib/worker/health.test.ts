import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthJob, type HealthEffects } from './health.ts';

process.env['ALERTS_ENABLED'] = 'false';

const NOW = new Date('2026-09-04T06:00:00Z');
const FRESH = '2026-09-04T05:30:00Z';
const STALE = '2026-09-04T02:00:00Z';

const HOURS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '10:00', closes: '20:00', closed: false }));

type Answer = { data?: unknown; error?: unknown };

/**
 * `webhook_events` is read THREE times in one run — the silence watch asks twice (routed
 * events for this channel, then deliveries it could not attribute, by Page id) and the
 * stranded sweep once — so an override may be a LIST, consumed in order. A single value
 * answers every call, as before.
 *
 * The count matters: when the watch gained its second read, this list silently shifted by
 * one and handed the stranded sweep the row meant for the watch. The sweep then reported
 * nothing and the test failed on a count, which is the cheapest possible way to find out.
 */
function effects(over: Record<string, Answer | Answer[]> = {}, verified = true): HealthEffects {
  const queue: Record<string, Answer[]> = {};
  for (const [table, v] of Object.entries(over)) queue[table] = Array.isArray(v) ? [...v] : [v];

  const answer = (table: string): Answer => {
    const q = queue[table];
    if (q !== undefined && q.length > 0) return q.length === 1 ? q[0]! : q.shift()!;
    if (table === 'tenants') return { data: { timezone: 'Asia/Ulaanbaatar' }, error: null };
    if (table === 'tenant_channels') {
      return { data: [{ id: 'ch-1', tenant_id: 't-1', external_id: '1001', last_webhook_at: null, went_live_at: '2026-08-01T00:00:00Z' }], error: null };
    }
    if (table === 'business_hours') return { data: HOURS, error: null };
    if (table === 'alerts') return { data: null, error: null };
    return { data: [], error: null };
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'gte', 'in', 'is', 'like', 'lt', 'order', 'limit', 'insert', 'update', 'upsert']) chain[m] = () => chain;
    chain['maybeSingle'] = async () => answer(table);
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(table));
    return chain;
  };
  return { db: { from } as never, now: NOW, verifySignature: async () => verified, enqueue: async () => ({ ok: true, messageId: 'msg-1', deduplicated: false }) };
}

test('an unsigned call is 401 and reads nothing', async () => {
  const r = await runHealthJob(effects({}, false), { rawBody: '{}', signature: null });
  assert.equal(r.status, 401);
});

test('a healthy run is 200 with the counts', async () => {
  const r = await runHealthJob(effects({
    webhook_events: [{ data: [{ received_at: FRESH }], error: null }, { data: [], error: null }],
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 200);
  assert.equal(r.body['checked'], 1);
  assert.deepEqual(r.body['states'], { healthy: 1 });
  assert.deepEqual(r.body['swept'], {});
});

test('DONE-TEST: a run that cannot read is 503, so QStash retries', async () => {
  // 200 with "checked: 0" is the watchdog failing the way it exists to catch: quietly,
  // with everything green. A 503 costs a redelivery.
  const r = await runHealthJob(effects({ tenant_channels: { data: null, error: { message: 'timeout' } } }),
    { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 503);
});

test('a silent channel still returns 200 — the alert is the output, not the status', async () => {
  // The run SUCCEEDED; it found something. A non-200 here would make QStash retry a
  // condition only a human can clear, re-alerting on every redelivery.
  const r = await runHealthJob(effects({
    webhook_events: [{ data: [{ received_at: STALE }], error: null }, { data: [], error: null }],
    conversations: { data: [{ last_message_at: STALE }], error: null },
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['states'], { no_webhooks: 1 });
});

test('the body carries counts, never the verdicts themselves', async () => {
  // This lands in QStash's delivery log. A channel's health belongs in `channel_health`
  // and in the alert, not in a queue receipt somebody may or may not read.
  const r = await runHealthJob(effects(), { rawBody: '{}', signature: 'sig' });
  assert.deepEqual(Object.keys(r.body).sort(), ['checked', 'secrets', 'states', 'swept']);
  // The expiry clause obeys the same rule one level down: which tenant's credential is
  // running out is in the alert, and a receipt that named it would put a tenant id and a
  // credential kind into a third party's delivery log for no gain.
  const secrets = r.body['secrets'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(secrets).sort(),
    ['alert_failures', 'alerted', 'checked', 'expiring', 'unknown']);
  for (const [k, v] of Object.entries(secrets)) assert.equal(typeof v, 'number', `${k} is a count`);
});

test('DONE-TEST: AN UNREADABLE tenant_secrets IS 503, NOT A CLEAN RUN', async () => {
  // Same rule as the watch and the sweep, and it matters most here: the whole point of the
  // expiry check is that "nothing is expiring" and "I could not ask" were spelled the same
  // way, which is how Matrix went live on a token with forty minutes left (D-109). A 200
  // carrying `secrets.checked: 0` would rebuild that equivalence inside the fix.
  const r = await runHealthJob(effects({
    webhook_events: [{ data: [{ received_at: FRESH }], error: null }, { data: [], error: null }],
    conversations: { data: [{ last_message_at: FRESH }], error: null },
    tenant_secrets: { data: null, error: { message: 'timeout' } },
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 503);
  assert.match(String(r.body['detail']), /tenant_secrets unreadable/);
});

test('DONE-TEST: the stranded sweep runs beside the watch, and its count is reported', async () => {
  // The first real webhook was lost in the gap between the two questions: arriving fine,
  // never queued. A run that only answers the first one reports green through it.
  const r = await runHealthJob(effects({
    webhook_events: [
      // 1. the watch's routed read
      { data: [{ received_at: FRESH }], error: null },
      // 2. the watch's unattributed read, by Page id — nothing, so the diagnosis is unchanged
      { data: [], error: null },
      // 3. the stranded sweep
      { data: [{ id: 1, provider: 'facebook_page', dedup_key: '1001:0:9:dalatech', tenant_id: 't-1', channel_id: 'ch-1', state: 'failed', received_at: STALE }], error: null },
      { data: null, error: null },
    ],
    conversations: { data: [{ last_message_at: FRESH }], error: null },
    tenants: [{ data: { timezone: 'Asia/Ulaanbaatar' }, error: null }, { data: [{ id: 't-1', max_reply_age_minutes: 30 }], error: null }],
    alerts: [{ data: null, error: null }, { data: { id: 7 }, error: null }],
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['states'], { healthy: 1 });
  assert.deepEqual(r.body['swept'], { expired: 1 });
});

test('a sweep that cannot read is 503, exactly like a watch that cannot', async () => {
  const r = await runHealthJob(effects({
    webhook_events: [{ data: [{ received_at: FRESH }], error: null }, { data: null, error: { message: 'timeout' } }],
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 503);
  assert.match(String(r.body['detail']), /webhook_events unreadable/);
});
