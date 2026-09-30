import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countUnconfirmed, reconcileHeldReply, RESEND_MATCH_REASON_PREFIX, IDENTICAL_EXISTS_REASON, matchNotice, ownRepliesIn, sameReplyText, scanParkedReplies, sweepParkedReplies,
  unconfirmedAlertBody, unconfirmedDedupKey, unconfirmedLine, UNCONFIRMED_ALERT_KIND, UNCONFIRMED_PAGE_AT,
} from './reconcile.ts';
import { memoryDb } from '../worker/commentReplay.fixtures.ts';
import { reportWindow } from '../alerts/digest.ts';

const T1 = 'tenant-1';
const T2 = 'tenant-2';
const PAGE = '100000000000001';
const PAGE2 = '200000000000002';
const LINE = 'Сайн байна уу! Дэлгэрэнгүйг хувийн мессежээр хүргэе.';

type Row = Record<string, unknown>;

const noticeEntry = (parent: string, over: Row = {}, page = PAGE): Row => ({
  id: page,
  changes: [{
    field: 'feed',
    value: {
      item: 'comment', verb: 'add', comment_id: `${parent}_reply`, post_id: `${page}_p`, parent_id: parent,
      from: { id: page, name: 'Salon' }, message: LINE, created_time: 1_790_000_000, ...over,
    },
  }],
});

let seq = 0;
function parked(tenant: string, at: string, over: Row = {}): Row {
  seq += 1;
  return {
    id: `om-${seq}`, tenant_id: tenant, channel_id: tenant === T1 ? 'ch-1' : 'ch-2', kind: 'comment_reply',
    dedup_key: `${tenant === T1 ? PAGE : PAGE2}_c${seq}`, body: LINE, state: 'indeterminate',
    refused_reason: 'reply did not complete (AbortError)', created_at: at, attempts: 0, ...over,
  };
}

function receivedFor(e: Row): string {
  const change = ((e['raw_payload'] as Row)['changes'] as Row[])[0] as Row;
  const t = (change['value'] as Row)['created_time'];
  return new Date((typeof t === 'number' ? t : 0) * 1000 + 5_000).toISOString();
}

function db(outbound: Row[], events: Row[] = []) {
  return memoryDb({
    tenants: [{ id: T1, display_name: 'Salon One' }, { id: T2, display_name: 'Salon Two' }],
    tenant_channels: [
      { id: 'ch-1', tenant_id: T1, provider: 'facebook_page', external_id: PAGE },
      { id: 'ch-2', tenant_id: T2, provider: 'facebook_page', external_id: PAGE2 },
      { id: 'ch-ig', tenant_id: T1, provider: 'instagram', external_id: '1784' },
    ],
    outbound_messages: outbound,
    // Received five seconds after Meta stamped it, unless the case says otherwise, so the
    // sweep's `received_at` lookback is exercised rather than compared against `undefined`.
    webhook_events: events.map((e) => ({ received_at: receivedFor(e), ...e })),
    alerts: [],
  });
}

// ---------------------------------------------------------------------------------------------

test('ownRepliesIn: only the Page\'s own adds, in an entry for that Page', () => {
  const e = { id: PAGE, changes: [
    (noticeEntry('p_c1')['changes'] as Row[])[0],
    { field: 'feed', value: { item: 'comment', verb: 'edited', comment_id: 'x', parent_id: 'p_c2', from: { id: PAGE }, message: LINE } },
    { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'y', parent_id: 'p_c3', from: { id: 'someone' }, message: LINE } },
    { field: 'feed', value: { item: 'status', verb: 'add', comment_id: 'z', parent_id: 'p_c4', from: { id: PAGE }, message: LINE } },
    { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'w', parent_id: 'p_c5', from: { id: PAGE } } },
  ] };
  const got = ownRepliesIn(e, PAGE);
  assert.deepEqual(got.map((n) => n.parentId), ['p_c1']);
  assert.equal(got[0]?.createdAt?.getTime(), 1_790_000_000_000);
  assert.deepEqual(ownRepliesIn({ ...e, id: PAGE2 }, PAGE), [], 'an entry for another Page');
  assert.deepEqual(ownRepliesIn(e, ''), []);
  assert.deepEqual(ownRepliesIn(null, PAGE), []);
});

