import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInboundMessages } from './extract.ts';

const entry = (messaging: unknown[]) => ({ id: '1234', time: 1, messaging });
/** The reasons alone. A skip now carries the event index, mid and attachment kinds too. */
const reasons = (r: { skipped: readonly { reason: string }[] }) => r.skipped.map((s) => s.reason);
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
  assert.deepEqual(reasons(r), ['echo']);
});

test('delivery and read receipts are status events, not customer turns', () => {
  const r = extractInboundMessages(entry([
    { sender: { id: 'p' }, delivery: { mids: ['mid.1'] } },
    { sender: { id: 'p' }, read: { watermark: 1 } },
  ]));
  assert.deepEqual(r.messages, []);
  assert.deepEqual(reasons(r), ['status_event', 'status_event']);
});

test('a postback is a different product surface and V1 does not ship one', () => {
  const r = extractInboundMessages(entry([{ sender: { id: 'p' }, postback: { payload: 'X' } }]));
  assert.deepEqual(reasons(r), ['postback']);
});

test('an attachment with no text is reported, never answered blind', () => {
  const r = extractInboundMessages(entry([
    { ...textEvent, message: { mid: 'mid.2', attachments: [{ type: 'image' }] } },
  ]));
  assert.deepEqual(r.messages, []);
  assert.deepEqual(reasons(r), ['no_text']);
});

test('EVERY skip is reported — "we chose not to answer" differs from "it vanished"', () => {
  const r = extractInboundMessages(entry([
    textEvent,
    { ...textEvent, message: { ...textEvent.message, is_echo: true } },
    { sender: { id: 'p' }, read: { watermark: 1 } },
    'not an object',
  ]));
  assert.equal(r.messages.length, 1);
  assert.deepEqual(reasons(r), ['echo', 'status_event', 'malformed']);
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
  assert.deepEqual(reasons(r), ['malformed']);
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
  assert.deepEqual(reasons(r), [], 'and it is not a per-message skip — it is a channel fault');
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

// ---------------------------------------------------------------------------
// What was dropped, not just that something was (D-070)
// ---------------------------------------------------------------------------

/** Meta's real shape for a thumbs-up, from `webhook_events` id 14 on 2026-09-14. */
const thumbsUp = {
  sender: { id: 'psid-1' }, recipient: { id: '1234' }, timestamp: 1789358769657,
  message: {
    mid: 'm_thumb',
    attachments: [
      { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/x', sticker_id: 369239263222822 } },
      { type: 'sticker', payload: { url: 'https://scontent.xx.fbcdn.net/x', sticker_id: 369239263222822 } },
    ],
  },
};

test('DONE-TEST: ONE STICKER IS ONE STICKER, NOT AN IMAGE AND A STICKER', () => {
  // Meta sends a thumbs-up as TWO attachments with the SAME sticker_id, the first declared
  // as an image. Counting the array says the customer sent two things; reading only `type`
  // says one of them was a photograph. Both are wrong, and the second is the one that
  // cost — on 2026-09-14 all three of Matrix's dropped attachments read as `image` from
  // the type alone, and every one was this sticker.
  const r = extractInboundMessages(entry([thumbsUp]));
  assert.deepEqual(reasons(r), ['no_text']);
  assert.deepEqual(r.skipped[0]?.attachments, ['sticker']);
  assert.deepEqual(r.skipped[0]?.stickerIds, ['369239263222822']);
});

test('DONE-TEST: A REAL PHOTOGRAPH IS NOT A STICKER, AND THE RECORD SAYS SO', () => {
  // The whole point of the kind. A photo of the colour a customer wants is the most
  // valuable message a salon receives; a thumbs-up is filler. If these two produce the
  // same record, the instrumentation has not been built.
  const photo = { ...thumbsUp, message: { mid: 'm_photo', attachments: [{ type: 'image', payload: { url: 'https://x/y' } }] } };
  const r = extractInboundMessages(entry([photo]));
  assert.deepEqual(r.skipped[0]?.attachments, ['image']);
  assert.deepEqual(r.skipped[0]?.stickerIds, []);
  assert.notDeepEqual(
    extractInboundMessages(entry([thumbsUp])).skipped[0]?.attachments,
    r.skipped[0]?.attachments,
  );
});

test('a skip carries the event index and Meta’s mid, so a retry can recognise it', () => {
  // `(event_id, idx)` is the identity `inbound/dropped.ts` dedupes on. The mid is absent on
  // a malformed event, which is exactly why the index is the key rather than the mid.
  const r = extractInboundMessages(entry(['not an object', thumbsUp]));
  assert.equal(r.skipped[0]?.idx, 0);
  assert.equal(r.skipped[0]?.externalId, null);
  assert.equal(r.skipped[1]?.idx, 1);
  assert.equal(r.skipped[1]?.externalId, 'm_thumb');
});

test('a skip carries the sender, so a dropped event can be tied to its conversation', () => {
  const r = extractInboundMessages(entry([thumbsUp]));
  assert.equal(r.skipped[0]?.senderId, 'psid-1');
});

test('an unrecognised attachment type is recorded as itself, never dropped to nothing', () => {
  // A kind nobody recognises is a better record than an empty list, which reads as "no
  // attachment" — the state this whole mechanism exists to stop being invisible.
  const r = extractInboundMessages(entry([
    { ...thumbsUp, message: { mid: 'm', attachments: [{ payload: {} }, { type: 'video', payload: {} }] } },
  ]));
  assert.deepEqual(r.skipped[0]?.attachments, ['unknown', 'video']);
});

test('kinds are deduplicated: three photos in one message are still "image"', () => {
  const r = extractInboundMessages(entry([
    { ...thumbsUp, message: { mid: 'm', attachments: [
      { type: 'image', payload: {} }, { type: 'image', payload: {} }, { type: 'file', payload: {} },
    ] } },
  ]));
  assert.deepEqual(r.skipped[0]?.attachments, ['image', 'file']);
});

test('DONE-TEST: AN ECHO CARRIES ITS mid AND THE CUSTOMER', () => {
  // The unlock for §3.7.3. `skip('echo')` used to carry nothing, so "did WE send this?"
  // had nothing to ask with, and a receptionist and the bot answered the same customer in
  // parallel with nothing anywhere recording it.
  //
  // `sender` on an echo is the PAGE. Filing that under `senderId` would look right and
  // resolve to no conversation, so the customer travels as `recipientId`.
  const r = extractInboundMessages({
    id: 'PAGE_1',
    messaging: [{
      sender: { id: 'PAGE_1' },
      recipient: { id: 'psid_customer' },
      timestamp: 1_758_000_000_000,
      message: { mid: 'm_echo', text: 'Сайн байна уу', is_echo: true },
    }],
  });
  assert.equal(r.messages.length, 0, 'an echo is still never answered — that loop bills');
  assert.equal(r.skipped.length, 1);
  const echo = r.skipped[0]!;
  assert.equal(echo.reason, 'echo');
  assert.equal(echo.externalId, 'm_echo');
  assert.equal(echo.senderId, 'PAGE_1', 'the page, because that is who Meta says sent it');
  assert.equal(echo.recipientId, 'psid_customer', 'the customer, which is the thread');
});

test('a non-echo skip carries no recipient', () => {
  const r = extractInboundMessages({
    id: 'PAGE_1',
    messaging: [{ sender: { id: 'psid_1' }, recipient: { id: 'PAGE_1' }, message: { mid: 'm_1', attachments: [] } }],
  });
  assert.equal(r.skipped[0]?.recipientId, null);
});
