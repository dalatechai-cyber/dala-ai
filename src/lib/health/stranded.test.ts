import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStrandedEvents, SWEEP_LIMIT, RETRY_GRACE_MINUTES } from './stranded.ts';
import { neverReachedQueue, UNQUEUED_STATES } from '../webhook/events.ts';
import { DEFAULT_REPLY_AGE_LIMIT_MINUTES } from '../worker/freshness.ts';
import type { EnqueueResult } from '../queue/qstash.ts';

process.env['ALERTS_ENABLED'] = 'false';   // record the alert row, never send

const NOW = new Date('2026-09-06T02:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const EVENT = {
  id: 1,
  provider: 'facebook_page',
  dedup_key: '863503883522801:0:311:dalatech',
  tenant_id: 't-1',
  channel_id: 'ch-1',
  state: 'failed',
  received_at: minutesAgo(45),
};

const TENANT_30 = { data: [{ id: 't-1', max_reply_age_minutes: 30 }], error: null };

/** Records every job it is handed, and answers however the test says. */
function queue(result: EnqueueResult = { ok: true, messageId: 'msg-1' }) {
  const jobs: Record<string, unknown>[] = [];
  return {
    jobs,
    enqueue: async (job: Record<string, unknown>): Promise<EnqueueResult> => {
      jobs.push(job);
      return result;
    },
  };
}

/**
 * A db that answers per table, consuming an ordered list where one table is read twice in
 * one run. `alerts` is exactly that: `raiseAlert` reads it (already raised?) and then
 * inserts into it, and a stub that gives both calls the same answer makes every alert look
 * like a duplicate.
 */