test('sameReplyText: NFC and surrounding whitespace, nothing looser', () => {
  assert.equal(sameReplyText(LINE, ` ${LINE.normalize('NFD')}\n`), true);
  assert.equal(sameReplyText(LINE, LINE.toLocaleUpperCase('mn-MN')), false, 'case is text');
  assert.equal(sameReplyText(LINE, LINE.replace('!', '.')), false);
  assert.equal(sameReplyText(LINE, `${LINE} ${LINE}`), false, 'containment is not equality');
});

test('matchNotice: same parent AND same text AND not stamped well before the draft', () => {
  const row = { dedupKey: 'p_c1', body: LINE, createdAt: new Date(1_790_000_000_000) };
  const n = (over: Partial<{ parentId: string; text: string; createdAt: Date | null }>) =>
    ({ commentId: 'r', parentId: 'p_c1', text: LINE, createdAt: new Date(1_790_000_000_000), ...over });
  assert.notEqual(matchNotice(row, [n({})]), null);
  assert.equal(matchNotice(row, [n({ createdAt: null })]), null, 'no created_time: no match (D-166 review)');
  assert.equal(matchNotice(row, [n({ createdAt: new Date(Number.NaN) })]), null, 'unparseable created_time: no match');
  assert.notEqual(matchNotice(row, [n({ createdAt: new Date(1_790_000_000_000 + 9 * 60_000) })]), null, 'nine minutes after the draft');
  assert.equal(matchNotice(row, [n({ createdAt: new Date(1_790_000_000_000 + 11 * 60_000) })]), null, 'eleven minutes after: not ours');
  assert.equal(matchNotice(row, [n({ createdAt: new Date(1_790_000_000_000 + 3 * 86_400_000) })]), null, 'staff pasting the line days later');
  assert.equal(matchNotice(row, [n({ parentId: 'p_c2' })]), null);
  assert.equal(matchNotice(row, [n({ text: 'Өөр.' })]), null);
  assert.equal(matchNotice(row, [n({ createdAt: new Date(1_790_000_000_000 - 3_600_000) })]), null, 'an hour before our draft is not ours');
  assert.equal(matchNotice(row, [n({ commentId: 'first' } as never), n({ commentId: 'second' } as never)])?.commentId, 'first');
});

// ---------------------------------------------------------------------------------------------

test('sweep: a notice STORED BEFORE the row was parked is still matched later', async () => {
  const row = parked(T1, '2026-09-30T01:00:00.000Z');
  // The notice arrived (and its own job ran) while the row was not yet parked.
  const s = db([row], [{ id: 1, tenant_id: T1, raw_payload: noticeEntry(String(row['dedup_key']), { created_time: Date.parse('2026-09-30T01:00:05Z') / 1000 }) }]);
  const out = await sweepParkedReplies(s.db, { now: new Date('2026-09-30T02:00:00Z') });
  assert.equal(out.ok && out.reconciled, 1);
  const r = s.rows('outbound_messages')[0];
  assert.equal(r?.['state'], 'sent');
  assert.equal(r?.['provider_message_id'], `${String(row['dedup_key'])}_reply`);
  assert.equal(r?.['sent_at'], '2026-09-30T01:00:05.000Z');
});

