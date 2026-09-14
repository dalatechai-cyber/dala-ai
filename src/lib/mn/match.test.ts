import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsStem,
  findStem,
  firstMatchingStem,
  matchesStemSequence,
  wholeMessageKey,
  wholeMessageMatches,
} from './match.ts';

// ---------------------------------------------------------------------------
// The fixture §6.7(b) asks for: inflected forms, checked in, matched offline.
//
// Every row is a real Mongolian inflection of a stem this platform must catch. The
// design's estimate is that enumerating surface forms instead would match "roughly one
// inflection in six" — these rows are how that stops being an estimate.
// ---------------------------------------------------------------------------
const INFLECTIONS: ReadonlyArray<{ stem: string; form: string; gloss: string }> = [
  { stem: 'хүүхэд', form: 'хүүхэд',            gloss: 'child, nominative' },
  { stem: 'хүүхд',  form: 'хүүхдэд',           gloss: 'child, dative' },
  { stem: 'хүүхд',  form: 'хүүхдийн',          gloss: 'child, genitive' },
  { stem: 'хүүхд',  form: 'хүүхдүүдийн',       gloss: 'children, plural genitive' },
  { stem: 'хүүхд',  form: 'хүүхдүүдэд',        gloss: 'children, plural dative' },
  { stem: 'эхл',    form: 'эхлээд',            gloss: 'starting from' },
  { stem: 'эхэл',   form: 'эхэлдэг',           gloss: 'starts (habitual)' },
  { stem: 'сул',    form: 'сул',               gloss: 'free/available' },
  { stem: 'захиал', form: 'захиалгын',         gloss: 'booking, genitive' },
  { stem: 'хямдр',  form: 'хямдралтай',        gloss: 'with a discount' },
  { stem: 'хөнгөлөл', form: 'хөнгөлөлттэй',    gloss: 'with a concession' },
  { stem: 'урамшуул', form: 'урамшуулалгүй',   gloss: 'without a promotion' },
];

test('a stored stem matches every inflection built on it', () => {
  for (const { stem, form, gloss } of INFLECTIONS) {
    assert.equal(containsStem(form, stem), true, `stem "${stem}" must match "${form}" (${gloss})`);
  }
});

test('the stem-change forms are why BOTH хүүхэд and хүүхд are stored, as data', () => {
  // This is the case no prefix rule derives: the nominative loses its final vowel under
  // inflection. The engine cannot fix that and does not pretend to — `match_stems` is an
  // array precisely so a reviewer can see both forms.
  assert.equal(containsStem('хүүхдэд', 'хүүхэд'), false);
  assert.equal(containsStem('хүүхдэд', 'хүүхд'), true);
});

test('the ASCII word boundary this engine exists to replace really does fail here', () => {
  // Verified by execution, and pinned so nobody "simplifies" the lookbehind away.
  assert.equal(/\bзасалт\b/.test('Мөнгөн засалт'), false); // ascii-safe: demonstrating the ASCII construct's failure
  assert.equal(containsStem('Мөнгөн засалт', 'засалт'), true);
});

test('a stem matches only at a TOKEN start, never mid-word', () => {
  assert.equal(containsStem('хүүхэд', 'үүхэд'), false, 'mid-token match must not fire');
  assert.equal(containsStem('гоо сайхан', 'сайхан'), true, 'after a space is a token start');
});

test('a non-letter prefix is still a token start — «30,000₮-аас эхлээд»', () => {
  // The currency sign and hyphen are not letters, so `аас` begins a token there. Without
  // this, every price-hedge phrase attached to a numeral is invisible to the guard.
  assert.equal(containsStem('30,000₮-аас эхлээд', 'аас'), true);
  assert.equal(containsStem('30,000₮-аас эхлээд', 'эхл'), true);
});

test('NFD input matches an NFC stem — Й and Ё decompose, Ө and Ү do not', () => {
  // «Сайн» carries й (U+0439), which decomposes to и + U+0306. A matcher that skips
  // normalisation therefore works or fails depending on the customer's keyboard.
  const nfd = 'Сайн байна уу'.normalize('NFD');
  assert.notEqual(nfd, 'Сайн байна уу', 'precondition: this string really does differ in NFD');
  assert.equal(containsStem(nfd, 'сайн'), true);
});

test('case folds, including the two letters unaccent would leave behind', () => {
  assert.equal(containsStem('ХҮҮХЭД', 'хүүхэд'), true);
  assert.equal(containsStem('ӨНӨӨДӨР', 'өнөөдөр'), true);
});

test('a stem containing regex metacharacters is data, not a pattern', () => {
  // `match_stems` is edited through an admin form. An unescaped `(` would throw inside
  // the guard that was supposed to refuse the reply; an unescaped `.` would match
  // anything. A tenant must not be able to cause either by typing.
  assert.doesNotThrow(() => containsStem('юу ч болоогүй', '('));
  assert.equal(containsStem('хямдрал', 'х.мдрал'), false, 'a dot is a dot, not a wildcard');
});

