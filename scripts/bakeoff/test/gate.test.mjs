// Unit tests for the ungrounded-numeral gate.
//
// These run against a SYNTHETIC prefix, not the ancestor's, for two reasons:
// copying the salon's price list into this repository would create a second copy
// that can drift, and Matrix-Chatbot is private so CI cannot clone it — an
// ancestor-dependent test is a test that silently never runs. The fixture
// reproduces the structures that matter (a contact line with the country code, a
// price list with real-looking figures), which is what the predicate reasons about.
//
// The separate real-prefix assertion lives in real-prefix.test.mjs and skips when
// the ancestor is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Must stay identical to run.mjs. Duplicated deliberately: the gate is the thing
// under test, and importing it from a module that requires the ancestor checkout
// would reintroduce the dependency this file exists to remove.
const PHONE_NOISE = /\+?\s*976|7741[-\s]?7777/g;
const digitsOf = (t) => new Set((t.replace(PHONE_NOISE, ' ').match(/[\d][\d.,\s]*\d|\d/g) || [])
  .map(m => m.replace(/\D/g, '')).filter(d => d.length >= 3));

const PREFIX = `
=== ХОЛБОО БАРИХ МЭДЭЭЛЭЛ ===
Утас: +976 7741 7777
=== ҮНИЙН ЖАГСААЛТ ===
Эмэгтэй тайралт (1-р зэрэг): 55,000₮
Гарын спа: 30,000₮
Будаггүй маникюр: 25,000₮
=== УРЬДЧИЛГАА ТӨЛБӨРИЙН ДҮРЭМ ===
Мастер үсчин: 20,000₮ урьдчилгаа
1-р зэргийн үсчин: 10,000₮ урьдчилгаа
`;
const ALLOWED = digitsOf(PREFIX);
const ungrounded = (reply) => [...digitsOf(reply)].filter(d => !ALLOWED.has(d));
const noNumberAtAll = (reply) => !/\d{3,}/.test(reply.replace(PHONE_NOISE, ' '));

test('the country code never trips the gate, in any phone format', () => {
  // Regression. The allowed set was built from unstripped text — where
  // "+976 7741 7777" collapses into a single 11-digit run — while replies were
  // checked stripped, leaving a bare 976 outside the set. Every reply quoting the
  // international number was flagged as inventing a figure.
  for (const r of [
    'Та +976 7741 7777 дугаараар холбогдоно уу.',
    'Утас: +976 7741 7777',
    'Та 7741-7777 руу залгана уу.',
    '+97677417777',
  ]) assert.deepEqual(ungrounded(r), [], `false positive on: ${r}`);
});

test('real prices stay grounded', () => {
  // Including the master-stylist deposit a review initially read as invented. It is
  // in the prefix (systemPromptBuilder.js:148 in the real one) and must never flag.
  for (const r of [
    'Мастер үсчинд цаг авахад 20,000₮ урьдчилгаа шаардлагатай.',
    'Гарын спа 30,000₮.',
    'Будаггүй маникюр 25,000₮.',
  ]) assert.deepEqual(ungrounded(r), [], `false positive on: ${r}`);
});

test('genuinely invented figures are caught', () => {
  assert.deepEqual(ungrounded('Энэ үйлчилгээ 47,500₮ байна.'), ['47500']);
  assert.deepEqual(ungrounded('Урьдчилгаа 33,333₮.'), ['33333']);
});

test('KNOWN LIMIT: a real price quoted for the wrong service is NOT caught', () => {
  // The gate asks whether a number appears in the prefix, not whether it is the
  // right number for the question. A children's haircut quoted at 30,000₮ passes,
  // because 30,000₮ is a genuine price — for a hand spa.
  //
  // This is the price-by-inference failure the ancestor produced, and it is why
  // price_unlisted carries the stricter no-number-at-all rule instead of relying on
  // this gate. Pinned so the limit is not mistaken for coverage.
  assert.deepEqual(ungrounded('Хүүхдийн тайралт 30,000₮.'), []);
  assert.equal(noNumberAtAll('Хүүхдийн тайралт 30,000₮.'), false, 'the stricter rule must catch it');
  assert.equal(noNumberAtAll('Уучлаарай, та 7741-7777 руу залгана уу.'), true);
});
