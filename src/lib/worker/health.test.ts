import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthJob, type HealthEffects } from './health.ts';

const NOW = new Date('2026-09-04T06:00:00Z');
const FRESH = '2026-09-04T05:30:00Z';
const STALE = '2026-09-04T02:00:00Z';

const HOURS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '10:00', closes: '20:00', closed: false }));

function effects(over: Record<string, { data?: unknown; error?: unknown }> = {}, verified = true): HealthEffects {
  const answer = (table: string): { data?: unknown; error?: unknown } => {
    if (over[table] !== undefined) return over[table];
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
    for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'insert', 'update', 'upsert']) chain[m] = () => chain;
    chain['maybeSingle'] = async () => answer(table);
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(table));
    return chain;
  };
  return { db: { from } as never, now: NOW, verifySignature: async () => verified };
}

test('an unsigned call is 401 and reads nothing', async () => {
  const r = await runHealthJob(effects({}, false), { rawBody: '{}', signature: null });
  assert.equal(r.status, 401);
});

test('a healthy run is 200 with the counts', async () => {
  const r = await runHealthJob(effects({
    webhook_events: { data: [{ received_at: FRESH }], error: null },
    conversations: { data: [{ last_message_at: FRESH }], error: null },
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 200);
  assert.equal(r.body['checked'], 1);
  assert.deepEqual(r.body['states'], { healthy: 1 });
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
    webhook_events: { data: [{ received_at: STALE }], error: null },
    conversations: { data: [{ last_message_at: STALE }], error: null },
  }), { rawBody: '{}', signature: 'sig' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['states'], { no_webhooks: 1 });
});

test('the body carries counts, never the verdicts themselves', async () => {
  // This lands in QStash's delivery log. A channel's health belongs in `channel_health`
  // and in the alert, not in a queue receipt somebody may or may not read.
  const r = await runHealthJob(effects(), { rawBody: '{}', signature: 'sig' });
  assert.deepEqual(Object.keys(r.body).sort(), ['checked', 'states']);
});