test('a stem cannot express «a percent sign», which is why §6.7 gives it its own tripwire', () => {
  // `%` in «50%» is preceded by a digit, so it is not at a token start and the stem
  // engine — correctly, by its own rule — does not fire. Discovered by this test rather
  // than reasoned about in advance, and it explains a design decision that otherwise
  // looks redundant: the concession check does NOT put `%` in a stem list, it carries a
  // separate `/\p{Nd}+\s*%/u` tripwire. Anyone who later "tidies" that into the stem
  // list would silently disable the discount guard.
  assert.equal(containsStem('50%', '%'), false);
  assert.equal(containsStem('50 %', '%'), true, 'after a space it IS a token start');
});

test('firstMatchingStem returns the caller\'s priority order, not the text order', () => {
  assert.equal(firstMatchingStem('хүүхдийн үс засалт', ['үс', 'хүүхд']), 'үс');
  assert.equal(firstMatchingStem('хүүхдийн үс засалт', ['хүүхд', 'үс']), 'хүүхд');
  assert.equal(firstMatchingStem('ямар ч тохирол алга', ['хүүхд']), null);
});

// ---------------------------------------------------------------------------
// Ordered stem sequences — §6.7(b)'s outbound phrases.
// ---------------------------------------------------------------------------

test('an ordered sequence catches the booking confirmation the ancestor would miss', () => {
  // «цаг авлаа» as a contiguous substring misses this entirely: four words separate the
  // two stems. Confirming a booking we did not make sends a customer to the salon at a
  // time nobody reserved.
  const reply = 'Таны цагийг маргааш 15:00-д авлаа.';
  assert.equal(matchesStemSequence(reply, ['цаг', 'авл']), true);
  assert.equal(reply.includes('цаг авлаа'), false, 'precondition: the contiguous form is absent');
});

test('an ordered sequence catches invented staff availability', () => {
  assert.equal(matchesStemSequence('14:00 цагт сул байгаа', ['сул', 'бай']), true);
});

test('order is required — the same stems reversed do not match', () => {
  assert.equal(matchesStemSequence('авлаа цаг', ['цаг', 'авл']), false);
});

test('the 40-character window is what stops two unrelated sentences matching', () => {
  const far =
    'Таны цагийн хуваарийн талаар лавлахыг хүсвэл манай ажилтантай холбогдоно уу, ' +
    'бид тусална. Бид саналыг тань авлаа.';
  assert.equal(matchesStemSequence(far, ['цаг', 'авл']), false, 'too far apart to be one phrase');
  assert.equal(matchesStemSequence(far, ['цаг', 'авл'], 200), true, 'and a wider window does see it');
});

test('the window is measured in CODE POINTS, so an emoji costs one character not two', () => {
  // Sixteen emoji sit between the stems. In UTF-16 units that is 32 and the phrase falls
  // outside a 40-character window; in code points it is 16 and stays inside it. A salon
  // DM is full of emoji, so this is the ordinary case, not an exotic one.
  const padded = `цаг ${'😊'.repeat(16)} авлаа`;
  assert.equal(padded.length > 40, true, 'precondition: it overflows the window in UTF-16 units');
  assert.equal(matchesStemSequence(padded, ['цаг', 'авл'], 40), true);
});

test('the anchor is tried at every occurrence, so an early decoy cannot hide a match', () => {
  // The first «цаг» is far from any «авл»; the second is adjacent. Chaining greedily from
  // only the first occurrence would report no match and the invented booking would ship.
  const reply = 'цаг' + ' ямар ч холбоогүй үг '.repeat(4) + 'цагийг авлаа';
  assert.equal(matchesStemSequence(reply, ['цаг', 'авл'], 40), true);
});

test('a sequence with a missing stem does not match, and an empty sequence never matches', () => {
  assert.equal(matchesStemSequence('цаг', ['цаг', 'авл']), false);
  assert.equal(matchesStemSequence('юу ч', []), false);
});

// ---------------------------------------------------------------------------
// whole_message — the greeting mode, and the two ancestor bugs it exists to prevent.
// ---------------------------------------------------------------------------

const GREETINGS = ['сайн байна уу', 'сайн байцгаана уу', 'байна уу'];

test('a greeting matches on the WHOLE message, punctuation and emoji stripped', () => {
  assert.equal(wholeMessageMatches('Сайн байна уу?', GREETINGS), true);
  assert.equal(wholeMessageMatches('  сайн   байна уу!!! 😊 ', GREETINGS), true);
});

test('REGRESSION: «Уучлаарай асуумаар байна» is not a greeting', () => {
  // The ancestor's GREETING_REGEX is /^(сайн|байна|уу|hi|hello|hey)/i — anchored left,
  // open right — so any message beginning «уу» matched, and «Уучлаарай» is among the
  // commonest openers in Mongolian customer service. That customer's question was never
  // answered. A greeting shortcut that fires on a prefix is a bug factory (§6.8 rule 2).
  assert.equal(wholeMessageMatches('Уучлаарай асуумаар байна', GREETINGS), false);
});

