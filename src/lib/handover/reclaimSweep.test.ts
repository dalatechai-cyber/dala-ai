import test from 'node:test';
import assert from 'node:assert/strict';
import { reclaimHeldConversations, type ReclaimJob } from './reclaim.ts';

// 13:30 Ulaanbaatar, Friday 2026-09-25. The customer wrote at 11:00, staff last at 10:59.
const NOW = new Date('2026-09-25T05:30:00Z');
const MSG_AT = '2026-09-25T03:00:00Z';
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '10:00', closes: '20:00', closed: false }));

type Answer = { data?: unknown; error?: unknown };

/** Table-driven: each table answers the same thing on every read unless given a list. */
function fakeDb(over: Record<string, Answer | Answer[]> = {}) {
  const reads: { table: string; eq: [string, unknown][] }[] = [];
  const queue: Record<string, Answer[]> = {};
  for (const [t, v] of Object.entries(over)) queue[t] = Array.isArray(v) ? [...v] : [v];
  const defaults: Record<string, Answer> = {
    tenant_channels: { data: [{ id: 'ch-1', tenant_id: 't-1', provider: 'facebook_page' }], error: null },
    conversations: {
      data: [{ id: 'conv-1', tenant_id: 't-1', channel_id: 'ch-1', thread_control: 'human', thread_control_source: 'echo', thread_control_at: '2026-09-25T02:59:00Z' }],
      error: null,
    },
    tenants: { data: { timezone: 'Asia/Ulaanbaatar', default_locale: 'mn-MN' }, error: null },
    business_hours: { data: HOURS, error: null },
    tenant_closures: { data: [], error: null },
    canned_responses: { data: { body: 'Уучлаарай, хүлээлгэчихлээ.', reviewed_at: '2026-09-30T00:00:00Z' }, error: null },
    messages: { data: [{ external_id: 'm_held', at: MSG_AT }], error: null },
    outbound_messages: { data: [], error: null },
    webhook_events: { data: [{ id: 77, provider: 'meta' }], error: null },
  };
  const answer = (t: string): Answer => {
    const q = queue[t];
    if (q !== undefined && q.length > 0) return q.length === 1 ? q[0]! : q.shift()!;
    return defaults[t] ?? { data: null, error: null };
  };
  const from = (table: string) => {
    const rec = { table, eq: [] as [string, unknown][] };
    reads.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'gte', 'order', 'limit', 'contains']) chain[m] = () => chain;
    chain['eq'] = (k: string, v: unknown) => { rec.eq.push([k, v]); return chain; };
    chain['maybeSingle'] = async () => answer(table);
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(table));
    return chain;
  };
  return { db: { from } as never, reads };
}

function sweep(over: Record<string, Answer | Answer[]> = {}, now = NOW) {
  const { db, reads } = fakeDb(over);
  const jobs: ReclaimJob[] = [];
  const run = reclaimHeldConversations(db, {
    now,
    enqueue: async (j) => { jobs.push(j); return { ok: true, messageId: 'q-1', deduplicated: false }; },
  });
  // The sweep pages nobody: a page (`raiseNeedsPerson` / `raiseAlert`) goes through `alerts`.
  const pages = () => reads.filter((x) => x.table === 'alerts');
  return { run, jobs, pages, reads };
}

