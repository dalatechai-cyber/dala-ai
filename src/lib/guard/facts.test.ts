import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, checkFacts, factSourceFrom } from './facts.ts';

const LABELS = { priceList: 'ҮНИЙН ЖАГСААЛТ', deposits: 'УРЬДЧИЛГАА ТӨЛБӨР', hours: 'АЖЛЫН ЦАГ', contacts: 'ХОЛБОО БАРИХ' };
// Matrix's live rows, trimmed (seq 15, 2026-09-24).
const PREFIX = [
  '=== ҮНИЙН ЖАГСААЛТ ===', '- CMC тэжээл: 132,000₮', '- Афро хими: 430,000₮–510,000₮',
  '- Шулуун хими: 430,000₮–510,000₮', '- Усан хими: 132,000₮–154,000₮', '- Хими арчилт: 154,000₮',
  '=== УРЬДЧИЛГАА ТӨЛБӨР ===', '- 1-р зэргийн үсчин: 10,000₮', '- Мастер үсчин: 20,000₮',
  '=== АЖЛЫН ЦАГ ===', '- Даваа: 10:00 - 20:00', '- Ням: 11:00 - 19:00',
  '=== ХОЛБОО БАРИХ ===', '- Хаяг: Яармагийн Номин Хайпермаркетын баруун талд',
  '- Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16', '- Утас: 76001888, 80905498',
].join('\n');
const BOOKING = 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
const HANDOFF = 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.';
const SRC = factSourceFrom(PREFIX, LABELS, [BOOKING, HANDOFF]);

function served(reply: string): string | null {
  const r = checkFacts(reply, SRC);
  return r.restated ? r.served : null;
}

test('amounts: four digits or a clock time; «мянга» and «цаг» are read as the amounts they are', () => {
  assert.deepEqual(amountsIn('1-р зэрэг 3-5 удаа 30 хувь').map((a) => a.digits), []);
  assert.deepEqual(amountsIn('430 мянга, 10 цагаас, 19:00, 430 000').map((a) => a.digits), ['430000', '1000', '1900', '430000']);
});

test('DONE-TEST: THE LIVE «Усны хими 132,000₮–154,000₮» GETS THE ONE ROW THE RANGE BELONGS TO', () => {
  // 132,000 has two owners and 154,000 has two; the range has one.
  assert.equal(served('Усны хими 132,000₮–154,000₮ байна.'), 'Усан хими: 132,000₮–154,000₮');
});

test('text the platform approved passes untouched: a row quoted whole, a reviewed line, a bare phone', () => {
  for (const ok of [
    'Усан хими: 132,000₮–154,000₮ байна.',
    `Мастер үсчин: 20,000₮\n1-р зэргийн үсчин: 10,000₮\n\n${BOOKING}`,
    HANDOFF,
    'Та 80905498 дугаар руу залгаарай.',
    'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд',
    'Сайн байна уу! Танд юугаар туслах вэ?',
  ]) assert.equal(checkFacts(ok, SRC).restated, false, ok);
});

test('each kind of fact, restated, is served from its row', () => {
  assert.equal(served('Шулуун хими 430 мянгаас 510 мянган төгрөг.'), 'Шулуун хими: 430,000₮–510,000₮');
  assert.equal(served('Мастерт 20,000₮ урьдчилгаа төлнө.'), 'Мастер үсчин: 20,000₮');
  assert.equal(served('Та 7600-1888 руу залгаарай.'), 'Утас: 76001888, 80905498');
  assert.equal(served('Манай салон Номин Хайпермаркетын баруун талд байдаг.'), 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд');
});

test('hours are one fact, the week: the day that differs is served too', () => {
  assert.equal(served('Бид өдөр бүр 10:00-20:00 цагт ажилладаг.'), 'Даваа: 10:00 - 20:00\nНям: 11:00 - 19:00');
});

test('a booking answer keeps its booking line when its deposits are restated', () => {
  assert.equal(served(`Мастерт 20,000₮, 1-р зэрэгт 10,000₮. ${BOOKING}`),
    `Мастер үсчин: 20,000₮\n1-р зэргийн үсчин: 10,000₮\n${BOOKING}`);
});

test('a number that is no fact row\'s is not this check\'s business', () => {
  // An invented price is `outboundGuard`'s allow-list refusal; this check is about a REAL
  // fact in the model's words.
  assert.equal(checkFacts('Энэ нь 99,999₮ болно.', SRC).restated, false);
});

test('DONE-TEST: A PRICE NO ROW CAN BE SHOWN TO OWN IS REFUSED, NOT GUESSED', () => {
  // Measured in Matrix's corpus: «Маникюр хэд вэ?» answered from a superseded nail list with
  // 430,000 in it would otherwise be served a perm's price. No range partner, no word of an
  // owner's name in the reply or the question: `served` is null and the caller hands off.
  const r = checkFacts('Гелэн будалт: 154 мянга.', SRC, 'Маникюр хэд вэ?');
  assert.equal(r.restated, true);
  assert.equal(r.restated && r.served, null);
  // The same amount with its owner's name in the QUESTION is corroborated.
  const named = checkFacts('Энэ 154 мянга.', SRC, 'Хими арчилт хэд вэ?');
  assert.equal(named.restated && named.served, 'Хими арчилт: 154,000₮');
});

test('DONE-TEST: TWO PRICES ON ONE LINE ARE NOT A RANGE — a CICA answer is never served «Хуримын засалт»', () => {
  // The 2026-09-25 bake-off, both models, live prompt seq 15: the reply named CICA and its
  // two prices; the one row holding BOTH numbers was the wedding styling range, and reading
  // the pair as a range served it to a customer who asked about CICA.
  const src = factSourceFrom([
    '=== ҮНИЙН ЖАГСААЛТ ===', '- CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮',
    '- CICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮',
    '- Хуримын засалт: 154,000₮–198,000₮', '- Эмчилгээний хими: 220,000₮–255,000₮',
  ].join('\n'), LABELS, []);
  const r = checkFacts('CICA нэртэй хими гэсэн үйлчилгээ манайд байхгүй. CICA бол хими биш, харин үсний нөхөн сэргээх эмчилгээ бөгөөд үнэ нь 198,000₮ (курсээр 154,000₮) байна.', src, 'CICA хими байгаа юу?');
  assert.equal(r.restated, true);
  assert.equal(r.restated && r.served,
    'CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮\nCICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮');
  // A range written as one still names its one row.
  const w = checkFacts('Хуримын засалт 154,000₮–198,000₮ байна.', src);
  assert.equal(w.restated && w.served, 'Хуримын засалт: 154,000₮–198,000₮');
});
