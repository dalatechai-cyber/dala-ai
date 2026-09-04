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
    assert.deepEqual(extractInboundMessages(bad), { messages: [], skipped: [] });
  }
});
