import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDeterministic, type DeterministicRule, type HistoryState } from './deterministic.ts';

const GREETING: DeterministicRule = {
  intent: 'greeting', body: 'Сайн байна уу! Танд юугаар туслах вэ?',
  enabled: true, matchMode: 'whole_message',
  stems: ['сайн байна уу', 'сайн байцгаана уу', 'байна уу'],
  requiresEmptyHistory: true, provenance: 'tenant_confirmed',
};
const LOCATION: DeterministicRule = {
  intent: 'location', body: 'Бид Сүхбаатар дүүрэгт байрладаг.',
  enabled: true, matchMode: 'contains_stem',
  stems: ['хаана байрлад', 'байршил'],
  requiresEmptyHistory: false, provenance: 'tenant_confirmed',
};

const FIRST: HistoryState = { known: true, empty: true };
const ONGOING: HistoryState = { known: true, empty: false };
const UNKNOWN: HistoryState = { known: false };

// ---------------------------------------------------------------------------
// It fires when it should.
// ---------------------------------------------------------------------------

test('a bare greeting on a first message is answered without a model call', () => {
  const r = matchDeterministic('Сайн байна уу?', [GREETING], FIRST);
  assert.equal(r.hit?.intent, 'greeting');
});

test('punctuation and emoji do not stop a greeting matching', () => {
  assert.equal(matchDeterministic('  сайн   байна уу!!! 😊 ', [GREETING], FIRST).hit?.intent, 'greeting');
});

test('a greeting in NFD matches — the ancestor normalised nowhere', () => {
  assert.equal(matchDeterministic('Сайн байна уу'.normalize('NFD'), [GREETING], FIRST).hit?.intent, 'greeting');
});

test('contains_stem catches an inflected form', () => {
  assert.equal(matchDeterministic('Та нар хаана байрладаг вэ?', [LOCATION], ONGOING).hit?.intent, 'location');
});

// ---------------------------------------------------------------------------
// The ancestor's two live defects, both of which cost a customer their answer.
// ---------------------------------------------------------------------------

test('REGRESSION: «Уучлаарай асуумаар байна» is not a greeting', () => {
  // GREETING_REGEX is /^(сайн|байна|уу|hi|hello|hey)/i — anchored left, open right — so
  // any message beginning «уу» matched, and «Уучлаарай» is among the commonest openers in
  // Mongolian customer service. That customer's question was never answered.
  const r = matchDeterministic('Уучлаарай асуумаар байна', [GREETING], FIRST);
  assert.equal(r.hit, null);
  assert.deepEqual(r.skipped, [{ intent: 'greeting', reason: 'no_match' }]);
});

test('THE STEM ENGINE ALONE DOES NOT FIX «Facebook хаяг байна уу» — the MODE does', () => {
  // Worth pinning because it is easy to assume otherwise. `хаяг` is four characters and
  // appears at a token start here, so `contains_stem` fires and the address shortcut
  // steals a question about the Facebook page — exactly the ancestor's live defect,
  // reproduced by a matcher that is working correctly.
  const asStem: DeterministicRule = { ...LOCATION, matchMode: 'contains_stem', stems: ['хаяг'] };
  assert.equal(matchDeterministic('Facebook хаяг байна уу', [asStem], ONGOING).hit?.intent, 'location',
    'the stem matcher DOES steal it');

  // What actually fixes it is whole-message matching: the customer did not ask "where are
  // you", they asked whether there is a Facebook page. This is why 0005 defaults
  // match_mode to whole_message and why §6.8 says it is the only mode a greeting may use.
  const asWhole: DeterministicRule = { ...LOCATION, matchMode: 'whole_message', stems: ['хаяг хаана вэ'] };
  assert.equal(matchDeterministic('Facebook хаяг байна уу', [asWhole], ONGOING).hit, null);
  assert.equal(matchDeterministic('Хаяг хаана вэ?', [asWhole], ONGOING).hit?.intent, 'location');
});

// ---------------------------------------------------------------------------
// The history gate, and the distinction a rewrite loses.
// ---------------------------------------------------------------------------

test('a greeting does NOT fire mid-conversation', () => {
  const r = matchDeterministic('Сайн байна уу', [GREETING], ONGOING);
  assert.equal(r.hit, null);
  assert.deepEqual(r.skipped, [{ intent: 'greeting', reason: 'history_not_empty' }]);
});

test('UNKNOWN HISTORY IS NOT EMPTY HISTORY', () => {
  // The ancestor's getHistory returns null when Redis is unreachable and [] only when it
  // genuinely answered "no turns". Collapsing the two makes a storage hiccup greet an
  // existing customer from scratch, mid-conversation, as though the last ten minutes had
  // not happened.
  const r = matchDeterministic('Сайн байна уу', [GREETING], UNKNOWN);
  assert.equal(r.hit, null);
  assert.deepEqual(r.skipped, [{ intent: 'greeting', reason: 'history_unknown' }]);
});