test('sweep: text mismatch, another tenant\'s event, another Page, Instagram — never reconciled', async () => {
  const a = parked(T1, '2026-09-30T01:00:00.000Z');
  const b = parked(T1, '2026-09-30T01:01:00.000Z');
  const c = parked(T1, '2026-09-30T01:02:00.000Z');
  const d = parked(T1, '2026-09-30T01:03:00.000Z', { channel_id: 'ch-ig' });
  const at = Date.parse('2026-09-30T01:00:30Z') / 1000;
  const s = db([a, b, c, d], [
    { id: 1, tenant_id: T1, raw_payload: noticeEntry(String(a['dedup_key']), { message: `${LINE}!`, created_time: at }) },
    { id: 2, tenant_id: T2, raw_payload: noticeEntry(String(b['dedup_key']), { created_time: at }) },
    { id: 3, tenant_id: T1, raw_payload: noticeEntry(String(c['dedup_key']), { created_time: at }, PAGE2) },
    { id: 4, tenant_id: T1, raw_payload: noticeEntry(String(d['dedup_key']), { created_time: at }) },
  ]);
  const out = await sweepParkedReplies(s.db, { now: new Date('2026-09-30T02:00:00Z') });
  assert.equal(out.ok && out.reconciled, 0);
  assert.equal(out.ok && out.unconfirmed, 4);
  assert.ok(s.rows('outbound_messages').every((r) => r['state'] === 'indeterminate' && r['provider_message_id'] === undefined));
});

test('sweep: sent and sending rows are never read, let alone touched', async () => {
  const sent = parked(T1, '2026-09-30T01:00:00.000Z', { state: 'sent', provider_message_id: 'mine' });
  // A LIVE lease: a worker may be mid-POST. Never read, never counted.
  const sending = parked(T1, '2026-09-30T01:00:00.000Z', { state: 'sending', lease_until: '2026-09-30T02:00:30.000Z' });
  const s = db([sent, sending], [
    { id: 1, tenant_id: T1, raw_payload: noticeEntry(String(sent['dedup_key'])) },
    { id: 2, tenant_id: T1, raw_payload: noticeEntry(String(sending['dedup_key'])) },
  ]);
  const out = await sweepParkedReplies(s.db, { now: new Date('2026-09-30T02:00:00Z') });
  assert.equal(out.ok && out.reconciled, 0);
  assert.equal(s.rows('outbound_messages')[0]?.['provider_message_id'], 'mine');
  assert.equal(s.rows('outbound_messages')[1]?.['state'], 'sending');
  assert.equal(out.ok && out.unconfirmed, 0, 'a live sending row is not unconfirmed');
});

test('D-166 review: a sending row whose lease EXPIRED (run killed after the POST) is treated as parked', async () => {
  const at = Date.parse('2026-09-30T01:00:03Z') / 1000;
  const killedProvable = parked(T1, '2026-09-30T01:00:00.000Z', { state: 'sending', lease_until: '2026-09-30T01:01:00.000Z' });
  const killedSilent = parked(T1, '2026-09-30T01:05:00.000Z', { state: 'sending', lease_until: '2026-09-30T01:06:00.000Z' });
  const live = parked(T1, '2026-09-30T01:59:50.000Z', { state: 'sending', lease_until: '2026-09-30T02:00:50.000Z' });
  const s = db([killedProvable, killedSilent, live], [
    { id: 1, tenant_id: T1, received_at: '2026-09-30T01:00:20.000Z', raw_payload: noticeEntry(String(killedProvable['dedup_key']), { created_time: at }) },
  ]);
  const now = new Date('2026-09-30T02:00:00Z');
  // The daily report counts the killed row that no notice proves, and not the live one.
  const u = await countUnconfirmed(s.db, { since: new Date('2026-09-29T16:00:00Z'), until: now, now });
  assert.deepEqual(u.ok ? u.byTenant : null, [{ tenant: 'Salon One', count: 1 }]);
  const out = await sweepParkedReplies(s.db, { now });
  assert.equal(out.ok && out.reconciled, 1);
  assert.equal(out.ok && out.unconfirmed, 1);
  assert.equal(s.rows('outbound_messages')[0]?.['state'], 'sent');
  assert.equal(s.rows('outbound_messages')[1]?.['state'], 'sending', 'unproven: left, counted');
  assert.equal(s.rows('outbound_messages')[2]?.['state'], 'sending', 'live lease: untouched');
});

