import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raiseDeliveryExhausted, type ExhaustedInput } from './exhaustedAlert.ts';
import { DRAFT_LOST_KIND } from '../health/answered.ts';

process.env['ALERTS_ENABLED'] = 'false';   // record the alert row, never send

const PAGE = '1520409424715591';
const CUSTOMER_AT = 1790226976290;
const echoRow = (psid: string, at: number) => ({
  raw_payload: {
    id: PAGE, time: at,
    messaging: [{
      sender: { id: PAGE }, recipient: { id: psid }, timestamp: at,
      message: { mid: `m_echo_${at}`, is_echo: true, app_id: 1380702870025418, text: 'Сайн байна уу!' },
    }],
  },
});

/** `webhook_events` answers with `echoes`; `alerts` behaves like an empty table that accepts one insert. */
function stub(echoes: unknown[]) {
  const inserts: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const chain: Record<string, unknown> = {};
    let inserting = false;
    chain['select'] = () => chain;
    for (const op of ['eq', 'gte', 'is', 'in'] as const) chain[op] = () => chain;
    chain['order'] = () => chain;
    chain['limit'] = () => chain;
    chain['insert'] = (row: Record<string, unknown>) => { inserting = true; inserts.push(row); return chain; };
    chain['update'] = () => chain;
    chain['maybeSingle'] = async () => (inserting ? { data: { id: 9 }, error: null } : { data: null, error: null });
    chain['then'] = (res: (v: unknown) => unknown) => res(
      table === 'webhook_events' ? { data: echoes, error: null } : { data: null, error: null },
    );
    return chain;
  };
  return { inserts, reads, db: { from } as never };
}

const INPUT: ExhaustedInput = {
  tenantId: 't-1', eventId: 733, attempts: 3, ageMinutes: 2.3, limitMinutes: 15,
  code: 'worker.reception_retry',
  detail: 'canned_stale: the canned lines have changed since this configuration was published',
  channelId: 'ch-1', deliveryMode: 'shadow', ourAppId: '1562862634970492',
  turns: [{ psid: 'psid-2186', sentAt: new Date(CUSTOMER_AT) }],
};

test('DONE-TEST: THE FOUNDER\'S 44 — SHADOW, ANCESTOR ANSWERED, NOTHING PAGES', async () => {
  // Event 733, 2026-09-24: refused three times with canned_stale while the ancestor
  // answered in 8.7s. It paged «A human can still answer». It must not.
  const { db, inserts } = stub([echoRow('psid-2186', 1790226985024)]);
  assert.equal(await raiseDeliveryExhausted(db, INPUT), 'recorded_lost_draft');
  assert.equal(inserts.length, 1);
  const row = inserts[0]!;
  assert.equal(row['kind'], DRAFT_LOST_KIND);
  assert.equal(row['route'], 'digest', 'counted in the digest, never sent now');
  assert.notEqual(row['severity'], 'critical');
  assert.doesNotMatch(String(row['body']), /human can still answer/);
  assert.match(String(row['body']), /canned_stale/, 'the digest must still say WHY the mirror failed');
  assert.match(String(row['body']), /9s after they wrote/);
});

test('DONE-TEST: LIVE STILL PAGES, AND NAMES THE REAL REFUSAL', async () => {
  const { db, inserts, reads } = stub([echoRow('psid-2186', 1790226985024)]);
  assert.equal(await raiseDeliveryExhausted(db, { ...INPUT, deliveryMode: 'live' }), 'paged');
  const row = inserts[0]!;
  assert.equal(row['kind'], 'webhook.delivery_exhausted');
  assert.equal(row['severity'], 'critical');
  assert.equal(row['route'], 'now');
  assert.match(String(row['body']), /last: worker\.reception_retry — canned_stale/,
    'the founder read «worker.reception_retry» 29 times and it never said «republish»');
  assert.match(String(row['body']), /A human can still answer: about 13 min left/);
  assert.ok(!reads.includes('webhook_events'), 'a live channel pages without consulting echoes');
});

test('DONE-TEST: THE BODY NO LONGER CLAIMS QSTASH HAS NO RETRIES LEFT', async () => {
  // Measured 2026-09-24: 731/733/735/737 each got a fourth delivery ~33 min in.
  const { db, inserts } = stub([]);
  await raiseDeliveryExhausted(db, { ...INPUT, deliveryMode: 'live' });
  assert.doesNotMatch(String(inserts[0]!['body']), /no retries left|nothing else will pick it up/);
  assert.match(String(inserts[0]!['body']), /one retry left, measured at about 33 min/);
});

test('shadow with no reply from the Page still pages, and says so', async () => {
  const { db, inserts } = stub([]);
  assert.equal(await raiseDeliveryExhausted(db, INPUT), 'paged');
  assert.equal(inserts[0]!['severity'], 'critical');
  assert.match(String(inserts[0]!['body']), /in shadow, so Dala AI would not have sent a reply anyway/);
  assert.match(String(inserts[0]!['body']), /incumbent may not have answered/);
});

test('a refusal before the channel was read pages exactly as before', async () => {
  const { db, inserts } = stub([echoRow('psid-2186', 1790226985024)]);
  const r = await raiseDeliveryExhausted(db, {
    ...INPUT, code: 'worker.tenant_unreadable', detail: null, limitMinutes: null,
    channelId: 'ch-1', deliveryMode: null, turns: [],
  });
  assert.equal(r, 'paged');
  assert.match(String(inserts[0]!['body']), /last: worker\.tenant_unreadable\)/);
  assert.match(String(inserts[0]!['body']), /UNKNOWN from here/);
});

test('an unreadable age is never printed as a number', async () => {
  const { db, inserts } = stub([]);
  await raiseDeliveryExhausted(db, { ...INPUT, deliveryMode: 'live', ageMinutes: Number.NaN });
  assert.match(String(inserts[0]!['body']), /Age unreadable/);
  assert.doesNotMatch(String(inserts[0]!['body']), /NaN/);
});
