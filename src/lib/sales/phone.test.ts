import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPhones, maskPhone, maskPhonesInText, publishedNumbers } from './phone.ts';

const found = (text: string, own: string[] = []): string[] => detectPhones(text, own).map((p) => p.digits);

test('eight digits, joined, halved, paired, dashed, dotted, with and without the country code', () => {
  for (const text of [
    '99112233',
    '9911 2233',
    '9911-2233',
    '9911.2233',
    '99 11 22 33',
    '99-11-22-33',
    '+976 9911 2233',
    '+97699112233',
    '976-9911-2233',
    '9911 2233',
  ]) {
    assert.deepEqual(found(text), ['99112233'], text);
  }
});

test('Cyrillic and Latin messages around the number', () => {
  assert.deepEqual(found('Миний утас 8811-2233, Бат гэдэг'), ['88112233']);
  assert.deepEqual(found('minii dugaar 88112233 Bat'), ['88112233']);
  assert.deepEqual(found('Дугаар:88112233.'), ['88112233']);
  assert.deepEqual(found('88112233 руу залгаарай'), ['88112233']);
  assert.deepEqual(found('utas 95112233 eswel 88112233'), ['95112233', '88112233']);
});

test('full-width digits from a phone keyboard read as digits', () => {
  assert.deepEqual(found('９９１１２２３３'), ['99112233']);
});

test('PRICES are never phones', () => {
  for (const text of [
    'Эмэгтэй тайралт 55,000₮',
    '250,000',
    '1,500,000₮',
    '250 000₮',
    '12 500 000',
    '12 500 000 төг',
    '80 000 000',
    '88112233₮',
    '88112233 төгрөг',
    'ug buduulah ni 135k gsn vgvv',
    'Үсний угийн будаг: 135,000₮',
  ]) {
    assert.deepEqual(found(text), [], text);
  }
});

test('TIMES and ranges are never phones', () => {
  for (const text of ['10:00', '10:00-20:00', '10:00 - 20:00', 'Даваа: 10:00 - 20:00', '2026-09-26', '09-26 14:16']) {
    assert.deepEqual(found(text), [], text);
  }
});

test('a digit run that is not eight digits is not a phone, separators included', () => {
  for (const text of ['9911223', '991122334', '9911223344', '9911 2233 44', '12 9911 2233', 'Oiroltsoogoor 80cm urt']) {
    assert.deepEqual(found(text), [], text);
  }
});

test('numbers that cannot be Mongolian subscriber numbers are refused by their first digit', () => {
  for (const text of ['12345678', '20000000', '4411 2233']) assert.deepEqual(found(text), [], text);
});

test('a number inside a link is never a phone', () => {
  assert.deepEqual(found('https://maps.app.goo.gl/88112233xyz'), []);
  assert.deepEqual(found('www.example.com/?id=99112233 bolon 88112233'), ['88112233']);
});

test("THE TENANT'S OWN NUMBERS are not leads: a customer quoting them back is not giving theirs", () => {
  const own = publishedNumbers(['Утас: 76001888, 80905498']);
  assert.deepEqual(own, ['76001888', '80905498']);
  assert.deepEqual(found('76001888 руу залгасан авахгүй байна', own), []);
  assert.deepEqual(found('7600-1888 гэдэг рүү залгасан, миний дугаар 99112233', own), ['99112233']);
});

test('the same number twice is one hit', () => {
  assert.deepEqual(found('99112233, дахиад 9911-2233'), ['99112233']);
});

test('masking keeps four digits and never the rest', () => {
  assert.equal(maskPhone('76001888'), '7600****');
  assert.equal(maskPhone('123'), '********');
  const hits = detectPhones('Миний утас 8811-2233', []);
  assert.deepEqual(hits.map((h) => h.masked), ['8811****']);
});

test('maskPhonesInText masks every phone in a quote, the rest byte for byte', () => {
  assert.equal(maskPhonesInText('utasaa 76001888 taviad'), 'utasaa 7600**** taviad');
  assert.equal(maskPhonesInText('Миний утас 8811-2233, баярлалаа'), 'Миний утас 8811****, баярлалаа');
  assert.equal(maskPhonesInText('Эмэгтэй тайралт 55,000₮ 10:00'), 'Эмэгтэй тайралт 55,000₮ 10:00');
});