function stub(over: Record<string, { data?: unknown; error?: unknown } | { data?: unknown; error?: unknown }[]> = {}) {
  const writes: { table: string; op: string; patch: Record<string, unknown> }[] = [];
  const reads: { table: string; filters: string[] }[] = [];
  const queued: Record<string, { data?: unknown; error?: unknown }[]> = {};
  for (const [table, v] of Object.entries(over)) queued[table] = Array.isArray(v) ? [...v] : [v];

  const answer = (table: string): { data?: unknown; error?: unknown } => {
    const q = queued[table];
    if (q !== undefined && q.length > 0) return q.length === 1 ? q[0]! : q.shift()!;
    if (table === 'alerts') return { data: null, error: null };
    return { data: [], error: null };
  };
  const from = (table: string) => {
    const rec = { table, filters: [] as string[] };
    reads.push(rec);
    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    for (const op of ['eq', 'neq', 'in', 'is', 'lt'] as const) {
      chain[op] = (col: string, val: unknown) => (rec.filters.push(`${op}:${col}=${JSON.stringify(val)}`), chain);
    }
    chain['order'] = () => chain;
    chain['limit'] = (n: number) => (rec.filters.push(`limit=${n}`), chain);
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

/** `alerts` read first (nothing raised), then the insert returns the new row's id. */
const ALERT_OK = [{ data: null, error: null }, { data: { id: 7 }, error: null }];

test('DONE-TEST: an event still inside the limit is RE-PUBLISHED, not just reported', async () => {
  // The whole point. On 2026-09-06 the enqueue was refused, Meta stopped retrying, and
  // nothing existed that would ever hand the event to the queue again.
  const q = queue();
  const { db, writes } = stub({
    webhook_events: [{ data: [{ ...EVENT, received_at: minutesAgo(10) }], error: null }, { data: null, error: null }],
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.swept[0]?.action, 'requeued');
  assert.deepEqual(q.jobs, [{
    provider: 'facebook_page', dedupKey: '863503883522801:0:311:dalatech',
    eventId: 1, tenantId: 't-1', channelId: 'ch-1',
  }]);
  assert.equal(writes.find((w) => w.table === 'webhook_events' && w.op === 'update')?.patch['state'], 'pending_enqueue');
  assert.equal(writes.find((w) => w.table === 'alerts')?.patch['kind'], 'webhook.requeued');
});

test('a refused re-publish leaves the row untouched, so the next run tries again', async () => {
  const q = queue({ ok: false, detail: 'qstash 500' });
  const { db, writes } = stub({
    webhook_events: { data: [{ ...EVENT, received_at: minutesAgo(10) }], error: null },
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept[0]?.action, 'requeue_failed');
  assert.equal(r.swept[0]?.detail, 'qstash 500');
  assert.equal(writes.some((w) => w.table === 'webhook_events' && w.op === 'update'), false);
  assert.match(String(writes.find((w) => w.table === 'alerts')?.patch['body']), /REFUSED: qstash 500/);
});

test('DONE-TEST: past the reply-age limit it is EXPIRED, never re-published', async () => {
  // Re-publishing here would spend a model call to produce a `reply_too_late`.
  const q = queue();
  const { db, writes } = stub({
    webhook_events: [{ data: [EVENT], error: null }, { data: null, error: null }],
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept[0]?.action, 'expired');
  assert.deepEqual(q.jobs, [], 'nothing was queued');

  const alert = writes.find((w) => w.table === 'alerts');
  assert.equal(alert?.patch['kind'], 'webhook.stranded_event');
  assert.equal(alert?.patch['dedup_key'], 'stranded_event:1');
  assert.equal(alert?.patch['severity'], 'critical');
  assert.equal(writes.find((w) => w.table === 'webhook_events' && w.op === 'update')?.patch['state'], 'expired_unqueued');
});

test('a tenant that RAISED its limit gets the rescue, not the tombstone', async () => {
  // 45 minutes old, but this tenant answers up to two hours. Expiring it here would
  // abandon an event the worker would still have replied to.
  const q = queue();
  const { db } = stub({
    webhook_events: [{ data: [EVENT], error: null }, { data: null, error: null }],
    tenants: { data: [{ id: 't-1', max_reply_age_minutes: 120 }], error: null },
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept[0]?.action, 'requeued');
  assert.equal(r.swept[0]?.limitMinutes, 120);
});

test('a routed event with no channel cannot be rebuilt into a job, and waits to expire', async () => {
  const q = queue();
  const { db } = stub({
    webhook_events: [{ data: [{ ...EVENT, channel_id: null, received_at: minutesAgo(10) }], error: null }, { data: null, error: null }],
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.deepEqual(q.jobs, []);
  assert.equal(r.swept[0]?.action, 'expired');
});

test('a tenant row that cannot be read falls back to the default rather than skipping the event', async () => {
  const q = queue();
  const { db } = stub({
    webhook_events: [{ data: [EVENT], error: null }, { data: null, error: null }],
    tenants: { data: [], error: null },        // the tenant simply is not there
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept.length, 1, 'an event whose tenant is missing is more suspicious, not less');
  assert.equal(r.swept[0]?.limitMinutes, DEFAULT_REPLY_AGE_LIMIT_MINUTES);
});

test('DONE-TEST: an unreadable events table FAILS the run — never "0 stranded"', async () => {
  const q = queue();
  const { db } = stub({ webhook_events: { data: null, error: { message: 'connection reset' } } });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.detail : '', /webhook_events unreadable: connection reset/);
});

test('an unreadable tenants table FAILS the run too', async () => {
  const q = queue();
  const { db } = stub({
    webhook_events: { data: [EVENT], error: null },
    tenants: { data: null, error: { message: 'timeout' } },
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.detail : '', /tenants unreadable: timeout/);
});

test('DONE-TEST: an event is NOT expired when the alert could not even be recorded', async () => {
  // `failed` is the one outcome with no `alerts` row. Marking the event would hide a lost
  // customer message behind a state change nobody was told about.
  const q = queue();
  const { db, writes } = stub({
    webhook_events: [{ data: [EVENT], error: null }, { data: null, error: null }],
    tenants: TENANT_30,
    alerts: { data: null, error: { message: 'alerts unreadable' } },
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept[0]?.action, 'expire_deferred');
  assert.equal(writes.some((w) => w.table === 'webhook_events' && w.op === 'update'), false);
});

test('a failed mark is reported, so the run does not claim an event was retired', async () => {
  const q = queue();
  const { db } = stub({
    webhook_events: [{ data: [EVENT], error: null }, { data: null, error: { message: 'update refused' } }],
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept[0]?.action, 'expire_deferred');
  assert.equal(r.swept[0]?.detail, 'update refused');
});

test('an unparseable received_at is expired, never silently skipped', async () => {
  const q = queue();
  const { db } = stub({
    webhook_events: [{ data: [{ ...EVENT, received_at: 'not a date' }], error: null }, { data: null, error: null }],
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  const r = await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  assert.ok(r.ok);
  assert.equal(r.swept[0]?.action, 'expired');
  assert.match(String(r.swept[0]?.ageMinutes), /-1/);
});

test('the query asks for exactly the states neverReachedQueue accepts', async () => {
  // The sweep and the redelivery check are two halves of one definition. A state added to
  // one and not the other is a class of event that nothing ever picks up.
  const q = queue();
  const { db, reads } = stub({ webhook_events: { data: [], error: null } });
  await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  const f = reads.find((r) => r.table === 'webhook_events')?.filters ?? [];
  assert.equal(f.includes(`in:state=${JSON.stringify([...UNQUEUED_STATES])}`), true, f.join(' | '));
  for (const s of UNQUEUED_STATES) assert.equal(neverReachedQueue(s), true, s);
  for (const s of ['pending_enqueue', 'processed', 'shed', 'blocked_no_token', 'standby_not_primary', 'expired_unqueued'])
    assert.equal(neverReachedQueue(s), false, s);
});

test('DONE-TEST: unrouted events are excluded — they are never meant to reach the queue', async () => {
  // Every unrouted event sits in `received` forever by design. Without this filter the
  // sweep would alert on each one and expire it, and the alert that matters would arrive
  // in that stream.
  const q = queue();
  const { db, reads } = stub({ webhook_events: { data: [], error: null } });
  await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  const f = reads.find((r) => r.table === 'webhook_events')?.filters ?? [];
  assert.equal(f.includes('neq:routing="unrouted"'), true, f.join(' | '));
});

test('only unanswered events are candidates, and nothing is touched inside the grace', async () => {
  const q = queue();
  const { db, reads } = stub({ webhook_events: { data: [], error: null } });
  await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  const f = reads.find((r) => r.table === 'webhook_events')?.filters ?? [];
  assert.equal(f.includes('is:replied_at=null'), true, f.join(' | '));
  assert.equal(f.includes(`lt:received_at=${JSON.stringify(minutesAgo(RETRY_GRACE_MINUTES))}`), true, f.join(' | '));
  assert.equal(f.includes(`limit=${SWEEP_LIMIT}`), true, f.join(' | '));
});

test('the alert body carries ids and no customer text', async () => {
  const q = queue();
  const { db, writes } = stub({
    webhook_events: [{ data: [EVENT], error: null }, { data: null, error: null }],
    tenants: TENANT_30,
    alerts: ALERT_OK,
  });
  await sweepStrandedEvents(db, { now: NOW, enqueue: q.enqueue });
  const body = String(writes.find((w) => w.table === 'alerts')?.patch['body'] ?? '');
  assert.match(body, /event 1/);
  assert.match(body, /863503883522801:0:311:dalatech/);
  assert.match(body, /45 min old/);
  assert.match(body, /raw_payload/);
});