test('a rule that does not require an empty history still fires when it is unknown', () => {
  // Only the greeting cares. An address question is answerable whenever it is asked.
  assert.equal(matchDeterministic('Байршил хаана вэ', [LOCATION], UNKNOWN).hit?.intent, 'location');
});

// ---------------------------------------------------------------------------
// When in doubt, do not fire.
// ---------------------------------------------------------------------------

test('a disabled rule never fires, and says so', () => {
  const r = matchDeterministic('Сайн байна уу', [{ ...GREETING, enabled: false }], FIRST);
  assert.deepEqual(r.skipped, [{ intent: 'greeting', reason: 'disabled' }]);
});

test('a rule with no stems matches nothing', () => {
  const r = matchDeterministic('юу ч', [{ ...GREETING, stems: [] }], FIRST);
  assert.deepEqual(r.skipped, [{ intent: 'greeting', reason: 'no_stems' }]);
});

test('A TOO-SHORT STEM SKIPS THE RULE — it does not refuse the message', () => {
  // This is the mirror image of the gate matcher, and getting it backwards is silent in
  // both directions. There, skipping a malformed rule disarms a refusal the tenant asked
  // for. Here, skipping one costs a single model call — while firing wrongly refuses a
  // paying customer with no model in the loop to recover.
  const r = matchDeterministic('үс', [{ ...LOCATION, stems: ['үс'] }], ONGOING);
  assert.equal(r.hit, null);
  assert.deepEqual(r.skipped, [{ intent: 'location', reason: 'stem_too_short' }]);
});

test('the first matching rule wins, in the tenant\'s own order', () => {
  const a: DeterministicRule = { ...LOCATION, intent: 'first', stems: ['байршил'] };
  const b: DeterministicRule = { ...LOCATION, intent: 'second', stems: ['байршил'] };
  assert.equal(matchDeterministic('байршил', [a, b], ONGOING).hit?.intent, 'first');
});

test('every rule that could have fired and did not is reported', () => {
  const r = matchDeterministic('Огт хамааралгүй асуулт байна', [GREETING, LOCATION], ONGOING);
  assert.equal(r.hit, null);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['history_not_empty', 'no_match']);
});

test('no rules at all is a clean miss, not an error', () => {
  assert.deepEqual(matchDeterministic('юу ч', [], FIRST), { hit: null, skipped: [], suppressed: [] });
});

// ---------------------------------------------------------------------------
// D-020 — provenance
// ---------------------------------------------------------------------------

test('DONE-TEST: an unconfirmed deterministic reply MATCHES and is withheld', () => {
  // The other direction from the gate matcher, and for a reason that is about the row
  // rather than the table: `body` is sent to the customer verbatim, with no model in the
  // loop — and unlike `canned_responses`, this table has no `reviewed_at` column at all.
  // So provenance is the only thing standing between an invented sentence and a customer
  // reading it as the salon's own words. Not firing costs one model call.
  const seeded: DeterministicRule = { ...GREETING, provenance: 'seeded' };
  const r = matchDeterministic('Сайн байна уу', [seeded], FIRST);
  assert.equal(r.hit, null, 'the guessed sentence is not sent');
  assert.deepEqual(r.suppressed, ['greeting'], 'and the withholding is named');
});

test('SUPPRESSED IS NOT SKIPPED — the two answer different questions', () => {
  // `skipped` says "not applicable to this message". `suppressed` says "this row had the
  // answer and was not allowed to give it", which is the only one an operator must act on.
  // Collapsing them buries a provisioned-but-untrusted row among the ordinary misses.
  const seeded: DeterministicRule = { ...GREETING, provenance: 'seeded' };
  const r = matchDeterministic('Хаана байрладаг вэ?', [seeded], FIRST);
  assert.deepEqual(r.suppressed, [], 'it never matched, so nothing was withheld');
  assert.deepEqual(r.skipped.map((s) => s.reason), ['no_match']);
});

test('a later confirmed rule still answers after an unconfirmed one is withheld', () => {
  // Withholding must not end the loop: the tenant may well have a confirmed row that
  // covers the same message, and refusing to look at it would turn one bad row into a
  // silently disabled layer.
  const seeded: DeterministicRule = { ...GREETING, intent: 'greeting_seeded', provenance: 'seeded' };
  const confirmed: DeterministicRule = { ...GREETING, intent: 'greeting_real', body: 'Сайн уу!' };
  const r = matchDeterministic('Сайн байна уу', [seeded, confirmed], FIRST);
  assert.equal(r.hit?.intent, 'greeting_real');
  assert.deepEqual(r.suppressed, ['greeting_seeded']);
});

test('a rule with no provenance is withheld too', () => {
  const unlabelled: DeterministicRule = { ...GREETING, provenance: undefined };
  assert.equal(matchDeterministic('Сайн байна уу', [unlabelled], FIRST).hit, null);
});

test('a confirmed rule fires and reports nothing suppressed', () => {
  const r = matchDeterministic('Сайн байна уу', [GREETING], FIRST);
  assert.equal(r.hit?.intent, 'greeting');
  assert.deepEqual(r.suppressed, []);
});
