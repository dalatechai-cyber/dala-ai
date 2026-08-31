// Unit tests for the ungrounded-numeral gate, against the REAL Matrix prefix.
//
// Testing against a toy prefix is how the first version of these tests passed while
// asserting the wrong thing: 30,000 and 25,000 are real Matrix prices (Гарын спа,
// Будаггүй маникюр), so expecting them to be flagged was the test being wrong, not
// the gate. Fixtures that do not match production teach you the wrong lesson.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrixPrefix } from '../prefix.mjs';

const PHONE_NOISE = /\+?\s*976|7741[-\s]?7777/g;
const digitsOf = (t) => new Set((t.replace(PHONE_NOISE, ' ').match(/[\d][\d.,\s]*\d|\d/g) || [])
  .map(m => m.replace(/\D/g, '')).filter(d => d.length >= 3));

const prefix = await buildMatrixPrefix(process.env.ANCESTOR || undefined);
const ALLOWED = digitsOf(prefix);
const ungrounded = (reply) => [...digitsOf(reply)].filter(d => !ALLOWED.has(d));

test('the country code never trips the gate, in any phone format', () => {
  // Regression: the allowed set was built unstripped (where "+976 7741 7777"
  // collapses to one 11-digit run) while replies were checked stripped, leaving a
  // bare 976 that was not in the set. Every reply quoting the international number
  // was flagged as inventing a figure.
  for (const r of [
    'Та +976 7741 7777 дугаараар холбогдоно уу.',
    'Утас: +976 7741 7777',
    'Та 7741-7777 руу залгана уу.',
    '+97677417777',   // no separators at all
  ]) assert.deepEqual(ungrounded(r), [], `false positive on: ${r}`);
});

test('real prices stay grounded', () => {
  // Including the master-stylist deposit a native-speaker review initially read as
  // invented. It is in systemPromptBuilder.js:148 and must never be flagged.
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
  // The gate asks "does this number appear in the prefix", not "is it the right
  // number for the question asked". A children's haircut quoted at 30,000₮ passes,
  // because 30,000₮ is a genuine price — for a hand spa.
  //
  // This is exactly the price-by-inference failure the ancestor produced, and it is
  // why the price_unlisted probe carries the stricter no-number-at-all rule instead
  // of relying on this gate. Pinned so the limit is not mistaken for coverage.
  assert.deepEqual(ungrounded('Хүүхдийн тайралт 30,000₮.'), []);

  const noNumberAtAll = (reply) => !/\d{3,}/.test(reply.replace(PHONE_NOISE, ' '));
  assert.equal(noNumberAtAll('Хүүхдийн тайралт 30,000₮.'), false, 'the stricter rule must catch it');
  assert.equal(noNumberAtAll('Уучлаарай, та 7741-7777 руу залгана уу.'), true);
});
