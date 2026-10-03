import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourOn, parseWhen } from './when.ts';

// Friday 2 October 2026 on the tenant's clock.
const today = { date: '2026-10-02', weekday: 5 };
const at = (text: string, weekdays = true) => {
  const w = parseWhen(text, today, { weekdays });
  return w === null ? null : { date: w.date, at: hourOn(w, 10 * 60, 20 * 60) };
};

test('BOOKING when: the day words, Cyrillic and Latin, with their case endings', () => {
  assert.deepEqual(at('Маргааш 2 цагт'), { date: '2026-10-03', at: 14 * 60 });
  assert.deepEqual(at('маргаашийн 14:30'), { date: '2026-10-03', at: 14 * 60 + 30 });
  assert.deepEqual(at('margaash 14 tsagt'), { date: '2026-10-03', at: 14 * 60 });
  assert.deepEqual(at('өнөөдрийн 5 цагт'), { date: '2026-10-02', at: 17 * 60 });
  assert.deepEqual(at('нөгөөдөр'), { date: '2026-10-04', at: null });
  assert.deepEqual(at('Баасан гарагт оройн 6'), { date: '2026-10-02', at: 18 * 60 }, 'Friday is today');
  assert.deepEqual(at('нямд 11 цагт'), { date: '2026-10-04', at: 11 * 60 });
  assert.deepEqual(at('Даваа гарагт'), { date: '2026-10-05', at: null });
});

test('BOOKING when: dates as Mongolian writes them, and the next one when this year\'s has passed', () => {
  assert.deepEqual(at('10 сарын 15-нд 14:00'), { date: '2026-10-15', at: 14 * 60 });
  assert.deepEqual(at('10-р сарын 15'), { date: '2026-10-15', at: null });
  assert.deepEqual(at('15нд'), { date: '2026-10-15', at: null });
  assert.deepEqual(at('1-нд 12 цаг'), { date: '2026-11-01', at: 12 * 60 }, 'the 1st has passed: next month');
  assert.deepEqual(at('1-р сарын 3'), { date: '2027-01-03', at: null });
  assert.equal(at('2 сарын 30'), null, 'not a date: asked again, never guessed');
});

test('BOOKING when: a time alone, and what is not a time', () => {
  assert.deepEqual(at('14'), { date: null, at: 14 * 60 });
  assert.deepEqual(at('16 цаг'), { date: null, at: 16 * 60 });
  assert.deepEqual(at('14.30'), { date: null, at: 14 * 60 + 30 });
  assert.deepEqual(at('маргааш 14'), { date: '2026-10-03', at: 14 * 60 });
  assert.deepEqual(at('Маргааш 2 хүн'), { date: '2026-10-03', at: null }, 'two people, not two o\'clock');
  assert.deepEqual(at('Маргааш 10 цагт 2 хүн'), { date: '2026-10-03', at: 10 * 60 });
  assert.equal(at('25 цагт'), null);
  assert.equal(at('Цаг авъя'), null);
  assert.equal(at('хэзээ ч болно'), null);
});

test('BOOKING when: a word counts only whole, so a name is not a weekday', () => {
  assert.equal(at('Нямбаяр байна'), null);
  assert.equal(at('Баасанжав'), null);
  assert.equal(at('Баасан', false), null, 'in a first message weekday names are not read');
  assert.deepEqual(at('Маргааш', false), { date: '2026-10-03', at: null });
});

test('BOOKING when: «2» is 14:00 only when the salon is shut at 2 and open at 14', () => {
  const w = parseWhen('2 цагт', today);
  assert.ok(w !== null);
  assert.equal(hourOn(w, 10 * 60, 20 * 60), 14 * 60);
  assert.equal(hourOn(w, 0, 24 * 60), 2 * 60, 'open at 2: taken as typed');
  const morning = parseWhen('11 цагт', today);
  assert.ok(morning !== null);
  assert.equal(hourOn(morning, 10 * 60, 20 * 60), 11 * 60);
  assert.deepEqual(at('оройн 7'), { date: null, at: 19 * 60 });
  assert.equal(at('7 хүн'), null, 'a bare number inside words, with no day or evening, is not a time');
});

test('BOOKING when: the review\'s cases — minutes are not a day, two days are not guessed between', () => {
  assert.deepEqual(at('маргааш 14:30-нд'), { date: '2026-10-03', at: 14 * 60 + 30 }, 'the «30» of 14:30 is minutes');
  assert.equal(at('маргааш 11-нд'), null, 'tomorrow AND the 11th: asked again, never the 11th');
  assert.equal(at('Маргааш 1-нд ирье'), null);
  assert.equal(at('маргааш 2 цаг 30-нд'), null);
  assert.equal(at('маргааш биш, нөгөөдөр'), null, 'a day ruled out');
  assert.equal(at('маргааш биш'), null);
  assert.equal(at('Маргааш эсвэл нөгөөдөр'), null, 'two days');
});

test('BOOKING when: morning and afternoon words', () => {
  assert.deepEqual(at('Маргааш үдээс өмнө 10 цагт'), { date: '2026-10-03', at: 10 * 60 }, '«үдээс өмнө» is the morning');
  assert.deepEqual(at('үдээс хойш 3 цагт'), { date: null, at: 15 * 60 });
  assert.deepEqual(at('өглөө 7 цагт'), { date: null, at: 7 * 60 }, 'morning: as typed, even when the salon is shut then');
  assert.equal(at('өглөө орой 7'), null);
});

test('BOOKING when: «цаг» is a whole word; half past and minutes', () => {
  assert.equal(at('2 цагийн дараа'), null, 'in two hours is not two o\'clock');
  assert.deepEqual(at('2 цаг хагаст'), { date: null, at: 14 * 60 + 30 });
  assert.deepEqual(at('маргааш 2 цаг 30 минутад'), { date: '2026-10-03', at: 14 * 60 + 30 });
  assert.deepEqual(at('margaash 2 tsag hagast'), { date: '2026-10-03', at: 14 * 60 + 30 });
  assert.deepEqual(at('14 цагаас'), { date: null, at: 14 * 60 });
  assert.deepEqual(at('маргааш 50'), { date: '2026-10-03', at: null }, 'not an hour: the day still stands');
});

test('BOOKING when: «цагийн үед» and «цагаар» are a time; «цагийн дараа» is not', () => {
  assert.deepEqual(at('маргааш 14 цагийн үед'), { date: '2026-10-03', at: 14 * 60 });
  assert.deepEqual(at('маргааш 2 цагаар'), { date: '2026-10-03', at: 14 * 60 });
  assert.equal(at('2 цагийн дараа'), null);
});
