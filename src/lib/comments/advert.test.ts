/**
 * Another seller's advert, decided on its words (`advert.ts`, founder 2026-09-28).
 *
 * The first case is the real advert from `webhook_events` 1094, byte for byte. Every other
 * case is a customer writing one of the same signals, which must NOT read as an advert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advertByText, asksSomething, isRepeatedComment, REPEAT_WINDOW_MS } from './advert.ts';
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
  // A greeting that ends in «уу» is not a question.
  'Сайн байна уу маск зарна 45000 99112233',
  'Сайн байна уу? Маск зарна 45000',
  'Үнэ 5000₮ 99112233',
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
  // Review, 2026-09-28: a phone and a clock time or a date is a booking, not a price.
  'Цаг авъя 99112233 18:30',
  'Маргааш 14:00 цагт цаг авах 99112233',
  'Цаг авах гэсэн 99112233 руу залгаарай 10:00 цагаас хойш',
  '2026.10.02 өдөр цаг авъя 99112233',
  '99112233 10/02 ирнэ',
  // A question anywhere, not only right after the seller word.
  'Бөөний үнэ 45000 уу?',
  'Та нар зарна гэсэн, 45000 үү?',
  'Будалтын үнэ 45000 уу? хүргэлттэй бол 99112233',
  'Хүргэлттэй бол 99112233 руу залгаарай',
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

test('stated limit: a phone and a price with no question reads as an advert', () => {
  // A customer relaying a price and a number without asking is indistinguishable, on the
  // words, from a seller. Recorded as `comment_advert`, so it can be counted.
  assert.equal(advertByText('Үнэ 45000 гэсэн, 99112233 руу залгаарай').advert, true);
});

test('a greeting is not a question; a question after it is', () => {
  assert.equal(asksSomething('Сайн байна уу маск зарна'), false);
  assert.equal(asksSomething('Сайн байна уу? маск зарна'), false);
  assert.equal(asksSomething('Сайн байна уу, маск зарна уу'), true);
  assert.equal(asksSomething('Сайн байна уу? маск зарна?'), true);
  assert.equal(asksSomething('Зэсэн улаан туяа арилдагуу'), true);
});

const at = (ms: number) => new Date(Date.UTC(2026, 8, 27, 14, 31) + ms);

test('a repeat is the same long statement again within a day, read on the reduced form', () => {
  const ad = SELLER_ADVERTS[0]!.message ?? '';
  const c = { text: ad, createdAt: at(0) };
  assert.equal(isRepeatedComment(c, [{ text: ad, createdAt: at(-5_000) }]), true);
  assert.equal(isRepeatedComment(c, [{ text: `${ad} ❤️`, createdAt: at(-5_000) }]), true, 'one more heart is still a copy');
  assert.equal(isRepeatedComment(c, [{ text: ad, createdAt: at(-REPEAT_WINDOW_MS - 1) }]), false, 'outside the window');
  assert.equal(isRepeatedComment(c, [{ text: 'Үнэ хэд вэ?', createdAt: at(-5_000) }]), false);
  assert.equal(isRepeatedComment(c, []), false);
  const short = { text: 'Үнэ хэд вэ?', createdAt: at(0) };
  assert.equal(isRepeatedComment(short, [{ text: 'Үнэ хэд вэ?', createdAt: at(-5_000) }]), false, 'a short question asked twice is asked twice');
  const long = 'Сайн байна уу, энэ будгийг хийлгэхэд хэр удаан хугацаа шаардагдах вэ?';
  assert.equal(isRepeatedComment({ text: long, createdAt: at(0) }, [{ text: long, createdAt: at(-5_000) }]), false,
    'a long QUESTION re-posted is a customer asking again');
});
