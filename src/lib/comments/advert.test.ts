/**
 * Another seller's advert, decided on its words (`advert.ts`, founder 2026-09-28).
 *
 * The first case is the real advert from `webhook_events` 1094, byte for byte. Every other
 * case is a customer writing one of the same signals, which must NOT read as an advert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advertByText, isRepeatedComment } from './advert.ts';
import { SELLER_ADVERTS } from './realThreads.fixtures.ts';
import { EXAMPLES, REAL_COMMENTS } from './salonCorpus.fixtures.ts';

test('27 Sept: the real advert is an advert, on all three signals', () => {
  for (const c of SELLER_ADVERTS) {
    assert.deepEqual(advertByText(c.message ?? ''), { advert: true, signals: ['seller_words', 'phone', 'price'] });
  }
});

const ADVERTS: readonly string[] = [
  'Маск зарна 45000',
  'Маск зарна, 9903-3966',
  'Үсний тос маш хямдхан зарна ☎️ 9903 3966',
  'Японы шампунь 35000₮ 88112233',
  'Бөөний үнээр 25,000₮',
  'Хүргэлттэй 99887766',
  'maska zarna 45000',
  'Захиалга авна 45000 төгрөг',
];

for (const text of ADVERTS) {
  test(`an advert: «${text}»`, () => {
    assert.equal(advertByText(text).advert, true);
  });
}

const CUSTOMERS: readonly string[] = [
  '99112233 руу залгаарай',
  '45000 уу?',
  'Та нар маск зарна уу?',
  'Маск зарна уу 45000?',
  'Үнэ нь 45000 үү? 99112233 руу залгаад өгөөч',
  'Будалт 120000 гэсэн үнэн үү 88112233',
  'Зэсэн улаан туяа арилдагуу',
  'Хүргэлттэй юу?',
  '2 удаа будуулсан, 3 цаг болох уу?',
  'Үнэ хэд вэ?',
  'Цаг авъя 77417777',
];

for (const text of CUSTOMERS) {
  test(`a customer, not an advert: «${text}»`, () => {
    assert.equal(advertByText(text).advert, false);
  });
}

test('no real comment and no written example in the salon corpus reads as an advert', () => {
  const all = [...REAL_COMMENTS, ...Object.values(EXAMPLES).flat()];
  const flagged = all.filter((en) => advertByText(en.text).advert).map((en) => en.text);
  assert.deepEqual(flagged, []);
});

test('a repeat is the same long comment again, read on the reduced form', () => {
  const ad = SELLER_ADVERTS[0]!.message ?? '';
  assert.equal(isRepeatedComment(ad, [ad]), true);
  assert.equal(isRepeatedComment(ad, [`${ad} ❤️`]), true, 'one more heart is still a copy');
  assert.equal(isRepeatedComment(ad, ['Үнэ хэд вэ?']), false);
  assert.equal(isRepeatedComment(ad, []), false);
  assert.equal(isRepeatedComment('Үнэ хэд вэ?', ['Үнэ хэд вэ?']), false, 'a short question asked twice is asked twice');
});