test('REGRESSION: «Facebook хаяг байна уу» is not a location question', () => {
  // `хаяг` matched anywhere in the ancestor, on every message, so an address-shortcut
  // stole a question about the Facebook page. EMAIL_CONTEXT_REGEX was a hand-patch on
  // this exact symptom and would have kept producing new ones.
  assert.equal(wholeMessageMatches('Facebook хаяг байна уу', ['хаяг хаана вэ', 'хаанаа байдаг вэ']), false);
});

test('a greeting in NFD still matches — the ancestor normalised nowhere', () => {
  assert.equal(wholeMessageMatches('Сайн байна уу'.normalize('NFD'), GREETINGS), true);
});

test('an empty or punctuation-only message never matches a greeting', () => {
  assert.equal(wholeMessageKey('!!! ??? 😊'), '');
  assert.equal(wholeMessageMatches('!!! ???', GREETINGS), false);
  assert.equal(wholeMessageMatches('', GREETINGS), false);
});

test('findStem reports both UTF-16 and code-point offsets, and they differ across emoji', () => {
  const hits = findStem('😊 хүүхэд', 'хүүхэд');
  assert.equal(hits.length, 1);
  const hit = hits[0];
  assert.notEqual(hit, undefined);
  assert.equal(hit?.start, 3, 'UTF-16: the emoji is two units, plus a space');
  assert.equal(hit?.startCp, 2, 'code points: the emoji is one character, plus a space');
});

// ---------------------------------------------------------------------------
// D-067. This block asserts a GAP, not a guarantee.
// ---------------------------------------------------------------------------

test('D-067 GAP: Mongolian written in LATIN letters matches no Cyrillic stem', () => {
  // IF YOU ARE HERE BECAUSE THIS FAILED: you have closed D-067 by teaching something to
  // transliterate. That is the intended direction — delete this block and read the
  // decision, which sets out what has to be decided first (which romanisations to accept,
  // and how not to fire refusals on ordinary English words).
  //
  // Until then this is the honest record of what the matching layer can see. Two of the
  // mirror's first three real customer messages were Latin script, so it is not a corner.
  assert.equal(containsStem('бүтэн будалт хийлгэнэ', 'бүтэн'), true, 'Cyrillic: fires');
  assert.equal(containsStem('buten budalt hiilgene', 'бүтэн'), false, 'the SAME words in Latin: silent');

  // The one that matters. Matrix does not do children's hair; the founder approved the
  // out_of_scope row by hand. It does not fire for the Latin spelling, so no refusal is in
  // play and the model answers the question.
  assert.equal(containsStem('хүүхдийн үс засуулна', 'хүүхд'), true);
  assert.equal(containsStem('huuhdiin us zasuulna', 'хүүхд'), false, "the children's rule is silent in Latin");

  // Not a case-folding problem — folding works. It is a script problem.
  assert.equal(containsStem('Хүүхдийн', 'хүүхд'), true, 'folding is fine');

  // whole_message is the same, so a deterministic reply keyed on a greeting misses too.
  assert.equal(wholeMessageMatches('сайн байна уу', ['сайн байна уу']), true);
  assert.equal(wholeMessageMatches('sain baina uu', ['сайн байна уу']), false);
});

test('D-067 THE FIX: the matcher is script-agnostic, so a LATIN stem needs no code', () => {
  // The half that makes the gap above a provisioning question rather than an architectural
  // one. `containsStem` is a Unicode token-prefix match and does not care which script the
  // stem is written in, so a tenant that stores `huuhd` beside `хүүхд` is covered today.
  //
  // The ancestor is what pointed at this: Matrix-Chatbot's one customer-text matcher is
  // /^(сайн|байна|уу|hi|hello|hey)/i — it LISTS the Latin forms rather than transliterating.
  assert.equal(containsStem('huuhdiin us zasuulna', 'huuhd'), true);
  assert.equal(containsStem('Huuhdiin Us Zasuulna', 'huuhd'), true, 'ASCII case folds');
  assert.equal(containsStem('manai huuhduud', 'huuhd'), true, 'prefix catches inflections, as in Cyrillic');
  assert.equal(containsStem('buten budalt hiilgene', 'buten'), true, 'the real mirror message');

  // And it degrades the way the Cyrillic side already does, rather than over-matching.
  assert.equal(containsStem('hүүхдийн', 'huuhd'), false, 'mixed script is not a hit');
  assert.equal(containsStem('minii huuhed', 'huuhd'), false, 'the token-PREFIX rule still holds');
  assert.equal(containsStem('хүүхдийн үс', 'huuhd'), false, 'a Latin stem does not reach Cyrillic text');

  // Listing both spellings is all a whole_message rule needs, too.
  const both = ['сайн байна уу', 'sain baina uu', 'hello'];
  assert.equal(wholeMessageMatches('Сайн байна уу?', both), true);
  assert.equal(wholeMessageMatches('sain baina uu', both), true);
  assert.equal(wholeMessageMatches('Hello', both), true);
  assert.equal(wholeMessageMatches('hola', both), false);
});
