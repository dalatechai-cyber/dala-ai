import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCH_UP_FLAG, catchUpHeldMessages, countWaiting, HELD_FLAG, isCredentialFailure, senderOf, type CatchUpInput,
} from './catchup.ts';
import type { PersonReplied } from '../handover/presend.ts';

// Tara's real halt, 2026-09-26: the token died at 01:09 UTC on the reply to this message.
const NOW = new Date('2026-09-26T03:30:00Z');
const AT = '2026-09-26T01:09:56Z';
const CH = '1fb6d543-3e14-4f42-ab9e-fd39cbc09cd5';
const T = '8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06';
const CONV = 'c7fd22fd-3635-4f47-b574-2e6b625dc494';
const MID = 'm_ATumA1LBUMPvX2fy8kULD6Hctb';
const PSID = '24000000000000001';
const REASON_190 = 'graph 401 code=190 subcode=460 fbtrace=A6WMCOTFPP1q-RyCyr4F9Tu';

type Call = [string, unknown[]];
type Rec = { table: string; calls: Call[] };
type Answer = { data: unknown; error: unknown };

/** Each read is answered by looking at what it asked for, so a test states facts, not call order. */
function fakeDb(answer: (r: Rec) => Answer | undefined) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const rec: Rec = { table, calls: [] };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'gt', 'lt', 'order', 'limit', 'contains', 'is']) {
      chain[m] = (...args: unknown[]) => { rec.calls.push([m, args]); return chain; };
    }
    chain['insert'] = (row: Record<string, unknown>) => { inserts.push({ table, row }); rec.calls.push(['insert', [row]]); return chain; };
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(rec) ?? { data: [], error: null });
    return chain;
  };
  return { db: { from } as never, inserts };
}

const has = (r: Rec, m: string, ...args: unknown[]): boolean =>
  r.calls.some(([k, a]) => k === m && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)));

type World = {
  live?: boolean;
  failed?: { mid: string; reason: string; conv?: string }[];
  flagged?: { id: string; mid: string; at: string }[];
  latest?: { id: string; mid: string; at: string };
  attempted?: boolean;
  laterSent?: boolean;
  event?: boolean;
  unreadable?: string;
};

function world(w: World) {
  const latest = w.latest ?? { id: 'msg-1', mid: MID, at: AT };
  return fakeDb((r) => {
    if (w.unreadable === r.table) return { data: null, error: { message: 'timeout' } };
    if (r.table === 'tenant_channels') {
      return { data: w.live === false ? [] : [{ id: CH, tenant_id: T, meta_app_id: '1380702870025418', automation_texts: [] }], error: null };
    }
    if (r.table === 'outbound_messages' && has(r, 'eq', 'state', 'failed')) {
      return { data: (w.failed ?? [{ mid: MID, reason: REASON_190 }]).map((f) => ({ conversation_id: f.conv ?? CONV, dedup_key: `in:${f.mid}`, refused_reason: f.reason })), error: null };
    }
    if (r.table === 'outbound_messages' && has(r, 'eq', 'state', 'sent')) {
      return { data: w.laterSent === true ? [{ id: 'om-9' }] : [], error: null };
    }
    if (r.table === 'quality_flags' && has(r, 'eq', 'flag', HELD_FLAG)) {
      return { data: (w.flagged ?? []).map((f) => ({ message_id: f.id })), error: null };
    }
    if (r.table === 'quality_flags' && has(r, 'eq', 'flag', CATCH_UP_FLAG)) {
      return { data: w.attempted === true ? [{ id: 1 }] : [], error: null };
    }
    if (r.table === 'messages' && has(r, 'in', 'external_id')) {
      const mids = (r.calls.find(([k, a]) => k === 'in' && a[0] === 'external_id')?.[1][1] ?? []) as string[];
      return { data: mids.map((m) => ({ id: m === MID ? 'msg-1' : `msg-${m}`, conversation_id: CONV, external_id: m, at: AT })), error: null };
    }
    if (r.table === 'messages' && has(r, 'in', 'id')) {
      return { data: (w.flagged ?? []).map((f) => ({ id: f.id, conversation_id: CONV, external_id: f.mid, at: f.at })), error: null };
    }
    if (r.table === 'messages' && has(r, 'order', 'at')) {
      return { data: [{ id: latest.id, external_id: latest.mid, at: latest.at }], error: null };
    }
    if (r.table === 'conversations') return { data: [{ id: CONV, tenant_id: T, channel_id: CH }], error: null };
    if (r.table === 'webhook_events') {
      const mid = latest.mid;
      return {
        data: w.event === false ? [] : [{
          id: 812, provider: 'meta', dedup_key: `page:${mid}`,
          raw_payload: { messaging: [{ sender: { id: PSID }, recipient: { id: '1520409424715591' }, message: { mid, text: 'Сайн уу танай хаяг хаана бэ' } }] },
        }],
        error: null,
      };
    }
    return undefined;
  });
}