test('D-166 review: the sweep reads notices once per channel, not once per parked row', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => parked(i % 2 === 0 ? T1 : T2, `2026-09-30T01:0${i}:00.000Z`));
  const s = db(rows);
  let reads = 0;
  const from = (table: string) => {
    if (table === 'webhook_events') reads += 1;
    return (s.db as unknown as { from: (t: string) => unknown }).from(table);
  };
  const out = await sweepParkedReplies({ from } as never, { now: new Date('2026-09-30T02:00:00Z') });
  assert.equal(out.ok && out.unconfirmed, 6);
  assert.equal(reads, 2, 'two channels, two reads');
});

test('D-166 review: the same line pasted by staff days later never reconciles', async () => {
  const row = parked(T1, '2026-09-29T01:00:00.000Z');
  const s = db([row], [{
    id: 1, tenant_id: T1, received_at: '2026-09-30T01:00:00.000Z',
    raw_payload: noticeEntry(String(row['dedup_key']), { created_time: Date.parse('2026-09-30T01:00:00Z') / 1000 }),
  }]);
  const out = await sweepParkedReplies(s.db, { now: new Date('2026-09-30T02:00:00Z') });
  assert.equal(out.ok && out.reconciled, 0);
  assert.equal(s.rows('outbound_messages')[0]?.['state'], 'indeterminate');
});

// ---------------------------------------------------------------------------------------------

test('page: only on the third unconfirmed in one Ulaanbaatar day, once per tenant per day, across UB midnight', async () => {
  const prev = process.env['ALERTS_ENABLED'];
  process.env['ALERTS_ENABLED'] = 'false'; // the row is recorded, nothing reaches Telegram
  try {
    // UB is UTC+8: 2026-09-30 00:00 UB is 2026-09-29T16:00Z.
    const rows = [
      parked(T1, '2026-09-29T15:50:00.000Z'), // 23:50 on the 29th
      parked(T1, '2026-09-29T15:58:00.000Z'), // 23:58 on the 29th
      parked(T1, '2026-09-29T16:05:00.000Z'), // 00:05 on the 30th
      parked(T1, '2026-09-29T16:20:00.000Z'), // 00:20 on the 30th
      parked(T2, '2026-09-29T17:00:00.000Z'),
      parked(T2, '2026-09-29T17:01:00.000Z'),
    ];
    const s = db(rows);
    const now = new Date('2026-09-30T02:00:00Z');
    const alerts = () => s.rows('alerts').filter((a) => a['kind'] === UNCONFIRMED_ALERT_KIND);

    let out = await sweepParkedReplies(s.db, { now });
    assert.equal(out.ok && out.unconfirmed, 6);
    assert.equal(alerts().length, 0, 'two a day each: the day boundary splits T1\'s four');

    // A third on the 29th, drafted at 23:59 UB.
    s.rows('outbound_messages').push(parked(T1, '2026-09-29T15:59:00.000Z'));
    out = await sweepParkedReplies(s.db, { now });
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0]?.['dedup_key'], unconfirmedDedupKey(T1, '2026-09-29'));
    assert.equal(alerts()[0]?.['repeat_policy'], 'daily');
    assert.equal(alerts()[0]?.['route'], 'now');
    assert.match(String(alerts()[0]?.['body']), /^Salon One: 3 public comment replies on 2026-09-29 \(Ulaanbaatar\)/);
    assert.match(String(alerts()[0]?.['body']), /2026-09-29 23:50 UB time/);
    assert.doesNotMatch(String(alerts()[0]?.['body']), /T\d\d:\d\d/, 'never a raw ISO time');

    // A fourth on the same day and the next hourly run: no second page.
    s.rows('outbound_messages').push(parked(T1, '2026-09-29T15:59:30.000Z'));
    await sweepParkedReplies(s.db, { now: new Date('2026-09-30T03:00:00Z') });
    assert.equal(alerts().length, 1, 'once per tenant per day');

    // The third on the 30th pages again: a new day is a new question.
    s.rows('outbound_messages').push(parked(T1, '2026-09-29T20:00:00.000Z'));
    await sweepParkedReplies(s.db, { now: new Date('2026-09-30T04:00:00Z') });
    assert.equal(alerts().length, 2);
    assert.equal(alerts()[1]?.['dedup_key'], unconfirmedDedupKey(T1, '2026-09-30'));
    assert.equal(UNCONFIRMED_PAGE_AT, 3);
  } finally {
    if (prev === undefined) delete process.env['ALERTS_ENABLED']; else process.env['ALERTS_ENABLED'] = prev;
  }
});

