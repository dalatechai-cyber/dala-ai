import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SCAN_LIMIT, pageAnsweredAll, routeUnansweredAlert, turnsOf } from './answered.ts';

// Shaped exactly like the stored entries of events 733 (customer) and 734 (the ancestor's
// echo) on 2026-09-24: ONE entry per row, `messaging` at the top, Meta's own millisecond
// `timestamp`, and `app_id` as a NUMBER on the echo.
const PAGE = '1520409424715591';
const ANCESTOR_APP = 1380702870025418;
const OUR_APP = '1562862634970492';
const CUSTOMER_AT = 1790226976290;

function inbound(psid: string, at: number, text = 'Сайн байна уу') {
  return { id: PAGE, time: at, messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: at, message: { mid: `m_in_${at}`, text } }] };
}
function echo(psid: string, at: number, appId: number | string | null = ANCESTOR_APP) {
  const message: Record<string, unknown> = { mid: `m_echo_${at}`, is_echo: true, text: 'Сайн байна уу!' };
  if (appId !== null) message['app_id'] = appId;
  return { id: PAGE, time: at, messaging: [{ sender: { id: PAGE }, recipient: { id: psid }, timestamp: at, message }] };
}

/** Answers `webhook_events` with the given payloads; records the filters it was asked for. */
function stub(payloads: unknown[] | { error: string }) {
  const filters: string[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    for (const op of ['eq', 'gte', 'in'] as const) {
      chain[op] = (col: string, val: unknown) => (filters.push(`${table}.${op}:${col}=${String(val)}`), chain);
    }
    chain['order'] = () => chain;
    chain['limit'] = (n: number) => (filters.push(`${table}.limit=${n}`), chain);
    chain['then'] = (res: (v: unknown) => unknown) => res(
      Array.isArray(payloads)
        ? { data: payloads.map((p) => ({ raw_payload: p })), error: null }
        : { data: null, error: { message: payloads.error } },
    );
    return chain;
  };
  return { filters, db: { from } as never };
}

const TURN = { psid: 'psid-2186', sentAt: new Date(CUSTOMER_AT) };
const BASE = { tenantId: 't-1', channelId: 'ch-1', ourAppId: OUR_APP };

test('DONE-TEST: THE MEASURED CASE — THE ANCESTOR ANSWERED IN 8.7s, SO NOBODY WAS WAITING', async () => {
  // 733 → 734 on 2026-09-24, by Meta's clock: 1790226976290 → 1790226985024.
  const { db } = stub([inbound('psid-2186', CUSTOMER_AT), echo('psid-2186', 1790226985024)]);
  const r = await pageAnsweredAll(db, { ...BASE, turns: [TURN] });
  assert.equal(r.verdict, 'answered');
  assert.ok(r.verdict === 'answered' && Math.abs(r.slowestSeconds - 8.734) < 0.001);
});

test('DONE-TEST: A REPLY TO SOMEBODY ELSE IS NOT A REPLY TO THIS CUSTOMER', async () => {
  const { db } = stub([echo('psid-OTHER', CUSTOMER_AT + 5_000)]);
  assert.deepEqual(await pageAnsweredAll(db, { ...BASE, turns: [TURN] }), { verdict: 'unanswered' });
});

test('DONE-TEST: A REPLY SENT BEFORE THE CUSTOMER WROTE DID NOT ANSWER THEM', async () => {
  // The previous turn's reply is in the scan window (it has slack for the receipt hop), and
  // it must not be read as the answer to a message written after it — D-062's "evidence
  // about a window has to fall inside that window", one table over.
  const { db } = stub([echo('psid-2186', CUSTOMER_AT - 1)]);
  assert.deepEqual(await pageAnsweredAll(db, { ...BASE, turns: [TURN] }), { verdict: 'unanswered' });
});

test('DONE-TEST: AN ECHO FROM OUR OWN APP IS NOT SOMEBODY ELSE ANSWERING', async () => {
  const { db } = stub([echo('psid-2186', CUSTOMER_AT + 3_000, OUR_APP)]);
  assert.deepEqual(await pageAnsweredAll(db, { ...BASE, turns: [TURN] }), { verdict: 'unanswered' });
});

test('a person typing in the inbox (no app id) IS the Page answering', async () => {
  const { db } = stub([echo('psid-2186', CUSTOMER_AT + 60_000, null)]);
  assert.equal((await pageAnsweredAll(db, { ...BASE, turns: [TURN] })).verdict, 'answered');
});

