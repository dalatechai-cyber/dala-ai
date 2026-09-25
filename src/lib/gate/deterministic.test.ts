import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeQuoted, matchDeterministic, withAppended, type DeterministicRule, type HistoryState } from './deterministic.ts';

const GREETING: DeterministicRule = {
  intent: 'greeting', body: 'Сайн байна уу! Танд юугаар туслах вэ?',
  enabled: true, matchMode: 'whole_message',
  stems: ['сайн байна уу', 'сайн байцгаана уу', 'байна уу'],
  coverWords: [], placement: 'replace' as const, quoteServices: [], requiresEmptyHistory: true, provenance: 'tenant_confirmed',
};
const LOCATION: DeterministicRule = {
  intent: 'location', body: 'Бид Сүхбаатар дүүрэгт байрладаг.',
  enabled: true, matchMode: 'contains_stem',
  stems: ['хаана байрлад', 'байршил'],
  coverWords: [], placement: 'replace' as const, quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
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
  assert.deepEqual(matchDeterministic('юу ч', [], FIRST), { hit: null, appends: [], skipped: [], suppressed: [] });
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

// ---------------------------------------------------------------------------
// 0041 — append rows, covers_message, quote_services (founder, 2026-09-24)
// ---------------------------------------------------------------------------

const TARA_LINE = 'Тийм, манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ.';
const TARA_NAME: DeterministicRule = {
  intent: 'tara_name', body: TARA_LINE, enabled: true, matchMode: 'covers_message',
  stems: ['tara', 'тара', 'матрикс', 'matrix', 'нэрээ', 'neree'],
  coverWords: ['сайн', 'байна', 'уу', 'үү', 'энэ', 'салон', 'salon', 'мөн', 'та', 'нар', 'solison', 'uu'],
  placement: 'replace', quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
};
const TARA_APPEND: DeterministicRule = {
  intent: 'tara_rebrand', body: TARA_LINE, enabled: true, matchMode: 'contains_stem',
  stems: ['tara', 'тара', 'хаяг', 'hayag', 'хаана', 'haana', 'байрш', 'байрла', 'салбар'],
  coverWords: [], placement: 'append', quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
};
const DYE: DeterministicRule = {
  intent: 'dye_prices', body: 'Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?', enabled: true,
  matchMode: 'covers_message', stems: ['будаг', 'будуул', 'будах', 'будал', 'budag', 'buduul', 'budal'],
  coverWords: ['үс', 'us', 'хэд', 'hed', 'вэ', 've', 'үнэ'],
  placement: 'replace', quoteServices: ['Үсний угийн будаг', 'Дунд үсний будаг', 'Урт үсний будаг'],
  requiresEmptyHistory: false, provenance: 'tenant_confirmed',
};
const ANY: HistoryState = { known: true, empty: false };

test('DONE-TEST: A QUESTION ONLY ABOUT THE NAME GETS THE LINE ON ITS OWN', () => {
  for (const m of ['Сайн байна уу, энэ Тара салон мөн үү?', 'Matrix salon neree solison uu?', 'Та нар Матрикс салон уу, Тара салон уу?']) {
    const r = matchDeterministic(m, [TARA_NAME, TARA_APPEND], ANY);
    assert.equal(r.hit?.intent, 'tara_name', m);
  }
});

test('DONE-TEST: ANY OTHER WORD MEANS IT IS NOT ONLY ABOUT THE NAME — THE LINE IS APPENDED', () => {
  // f10, n05, r01, r02, r04: the answer is produced as normal and the line goes at the end.
  for (const m of ['Хаана байрладаг вэ?', 'hayag', 'Tara salon hayag haana baidag ve?',
    'Tara salon яармаг салбар yarmagtaa bizdee hehe', 'Sainuu, tara saloninxoon, urdichilgaa awch baigaa yu?']) {
    const r = matchDeterministic(m, [TARA_NAME, TARA_APPEND], ANY);
    assert.equal(r.hit, null, `${m} must not be answered by the line alone`);
    assert.deepEqual(r.appends.map((a) => a.intent), ['tara_rebrand'], m);
  }
});

test('a cover word is WHOLE: «та» does not cover «тайралт»', () => {
  const r = matchDeterministic('Тара салон тайралт', [TARA_NAME], ANY);
  assert.equal(r.hit, null, 'a haircut question is not a question about the name');
});

test('a covers_message row does not fire on a message carrying a picture', () => {
  const r = matchDeterministic('Будаг хэд вэ?', [DYE], ANY, { hasAttachment: true });
  assert.equal(r.hit, null);
  assert.deepEqual(r.skipped, [{ intent: 'dye_prices', reason: 'has_attachment' }]);
});

test('DONE-TEST: «Үс будуулахад хэд вэ?» IS THE COLOUR ROW; «Сор хэд вэ?» IS NOT', () => {
  assert.equal(matchDeterministic('Үс будуулахад хэд вэ?', [DYE], ANY).hit?.intent, 'dye_prices');
  assert.equal(matchDeterministic('Будаг хэд вэ?', [DYE], ANY).hit?.intent, 'dye_prices');
  assert.equal(matchDeterministic('us budalt', [DYE], ANY).hit?.intent, 'dye_prices');
  assert.equal(matchDeterministic('Сор хэд вэ?', [DYE], ANY).hit, null);
  assert.equal(matchDeterministic('Эмэгтэй сортой будаг хийлгэх гэсийн', [DYE], ANY).hit, null);
  assert.equal(matchDeterministic('будагтай үсний уг цайруулалт хэд вэ', [DYE], ANY).hit, null);
});

test('an unconfirmed append row is withheld and reported, like any other', () => {
  const r = matchDeterministic('hayag', [{ ...TARA_APPEND, provenance: 'seeded' }], ANY);
  assert.deepEqual(r.appends, []);
  assert.deepEqual(r.suppressed, ['tara_rebrand']);
});

const PRICE_LIST = [
  { name: 'Дунд үсний будаг', rows: ['Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮'] },
  { name: 'Урт үсний будаг', rows: ['Урт үсний будаг (мөр давсан урттай үс): 200,000₮'] },
  { name: 'Үсний угийн будаг', rows: ['Үсний угийн будаг: 135,000₮'] },
];

test('DONE-TEST: QUOTED ROWS COME FROM THE PRICE LIST IN THE ROW\'S ORDER, THEN THE QUESTION', () => {
  assert.equal(composeQuoted(DYE, PRICE_LIST), [
    'Үсний угийн будаг: 135,000₮',
    'Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮',
    'Урт үсний будаг (мөр давсан урттай үс): 200,000₮',
    '',
    'Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?',
  ].join('\n'));
});

test('a service missing from the price list means the row does not answer', () => {
  assert.equal(composeQuoted(DYE, PRICE_LIST.slice(0, 2)), null);
});

test('withAppended adds at the end, moves a copy the model wrote first, never doubles', () => {
  const hit = [{ intent: 't', body: TARA_LINE, quoteServices: [] }];
  assert.equal(withAppended('Хаяг: Яармаг.', hit), `Хаяг: Яармаг.\n\n${TARA_LINE}`);
  assert.equal(withAppended(`${TARA_LINE}\n\nХаяг: Яармаг.`, hit), `Хаяг: Яармаг.\n\n${TARA_LINE}`);
  assert.equal(withAppended(TARA_LINE, hit), TARA_LINE);
  assert.equal(withAppended('x', []), 'x');
});

test('0042: an on_topic row fires when its gate topic fired, and never on the words', () => {
  const row: DeterministicRule = {
    intent: 'stylist', body: 'x', enabled: true, matchMode: 'on_topic', stems: ['suitability_mn_orh'],
    coverWords: [], placement: 'append', quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
  };
  assert.deepEqual(matchDeterministic('suitability_mn_orh', [row], ANY).appends, [], 'the topic key typed as text is not the topic');
  const r = matchDeterministic('Хар өнгөтэй үсэнд орох уу', [row], ANY, { hasAttachment: false, topics: ['suitability_mn_orh'] });
  assert.deepEqual(r.appends.map((a) => [a.intent, a.onTopic]), [['stylist', true]]);
});

test('covers_message: a stem under the floor matches as a WHOLE word, not a prefix (2026-09-26)', () => {
  const price: DeterministicRule = {
    intent: 'price_overview', body: 'PRICE LIST', enabled: true, matchMode: 'covers_message',
    stems: ['үнэ', 'үнэт', 'үний', 'une', 'unet'], coverWords: ['сайн', 'байна', 'уу', 'ямар', 'байдаг', 'вэ', 'tanaih', 'yamar', 've', 'hed'],
    placement: 'replace', quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
  };
  const hit = (m: string) => matchDeterministic(m, [price], { known: true, empty: true }).hit?.intent ?? null;
  assert.equal(hit('Сайн байна уу, үнэ ямар байдаг вэ?'), 'price_overview');
  assert.equal(hit('tanaih yamar unetei ve'), 'price_overview', '«unet» is a prefix: four letters');
  assert.equal(hit('une hed ve'), 'price_overview');
  assert.equal(hit('Үнэн үү?'), null, '«үнэ» is whole: «үнэн» (true) is another word');
  assert.equal(hit('unen yamar ve'), null);
});
