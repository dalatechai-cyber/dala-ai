import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeyForEntry, entryEventIds, entryIdentity } from './identity.ts';

const PAGE = '863503883522801';
const APP = 'dalatech';

const msg = (mid: string, text: string) => ({
  id: PAGE,
  messaging: [{
    sender: { id: '25031102309902091' }, recipient: { id: PAGE },
    timestamp: 1788721016727, message: { mid, text },
  }],
});

const key = (entry: unknown, index = 0) =>
  dedupKeyForEntry({ externalId: PAGE, index, entry, matchedAppSlug: APP });

// ---------------------------------------------------------------------------
// The bug, in the direction it was live
// ---------------------------------------------------------------------------

test('DONE-TEST: TWO MESSAGES OF THE SAME BYTE LENGTH ARE NOT THE SAME EVENT', () => {
  // The measurement that condemned the old key, restated as an assertion: on the real
  // project `body_bytes = 307 + utf8_length(text)` exactly, so the whole variable part of
  // `{page}:{index}:{bodyBytes}:{app}` was the length of what the customer typed.
  //
  // These two are a greeting and a question about opening time. They are different
  // questions, from different people, and they are the same number of bytes — which is
  // all the old key could see.
  const a = 'Сайн байна уу';
  const b = 'Хэдэн цагт вэ';
  assert.equal(Buffer.byteLength(a, 'utf8'), Buffer.byteLength(b, 'utf8'), 'the premise');

  assert.notEqual(key(msg('m_AAA', a)), key(msg('m_BBB', b)));
});

test('DONE-TEST: THE SAME TEXT FROM TWO PEOPLE IS TWO EVENTS', () => {
  // Stronger than equal length: identical bytes. Two customers both write «Баярлалаа».
  // Under the old key these were indistinguishable at every level — same page, same
  // index, same body length — so the second was answered 200 and never replied to.
  assert.notEqual(key(msg('m_AAA', 'Баярлалаа')), key(msg('m_BBB', 'Баярлалаа')));
});

// ---------------------------------------------------------------------------
// And in the direction that must NOT change
// ---------------------------------------------------------------------------

test('a redelivery of the same message is the same key', () => {
  assert.equal(key(msg('m_AAA', 'Сайн байна уу')), key(msg('m_AAA', 'Сайн байна уу')));
});

test('THE KEY SURVIVES AN ENVELOPE THAT MOVED, because the mid did not', () => {
  // A mid-keyed identity is robust to anything Meta varies around the message. A digest
  // of the whole entry would not be: one different timestamp and the redelivery becomes a
  // new event, which is the direction that double-answers a customer.
  const first = msg('m_AAA', 'Сайн байна уу');
  const later = { ...first, time: 1788721017229, messaging: [{ ...first.messaging[0], timestamp: 1788721016999 }] };
  assert.equal(key(first), key(later));
});

test('two entries in one POST cannot collide, even carrying the same message', () => {
  // The property the old key had for free from `index`, kept.
  assert.notEqual(key(msg('m_AAA', 'за'), 0), key(msg('m_AAA', 'за'), 1));
});

// ---------------------------------------------------------------------------
// Where the ids come from
// ---------------------------------------------------------------------------

test('ids are collected from messaging, standby and feed changes', () => {
  assert.deepEqual(entryEventIds(msg('m_AAA', 'x')), ['m_AAA']);

  // standby: the Handover Protocol's secondary-receiver delivery (§3.7). It is refused
  // downstream, but it must still be deduped — a refusal repeated on every redelivery is
  // an alert repeated on every redelivery.
  assert.deepEqual(entryEventIds({ id: PAGE, standby: [{ message: { mid: 'm_SB' } }] }), ['m_SB']);

  assert.deepEqual(
    entryEventIds({ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', comment_id: 'c_1' } }] }),
    ['c_1'],
  );
});

test('THE IDS ARE SORTED, so a reordered redelivery is still a redelivery', () => {
  const ab = { id: PAGE, messaging: [{ message: { mid: 'm_B' } }, { message: { mid: 'm_A' } }] };
  const ba = { id: PAGE, messaging: [{ message: { mid: 'm_A' } }, { message: { mid: 'm_B' } }] };
  assert.deepEqual(entryEventIds(ab), ['m_A', 'm_B']);
  assert.equal(key(ab), key(ba));
});

test('a set of ids cannot be re-parenthesised into another set', () => {
  // The separator is U+0000, which cannot occur in a Meta id. A joining character that
  // CAN occur would let one set of ids be re-cut into another that hashes identically:
  // joined on a space, ['a', 'b c'] and ['a b', 'c'] are both `a b c`.
  //
  // Written with mids that contain the plausible separators, so the test fails if the
  // separator is ever changed to one of them.
  const ids = (...mids: string[]) => ({ messaging: mids.map((mid) => ({ message: { mid } })) });
  assert.notEqual(entryIdentity(ids('a', 'b c')).digest, entryIdentity(ids('a b', 'c')).digest);
  assert.notEqual(entryIdentity(ids('a', 'b:c')).digest, entryIdentity(ids('a:b', 'c')).digest);
  assert.notEqual(entryIdentity(ids('a', 'b|c')).digest, entryIdentity(ids('a|b', 'c')).digest);
});

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

test('an entry with nothing identifiable falls back to a digest of itself', () => {
  // Delivery and read receipts carry no id. `meta/extract.ts` skips them, so the worst
  // case here is a receipt claimed twice and doing nothing twice.
  const receipt = { id: PAGE, messaging: [{ sender: { id: 'P' }, delivery: { watermark: 1788721016727 } }] };
  const identity = entryIdentity(receipt);
  assert.equal(identity.kind, 'digest');
  assert.deepEqual(identity.ids, []);
  assert.equal(key(receipt), key(receipt), 'stable across a redelivery of identical bytes');
});

test('the two branches are labelled in the key, so it can be read without re-deriving it', () => {
  assert.match(key(msg('m_AAA', 'x')), /:m[0-9a-f]{32}:/);                         // ascii-safe: a hex digest
  assert.match(key({ id: PAGE, messaging: [{ read: { watermark: 1 } }] }), /:d[0-9a-f]{32}:/);
});

test('a malformed entry produces a key rather than throwing', () => {
  // Everything upstream has already answered Meta 200 or will; a crash here turns a
  // strange payload into a 500 and an endless redelivery loop.
  for (const bad of [null, undefined, 42, 'nope', { messaging: 'not-an-array' }, { messaging: [null, 7] }]) {
    assert.match(key(bad), /^863503883522801:0:[md][0-9a-f]{32}:dalatech$/);       // ascii-safe: the key's own shape
  }
});

test('an empty or blank mid is not an id', () => {
  // A blank string would otherwise become a shared identifier for every entry that has
  // one — the old bug with a different constant.
  assert.deepEqual(entryEventIds({ messaging: [{ message: { mid: '' } }, { message: { mid: '   ' } }] }), []);
  assert.equal(entryIdentity({ messaging: [{ message: { mid: '' } }] }).kind, 'digest');
});