test('a qualifying chat is handed to the worker as a reclaim of its own held message', async () => {
  const { run, jobs, pages, reads } = sweep();
  const r = await run;
  assert.deepEqual(r, { ok: true, channels: 1, counts: { enqueued: 1 } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.reclaimMid, 'm_held');
  assert.equal(jobs[0]?.eventId, 77);
  assert.equal(jobs[0]?.tenantId, 't-1');
  assert.ok(jobs[0]?.dedupKey.startsWith('reclaim:m_held:'));
  assert.equal(pages().length, 0);
  // Live channels only: shadow never reaches the sweep.
  const channelRead = reads.find((x) => x.table === 'tenant_channels');
  assert.deepEqual(channelRead?.eq, [['delivery_mode', 'live'], ['token_status', 'active']]);
});

test('NO REVIEWED LINE: inert — nothing enqueued, nothing paged, and counted, not a clean zero', async () => {
  for (const canned of [{ data: null, error: null }, { data: { body: 'draft', reviewed_at: null }, error: null }]) {
    const { run, jobs, pages } = sweep({ canned_responses: canned });
    const r = await run;
    assert.deepEqual(r, { ok: true, channels: 1, counts: { no_reviewed_line: 1 } });
    assert.equal(jobs.length, 0);
    assert.equal(pages().length, 0);
  }
  // A window-missed customer is counted under its own name, line or no line, and never paged.
  const late = sweep({ canned_responses: { data: null, error: null } }, new Date('2026-09-26T03:00:00Z'));
  assert.deepEqual((await late.run), { ok: true, channels: 1, counts: { window_missed: 1 } });
  assert.equal(late.pages().length, 0);
});

test('an unreadable line sends nothing and says so', async () => {
  const { run, jobs } = sweep({ canned_responses: { data: null, error: { message: 'reset' } } });
  assert.deepEqual(await run, { ok: true, channels: 1, counts: { reclaim_line_unreadable: 1 } });
  assert.equal(jobs.length, 0);
});

test('STAFF REPLIED after the customer, or the bot did: nothing', async () => {
  const staff = sweep({ conversations: { data: [{ id: 'conv-1', tenant_id: 't-1', channel_id: 'ch-1', thread_control: 'human', thread_control_source: 'echo', thread_control_at: '2026-09-25T04:00:00Z' }], error: null } });
  assert.deepEqual(await staff.run, { ok: true, channels: 1, counts: { staff_replied_after: 1 } });
  const bot = sweep({ outbound_messages: { data: [{ dedup_key: 'in:m_other', state: 'sent' }], error: null } });
  assert.deepEqual(await bot.run, { ok: true, channels: 1, counts: { bot_replied: 1 } });
  assert.equal(staff.jobs.length + bot.jobs.length, 0);
});

test('A REPEAT SWEEP after the send finishes the flip; after the flip there is nothing to find', async () => {
  // The line went out and the flip did not (a crash between them): re-enqueued to flip only.
  const crashed = sweep({ outbound_messages: { data: [{ dedup_key: 'reclaim:m_held', state: 'sent' }], error: null } });
  assert.deepEqual(await crashed.run, { ok: true, channels: 1, counts: { finish_enqueued: 1 } });
  // Flipped: the thread is the bot's and the query for `human` returns nothing.
  const flipped = sweep({ conversations: { data: [], error: null } });
  assert.deepEqual(await flipped.run, { ok: true, channels: 1, counts: {} });
  assert.equal(flipped.jobs.length, 0);
});

test('THE WINDOW: a message past the send limit is counted, never sent and never paged, on every run', async () => {
  // Two hourly runs over the same aged-out message: the receipt counts it each time and
  // nothing is written anywhere, so switching the feature on cannot page a backlog at once.
  for (const now of [new Date('2026-09-26T03:00:00Z'), new Date('2026-09-26T04:00:00Z')]) {
    const { run, jobs, pages, reads } = sweep({}, now);
    assert.deepEqual(await run, { ok: true, channels: 1, counts: { window_missed: 1 } });
    assert.equal(jobs.length, 0);
    assert.equal(pages().length, 0);
    assert.equal(reads.some((x) => x.table === 'webhook_events'), false, 'not even looked up for a job');
  }
});

test('a Meta handover thread (or the bot\'s own media hand-off) is counted, never sent to or paged', async () => {
  for (const source of ['handover', 'passed']) {
    const { run, jobs, pages } = sweep({ conversations: { data: [{ id: 'conv-1', tenant_id: 't-1', channel_id: 'ch-1', thread_control: 'human', thread_control_source: source, thread_control_at: '2026-09-25T02:59:00Z' }], error: null } });
    assert.deepEqual(await run, { ok: true, channels: 1, counts: { meta_holds_thread: 1 } }, source);
    assert.equal(jobs.length, 0, source);
    assert.equal(pages().length, 0, source);
  }
});

test('A TERMINAL REFUSAL the worker wrote stops the sweep: never re-enqueued', async () => {
  // The state `worker/reclaim.ts` leaves when a person replied or a send failed for good.
  for (const run of [1, 2]) {
    const { run: r, jobs } = sweep({ outbound_messages: { data: [{ dedup_key: 'reclaim:m_held', state: 'refused' }], error: null } },
      new Date(NOW.getTime() + run * 3_600_000));
    assert.deepEqual(await r, { ok: true, channels: 1, counts: { reclaim_refused: 1 } });
    assert.equal(jobs.length, 0);
  }
});

test('UNREADABLE: the lists refuse the run; a narrower read skips that chat and sends nothing', async () => {
  assert.equal((await sweep({ tenant_channels: { data: null, error: { message: 'x' } } }).run).ok, false);
  assert.equal((await sweep({ conversations: { data: null, error: { message: 'x' } } }).run).ok, false);
  for (const table of ['tenants', 'business_hours', 'messages', 'outbound_messages', 'webhook_events']) {
    const { run, jobs } = sweep({ [table]: { data: null, error: { message: 'x' } } });
    assert.deepEqual(await run, { ok: true, channels: 1, counts: { unreadable: 1 } }, table);
    assert.equal(jobs.length, 0, table);
  }
});

test('a purged event cannot be re-driven and is counted', async () => {
  const { run, jobs } = sweep({ webhook_events: { data: [], error: null } });
  assert.deepEqual(await run, { ok: true, channels: 1, counts: { event_missing: 1 } });
  assert.equal(jobs.length, 0);
});

test('a conversation on a channel of another tenant is never acted on', async () => {
  const { run, jobs } = sweep({ conversations: { data: [{ id: 'conv-1', tenant_id: 't-2', channel_id: 'ch-1', thread_control: 'human', thread_control_source: 'echo', thread_control_at: '2026-09-25T02:59:00Z' }], error: null } });
  assert.deepEqual(await run, { ok: true, channels: 1, counts: { channel_mismatch: 1 } });
  assert.equal(jobs.length, 0);
});