test('EVERY turn in the event must be answered, not just one', async () => {
  const second = { psid: 'psid-2186', sentAt: new Date(CUSTOMER_AT + 30_000) };
  const { db } = stub([echo('psid-2186', CUSTOMER_AT + 5_000)]);
  assert.deepEqual(await pageAnsweredAll(db, { ...BASE, turns: [TURN, second] }), { verdict: 'unanswered' });
});

test('DONE-TEST: AN UNREADABLE SCAN IS UNDETERMINED, NEVER ANSWERED', async () => {
  const { db } = stub({ error: 'boom' });
  const r = await pageAnsweredAll(db, { ...BASE, turns: [TURN] });
  assert.equal(r.verdict, 'undetermined');
});

test('DONE-TEST: A TRUNCATED SCAN THAT FOUND NOTHING IS UNDETERMINED, NOT UNANSWERED', async () => {
  const noise = Array.from({ length: ANSWER_SCAN_LIMIT }, (_, i) => inbound(`psid-${i}`, CUSTOMER_AT + i));
  const { db } = stub(noise);
  assert.equal((await pageAnsweredAll(db, { ...BASE, turns: [TURN] })).verdict, 'undetermined');
});

test('a turn with no timestamp cannot be compared, so it is undetermined', async () => {
  const { db } = stub([echo('psid-2186', CUSTOMER_AT + 5_000)]);
  const r = await pageAnsweredAll(db, { ...BASE, turns: [{ psid: 'psid-2186', sentAt: new Date(Number.NaN) }] });
  assert.equal(r.verdict, 'undetermined');
});

test('the scan is bounded by the channel and starts before the message, for the receipt hop', async () => {
  const { db, filters } = stub([]);
  await pageAnsweredAll(db, { ...BASE, turns: [TURN] });
  assert.ok(filters.includes('webhook_events.eq:channel_id=ch-1'));
  assert.ok(filters.includes('webhook_events.eq:tenant_id=t-1'));
  const gte = filters.find((f) => f.startsWith('webhook_events.gte:received_at='));
  assert.ok(gte !== undefined && new Date(gte.split('=')[1]!).getTime() < CUSTOMER_AT);
});

test('turnsOf reads the customer and Meta\'s timestamp out of a stored entry', () => {
  assert.deepEqual(turnsOf(inbound('psid-2186', CUSTOMER_AT)), [TURN]);
  assert.deepEqual(turnsOf(echo('psid-2186', CUSTOMER_AT)), [], 'an echo is not a customer turn');
});

// ── The routing decision ─────────────────────────────────────────────────────────────

test('DONE-TEST: SHADOW + ANSWERED → DO NOT PAGE', async () => {
  const { db } = stub([echo('psid-2186', 1790226985024)]);
  const r = await routeUnansweredAlert(db, { ...BASE, deliveryMode: 'shadow', turns: [TURN] });
  assert.equal(r.page, false);
});

test('DONE-TEST: LIVE ALWAYS PAGES, WITHOUT EVEN LOOKING — DALA AI IS THE ANSWER THERE', async () => {
  const { db, filters } = stub([echo('psid-2186', 1790226985024)]);
  const r = await routeUnansweredAlert(db, { ...BASE, deliveryMode: 'live', turns: [TURN] });
  assert.deepEqual(r, { page: true, note: null });
  assert.deepEqual(filters, [], 'a live channel must not consult the echoes at all');
});

test('DONE-TEST: AN UNKNOWN MODE PAGES EXACTLY AS BEFORE', async () => {
  // The job refused before reading the channel. It may be live, so this is today's alert.
  const { db } = stub([echo('psid-2186', 1790226985024)]);
  assert.deepEqual(await routeUnansweredAlert(db, { ...BASE, deliveryMode: null, turns: [TURN] }), { page: true, note: null });
  assert.deepEqual(
    await routeUnansweredAlert(db, { ...BASE, channelId: null, deliveryMode: 'shadow', turns: [TURN] }),
    { page: true, note: null },
  );
});

test('shadow + nobody answered still pages, and says the incumbent may be down too', async () => {
  const { db } = stub([]);
  const r = await routeUnansweredAlert(db, { ...BASE, deliveryMode: 'shadow', turns: [TURN] });
  assert.equal(r.page, true);
  assert.ok(r.page && r.note !== null && /incumbent may not have answered/.test(r.note));
});

test('shadow + unreadable still pages, and says the check could not run', async () => {
  const { db } = stub({ error: 'boom' });
  const r = await routeUnansweredAlert(db, { ...BASE, deliveryMode: 'shadow', turns: [TURN] });
  assert.ok(r.page && r.note !== null && /could not be checked/.test(r.note));
});
