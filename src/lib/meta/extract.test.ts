import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInboundMessages } from './extract.ts';

const entry = (messaging: unknown[]) => ({ id: '1234', time: 1, messaging });
const textEvent = {
  sender: { id: 'psid-1' }, recipient: { id: '1234' }, timestamp: 1788480000000,
  message: { mid: 'mid.1', text: 'Үнэ хэд вэ?' },
};

test('a plain text message is extracted, NFC-normalised', () => {
  const r = extractInboundMessages(entry([{ ...textEvent, message: { mid: 'mid.1', text: 'Ёлка'.normalize('NFD') } }]));
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]?.text, 'Ёлка');
  assert.equal(r.messages[0]?.senderId, 'psid-1');
  assert.equal(r.messages[0]?.externalId, 'mid.1');
});

test('OUR OWN ECHO IS SKIPPED — answering it is a loop that bills', () => {
  // Meta delivers our outbound messages back to us. This is the single most expensive
  // thing that can go wrong in this file.
  const r = extractInboundMessages(entry([{ ...textEvent, message: { ...textEvent.message, is_echo: true } }]));
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.skipped, ['echo']);
});

test('delivery and read receipts are status events, not customer turns', () => {
  const r = extractInboundMessages(entry([
    { sender: { id: 'p' }, delivery: { mids: ['mid.1'] } },
    { sender: { id: 'p' }, read: { watermark: 1 } },
  ]));
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.skipped, ['status_event', 'status_event']);
});

test('a postback is a different product surface and V1 does not ship one', () => {
  const r = extractInboundMessages(entry([{ sender: { id: 'p' }, postback: { payload: 'X' } }]));
  assert.deepEqual(r.skipped, ['postback']);
});

test('an attachment with no text is reported, never answered blind', () => {
  const r = extractInboundMessages(entry([
    { ...textEvent, message: { mid: 'mid.2', attachments: [{ type: 'image' }] } },
  ]));
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.skipped, ['no_text']);
});

test('EVERY skip is reported — "we chose not to answer" differs from "it vanished"', () => {
  const r = extractInboundMessages(entry([
    textEvent,
    { ...textEvent, message: { ...textEvent.message, is_echo: true } },
    { sender: { id: 'p' }, read: { watermark: 1 } },
    'not an object',
  ]));
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.skipped, ['echo', 'status_event', 'malformed']);
});

test('ONE ENTRY MAY CARRY SEVERAL MESSAGES, and all of them are returned', () => {
  // Meta batches. Answering only the first would silently drop a customer's question,
  // which is the thing this platform refuses to do anywhere else.
  const r = extractInboundMessages(entry([
    textEvent,
    { ...textEvent, timestamp: 1788480001000, message: { mid: 'mid.2', text: 'Хэдэн цагт вэ?' } },
  ]));
  assert.deepEqual(r.messages.map((m) => m.externalId), ['mid.1', 'mid.2']);
});

test('a message with no sender is malformed, not a message from nobody', () => {
  const r = extractInboundMessages(entry([{ timestamp: 1, message: { mid: 'm', text: 'x' } }]));
  assert.deepEqual(r.skipped, ['malformed']);
});

test('a missing timestamp yields an invalid date, for the caller to substitute', () => {
  // NOT epoch zero: 1970 would make every such event look stale and be dropped — a
  // silent, total outage for whatever produced it.
  const r = extractInboundMessages(entry([{ ...textEvent, timestamp: undefined }]));
  assert.equal(Number.isNaN(r.messages[0]?.sentAt.getTime()), true);
});

test('an entry with no messaging array yields nothing and reports nothing', () => {
  for (const bad of [null, undefined, {}, { messaging: 'x' }, 'string', 42]) {
    assert.deepEqual(extractInboundMessages(bad), { messages: [], skipped: [], standby: 0 });
  }
});

// ---------------------------------------------------------------------------
// The secondary-receiver case (§3.7)
// ---------------------------------------------------------------------------

test('DONE-TEST: entry.standby is COUNTED, not silently dropped', () => {
  // When a Page has the Page Inbox app as primary receiver — the default for many Pages,
  // and the state a Page enters the moment anyone touches "Automated responses" — Meta
  // stops populating `entry.messaging` and populates `entry.standby` instead.
  //
  // Until this existed the entry above and this one produced IDENTICAL output: an empty
  // extraction with no skip recorded. The webhook is well-formed, correctly signed and
  // correctly routed; we return 200; Reception answers nobody; and every health signal
  // stays green. That is §3.7's whole point, and the only symptom is the salon phoning
  // the founder.
  const r = extractInboundMessages({
    id: 'PAGE', time: 1,
    standby: [
      { sender: { id: 'PSID1' }, recipient: { id: 'PAGE' }, timestamp: 1, message: { mid: 'm1', text: 'Сайн байна уу' } },
      { sender: { id: 'PSID2' }, recipient: { id: 'PAGE' }, timestamp: 2, message: { mid: 'm2', text: 'Үнэ хэд вэ?' } },
    ],
  });
  assert.equal(r.standby, 2);
  assert.deepEqual(r.messages, [], 'we may not answer as a secondary receiver');
  assert.deepEqual(r.skipped, [], 'and it is not a per-message skip — it is a channel fault');
});

test('a normal entry reports standby 0, so the signal means something', () => {
  const r = extractInboundMessages(entry([textEvent]));
  assert.equal(r.standby, 0);
  assert.equal(r.messages.length, 1);
});

test('a malformed standby field is 0, never a crash', () => {
  for (const bad of [{ standby: 'x' }, { standby: null }, { standby: {} }]) {
    assert.equal(extractInboundMessages(bad).standby, 0);
  }
});

test('an entry carrying BOTH is counted and still extracted', () => {
  // Not documented as possible, and cheap to be right about: the standby count must not
  // suppress messages that arrived normally in the same entry.
  const r = extractInboundMessages({ ...entry([textEvent]), standby: [{ sender: { id: 'X' } }] });
  assert.equal(r.standby, 1);
  assert.equal(r.messages.length, 1);
});