function run(w: World, replied: PersonReplied = { replied: false }) {
  const { db, inserts } = world(w);
  const jobs: Parameters<CatchUpInput['enqueue']>[0][] = [];
  const asked: unknown[] = [];
  const out = catchUpHeldMessages(db, {
    now: NOW,
    enqueue: async (job) => { jobs.push(job); return { ok: true, messageId: 'q-1', deduplicated: false }; },
    personReplied: async (_db, input) => { asked.push(input); return replied; },
  });
  return { out, jobs, inserts, asked };
}

test('a 190 or a breaker credential failure is a halt; nothing else is', () => {
  for (const r of [REASON_190, 'graph 401 code=190 subcode=463 fbtrace=x', 'graph 401 code=190 subcode=467 fbtrace=y', 'no credential: secret_undecryptable']) {
    assert.equal(isCredentialFailure(r), true, r);
  }
  for (const r of ['graph 400 code=100 subcode=2018001', 'graph 403 code=1900 subcode=?', 'human_replied_before_send', '', null]) {
    assert.equal(isCredentialFailure(r), false, String(r));
  }
});

test('DONE-TEST: TARA 2026-09-26 — the message whose reply died on the token is answered when the channel is back', async () => {
  const { out, jobs, inserts, asked } = run({});
  const r = await out;
  assert.ok(r.ok);
  assert.deepEqual(r.ok ? r.results.map((x) => x.action) : [], ['enqueued']);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.catchUpMid, MID);
  assert.equal(jobs[0]?.eventId, 812);
  assert.equal(jobs[0]?.dedupKey, `catchup:page:${MID}`, 'its own QStash identity, not the original event\'s');
  assert.equal(jobs[0]?.channelId, CH);
  // The person check was asked about THIS customer, after THEIR message, on THIS event.
  const q = asked[0] as { psid: string; eventId: number; since: Date; ourAppId: string };
  assert.equal(q.psid, PSID);
  assert.equal(q.eventId, 812);
  assert.equal(q.since.toISOString(), new Date(AT).toISOString());
  assert.equal(q.ourAppId, '1380702870025418');
  // One attempt per message, recorded.
  const flag = inserts.find((i) => i.table === 'quality_flags');
  assert.equal(flag?.row['flag'], CATCH_UP_FLAG);
  assert.equal(flag?.row['message_id'], 'msg-1');
});

test('DONE-TEST: a person who answered by hand during the halt wins — nothing is sent (the founder did, 2026-09-26)', async () => {
  const { out, jobs, inserts } = run({}, { replied: true, via: 'echo', detail: 'a person replied in webhook event 813' });
  const r = await out;
  assert.deepEqual(r.ok ? r.results.map((x) => x.action) : [], ['person_replied']);
  assert.equal(jobs.length, 0);
  assert.equal(inserts.length, 0);
});

test('unreadable person check skips this run and does NOT mark the message attempted', async () => {
  const { out, jobs, inserts } = run({}, { replied: 'unreadable', detail: 'webhook_events unreadable' });
  const r = await out;
  assert.deepEqual(r.ok ? r.results.map((x) => x.action) : [], ['unreadable']);
  assert.equal(jobs.length, 0);
  assert.equal(inserts.length, 0, 'tried again next hour');
});