test('page: a reply parked less than ten minutes ago is not unconfirmed yet', async () => {
  const s = db([
    parked(T1, '2026-09-30T01:49:00.000Z'), parked(T1, '2026-09-30T01:52:00.000Z'), parked(T1, '2026-09-30T01:55:00.000Z'),
  ]);
  const scan = await scanParkedReplies(s.db, {
    since: new Date('2026-09-29T16:00:00Z'), until: new Date('2026-09-30T02:00:00Z'), now: new Date('2026-09-30T02:00:00Z'), write: true,
  });
  assert.equal(scan.ok && scan.unconfirmed.length, 1);
  assert.equal(scan.ok && scan.young, 2);
});

test('page: a failing alert store never throws out of the sweep', async () => {
  const s = db([parked(T1, '2026-09-30T00:00:00.000Z'), parked(T1, '2026-09-30T00:01:00.000Z'), parked(T1, '2026-09-30T00:02:00.000Z')]);
  const from = (table: string) => {
    if (table === 'alerts') throw new Error('socket hang up');
    return (s.db as unknown as { from: (t: string) => unknown }).from(table);
  };
  const out = await sweepParkedReplies({ from } as never, { now: new Date('2026-09-30T02:00:00Z') });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.pageFailures, 1);
});

// ---------------------------------------------------------------------------------------------

test('daily report: the reported UB day only, read-only, and a provable reply is not unconfirmed', async () => {
  // Runs 00:05 UB on 2026-10-01 and reports 2026-09-30 (16:00Z on the 29th to 16:00Z on the 30th).
  const now = new Date('2026-09-30T16:05:00Z');
  const provable = parked(T1, '2026-09-30T03:00:00.000Z');
  const s = db([
    parked(T1, '2026-09-29T15:59:00.000Z'), // 23:59 on the 29th: another day
    parked(T1, '2026-09-29T16:01:00.000Z'), // 00:01 on the 30th
    parked(T1, '2026-09-30T10:00:00.000Z'),
    provable,
    parked(T2, '2026-09-30T12:00:00.000Z'),
    parked(T1, '2026-09-30T16:01:00.000Z'), // 00:01 on the 1st: tomorrow's
  ], [{ id: 9, tenant_id: T1, raw_payload: noticeEntry(String(provable['dedup_key']), { created_time: Date.parse('2026-09-30T03:00:10Z') / 1000 }) }]);
  const w = reportWindow(now);
  assert.equal(w.date, '2026-09-30');
  const u = await countUnconfirmed(s.db, { since: new Date(w.since), until: new Date(w.until), now });
  assert.equal(u.ok, true);
  assert.deepEqual(u.ok ? [...u.byTenant].sort((a, b) => (a.tenant < b.tenant ? -1 : 1)) : null,
    [{ tenant: 'Salon One', count: 2 }, { tenant: 'Salon Two', count: 1 }]);
  assert.equal(s.rows('outbound_messages').find((r) => r['id'] === provable['id'])?.['state'], 'indeterminate', 'the report never writes');
  assert.equal(unconfirmedLine(u), 'Public comment replies unconfirmed (yesterday): Salon One 2, Salon Two 1 — check these threads by hand');
});

