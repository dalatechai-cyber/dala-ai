import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, checkFactCopies, type FactService } from './consistency.ts';

// Rows shaped like a tenant's price list: «Name — label», amounts from its variants.
const SERVICES: FactService[] = [
  { name: 'Вира — маркетинг менежер', amounts: [50000, 350000] },
  { name: 'Дали — AI хүлээн авагч', amounts: [50000, 250000] },
  { name: 'Эхо — утасны оператор', amounts: [] },
  { name: 'Вэбсайт + Дали багц', amounts: [800000] },
];
const copy = (text: string) => [{ source: 'faq', text }];

test('DONE-TEST (2026-09-27): «Маркетинг менежер» after the name is a second spelling', () => {
  const f = checkFactCopies(SERVICES, copy('Вира бол Маркетинг менежер.'));
  assert.equal(f.length, 1);
  assert.equal(f[0]?.kind, 'spelling');
  assert.match(f[0]?.detail ?? '', /«Маркетинг менежер»/u);
  assert.equal(checkFactCopies(SERVICES, copy('Вира — Маркетинг менежер')).length, 1);
});

test('the row\'s own spelling, and a capital at the start of a sentence, agree', () => {
  assert.deepEqual(checkFactCopies(SERVICES, copy('Вира — маркетинг менежер. Маркетинг менежер таны постыг бэлдэнэ.')), []);
  assert.deepEqual(checkFactCopies(SERVICES, copy('Маркетинг менежер хэрэгтэй юу?')), []);
});

test('a price no row carries, on a line naming the service, is a second price', () => {
  const f = checkFactCopies(SERVICES, copy('Вира: 300,000₮/сар'));
  assert.equal(f.length, 1);
  assert.equal(f[0]?.kind, 'price');
  assert.match(f[0]?.detail ?? '', /300,000₮/u);
});

test('suffixed names count («Далигийн»), and every amount a named service carries is fine', () => {
  assert.deepEqual(checkFactCopies(SERVICES, copy('Далигийн сарын төлбөр 250,000₮, суурилуулалт 50 000 ₮.')), []);
  assert.equal(checkFactCopies(SERVICES, copy('Далигийн сарын төлбөр 150,000 төгрөг')).length, 1);
});

test('a bundle line may state the bundle\'s price and its parts\' prices', () => {
  assert.deepEqual(checkFactCopies(SERVICES, copy('Вэбсайт + Дали багц — 800,000₮. Хоёр дахь сараас Дали 250,000₮/сар.')), []);
});

test('a service with no price: any amount beside it is wrong', () => {
  assert.equal(checkFactCopies(SERVICES, copy('Эхо 200,000₮')).length, 1);
});

test('a line naming no service is not read for a price; counts without ₮ are not prices', () => {
  assert.deepEqual(checkFactCopies(SERVICES, copy('НӨАТ 10%, жилийн төлбөрт 15% хөнгөлөлт. 999₮')), []);
  assert.deepEqual(checkFactCopies(SERVICES, copy('Дали сард 1,500 мессеж')), []);
});

test('a name inside a longer word is not the service', () => {
  assert.deepEqual(checkFactCopies(SERVICES, copy('Хувиралтын 999₮')), []);
  assert.deepEqual(amountsIn('1,000 SMS, нэмэлт SMS тутам 50₮, 49 000₮'), [50, 49000]);
});

test('a short name is the service only as a whole word or with a case ending («сорри» is not «Сор»)', () => {
  const S: FactService[] = [{ name: 'Сор', amounts: [120000] }, { name: 'Үндэс', amounts: [50000] }];
  assert.deepEqual(checkFactCopies(S, copy('Сорри, захиалга 20,000₮ урьдчилгаатай')), []);
  assert.deepEqual(checkFactCopies(S, copy('Монгол үндэсний хоол 20,000₮')), []);
  assert.equal(checkFactCopies(S, copy('Сор 99,000₮')).length, 1);
  assert.equal(checkFactCopies(S, copy('Сорын үнэ 99,000₮')).length, 1, '«Сорын» is «Сор» with its genitive ending');
});

test('a capital after a bullet, an emoji, a number or a quote is the start of a line', () => {
  for (const t of ['💬 Маркетинг менежер', '1) Маркетинг менежер', "'Маркетинг менежер'", '- Маркетинг менежер']) {
    assert.deepEqual(checkFactCopies(SERVICES, copy(t)), [], t);
  }
});

test('a dot as the thousands separator is still the amount', () => {
  assert.deepEqual(amountsIn('350.000₮'), [350000]);
  assert.deepEqual(checkFactCopies(SERVICES, copy('Вира 350.000₮')), []);
});

test('a copy marked spelling-only is never read for a price (the platform\'s example prices)', () => {
  assert.deepEqual(checkFactCopies(SERVICES, [{ source: 'platform', text: 'Вира 1₮', prices: false }]), []);
  assert.equal(checkFactCopies(SERVICES, [{ source: 'platform', text: 'Вира бол Маркетинг менежер', prices: false }]).length, 1);
});