test('older than 24h is never caught up — Meta\'s window has closed', async () => {
  const old = '2026-09-25T03:29:00Z';
  const { out, jobs } = run({ latest: { id: 'msg-1', mid: MID, at: old } });
  const r = await out;
  assert.deepEqual(r.ok ? r.results.map((x) => x.action) : [], ['too_old']);
  assert.equal(jobs.length, 0);
});

test('a later reply, an earlier attempt, or a newer customer message each stop it', async () => {
  for (const [w, action] of [
    [{ laterSent: true }, 'answered_since'],
    [{ attempted: true }, 'already_attempted'],
    [{ latest: { id: 'msg-2', mid: 'm_after_recovery', at: '2026-09-26T03:00:00Z' } }, 'newer_message'],
    [{ event: false }, 'event_missing'],
  ] as const) {
    const { out, jobs } = run(w);
    const r = await out;
    assert.deepEqual(r.ok ? r.results.map((x) => x.action) : [], [action], action);
    assert.equal(jobs.length, 0, action);
  }
});

test('a channel that is not back yet is left alone; the next hourly run sees it', async () => {
  const { out, jobs } = run({ live: false });
  const r = await out;
  assert.ok(r.ok);
  assert.deepEqual(r.ok ? r.results : null, []);
  assert.equal(jobs.length, 0);
});

test('three messages during one halt get ONE reply, to the latest, with the rest in its history', async () => {
  // The first message's reply failed on the token; two more arrived while halted.
  const flagged = [
    { id: 'msg-2', mid: 'm_2', at: '2026-09-26T01:20:00Z' },
    { id: 'msg-3', mid: 'm_3', at: '2026-09-26T01:40:00Z' },
  ];
  const { out, jobs } = run({ flagged, latest: { id: 'msg-3', mid: 'm_3', at: '2026-09-26T01:40:00Z' } });
  const r = await out;
  assert.deepEqual(r.ok ? r.results.map((x) => x.action) : [], ['enqueued']);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.catchUpMid, 'm_3');
});

test('a failed reply that is NOT a credential failure is not a halt', async () => {
  const { out, jobs } = run({ failed: [{ mid: MID, reason: 'graph 400 code=100 subcode=2018001' }] });
  const r = await out;
  assert.deepEqual(r.ok ? r.results : null, []);
  assert.equal(jobs.length, 0);
});

test('an unreadable candidate list refuses the run rather than reporting nobody waiting', async () => {
  for (const table of ['tenant_channels', 'outbound_messages', 'quality_flags']) {
    const { out } = run({ unreadable: table });
    const r = await out;
    assert.equal(r.ok, false, table);
  }
});

test('the halt page counts customers, not failed rows', async () => {
  const { db } = fakeDb((r) => (r.table === 'outbound_messages'
    ? { data: [
      { conversation_id: 'a', refused_reason: REASON_190 },
      { conversation_id: 'a', refused_reason: 'no credential: secret_undecryptable' },
      { conversation_id: 'b', refused_reason: REASON_190 },
      { conversation_id: 'c', refused_reason: 'graph 400 code=100 subcode=?' },
    ], error: null }
    : undefined));
  assert.equal(await countWaiting(db, { tenantId: T, channelId: CH, now: NOW }), 2);
  const broken = fakeDb(() => ({ data: null, error: { message: 'x' } }));
  assert.equal(await countWaiting(broken.db, { tenantId: T, channelId: CH, now: NOW }), null);
});

test('senderOf reads the customer, never an echo', () => {
  const p = { messaging: [
    { sender: { id: 'PAGE' }, recipient: { id: PSID }, message: { mid: MID, is_echo: true } },
    { sender: { id: PSID }, recipient: { id: 'PAGE' }, message: { mid: MID } },
  ] };
  assert.equal(senderOf(p, MID), PSID);
  assert.equal(senderOf(p, 'other'), null);
  assert.equal(senderOf(null, MID), null);
});