test('daily report: a clean day says none, an unreadable one says UNREADABLE, never zero', async () => {
  assert.equal(unconfirmedLine({ ok: true, byTenant: [], capped: false }), 'Public comment replies unconfirmed (yesterday): none');
  const broken = { from: () => ({
    select() { return this; }, eq() { return this; }, gte() { return this; }, lt() { return this; }, order() { return this; },
    limit() { return Promise.resolve({ data: null, error: { message: 'boom' } }); },
  }) };
  const u = await countUnconfirmed(broken as never, { since: new Date(0), until: new Date(1), now: new Date(1) });
  assert.equal(u.ok, false);
  assert.match(unconfirmedLine(u), /UNREADABLE/);
  assert.doesNotMatch(unconfirmedLine(u), /none|: 0/);
});

test('alert body: ids and UB times only, and a long list is cut', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ rowId: `r${i}`, tenantId: T1, dedupKey: `p_c${i}`, createdAt: new Date(Date.UTC(2026, 8, 30, 1, i)) }));
  const body = unconfirmedAlertBody({ tenantName: 'Salon One', day: '2026-09-30', rows });
  assert.match(body, /7 public comment replies/);
  assert.match(body, /2026-09-30 09:00 UB time, under comment p_c0/);
  assert.match(body, /…and 2 more/);
  assert.doesNotMatch(body, new RegExp(LINE));
});

test('D-166 re-review: the check before a re-send has no upper bound; in the window it is sent (probably ours), past it refused', async () => {
  const drafted = Date.parse('2026-09-28T01:00:00Z');
  for (const [offsetMs, want] of [[60_000, 'sent'], [3 * 86_400_000, 'refused']] as const) {
    const row = parked(T1, new Date(drafted).toISOString(), { state: 'sending', attempts: 1 });
    const s = db([row], [{
      id: 1, tenant_id: T1,
      raw_payload: noticeEntry(String(row['dedup_key']), { comment_id: 'pasted', created_time: (drafted + offsetMs) / 1000 }),
    }]);
    const out = await reconcileHeldReply(s.db, { tenantId: T1, rowId: String(row['id']), pageId: PAGE, now: new Date(drafted + offsetMs + 60_000) });
    assert.deepEqual(out, { ok: true, outcome: want });
    const r = s.rows('outbound_messages')[0];
    assert.equal(r?.['state'], want);
    if (want === 'sent') {
      assert.equal(r?.['provider_message_id'], 'pasted');
      assert.ok(String(r?.['refused_reason']).startsWith(RESEND_MATCH_REASON_PREFIX), 'marked as not proven');
    } else {
      assert.equal(r?.['provider_message_id'] ?? null, null);
      assert.ok(String(r?.['refused_reason']).startsWith(IDENTICAL_EXISTS_REASON));
    }
  }
});

test('D-166 re-review: the arrival path leaves a FAILED row alone', async () => {
  const { reconcileFromEntry } = await import('./reconcile.ts');
  const row = parked(T1, '2026-09-28T01:00:00.000Z', { state: 'failed' });
  const s = db([row]);
  const out = await reconcileFromEntry(s.db, {
    tenantId: T1, channelId: 'ch-1', pageId: PAGE, now: new Date('2026-09-28T01:01:00Z'),
    rawPayload: noticeEntry(String(row['dedup_key']), { created_time: Date.parse('2026-09-28T01:00:10Z') / 1000 }),
  });
  assert.deepEqual(out, { ok: true, reconciled: 0, mismatched: 0 });
  assert.equal(s.rows('outbound_messages')[0]?.['state'], 'failed');
});
