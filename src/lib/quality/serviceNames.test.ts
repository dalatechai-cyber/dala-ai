import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceNameReport, servicesFromPrefix, faqAnswersFromPrefix } from './serviceNames.ts';

// Matrix's real dye names and prices, and the model's real rewrite of them, 2026-09-21.
const SERVICES = [
  { name: 'Үсний угийн будаг', prices: ['135000'], rows: [] },
  { name: 'Дунд үсний будаг', prices: ['176000'], rows: [] },
  { name: 'Урт үсний будаг', prices: ['200000'], rows: [] },
  { name: 'Сор', prices: ['120000', '190000'], rows: [] },
  { name: 'Шулуун хими', prices: ['430000', '510000'], rows: [] },
];

test('DONE-TEST: THE MEASURED REWRITE IS CAUGHT', () => {
  // Verbatim from the run: the name replaced by a gloss, the price kept.
  const r = serviceNameReport(
    'Будалтын үнэ урт, төрлөөс хамаарна:\n\nДунд урттай үс (мөрнөөс дээш): 176,000₮\n'
    + 'Урт үс (мөр давсан): 200,000₮\nҮсний угийн будаг: 135,000₮', SERVICES);
  assert.deepEqual(r.altered, ['Дунд үсний будаг', 'Урт үсний будаг']);
  assert.deepEqual(r.exact, ['Үсний угийн будаг'], 'the one it got right is not reported');
});

test('DONE-TEST: AN INNOCENT REPLY FLAGS NOTHING — the bug this version replaces', () => {
  // Measured 2026-09-21: the longest-token version reported «Дунд үсний будаг» AND «Урт
  // үсний будаг» as renamed here, because both reduce to the head «үсний» — *of hair*.
  // This is a clarifying question about hair length. It renames nothing and quotes no price.
  assert.deepEqual(serviceNameReport('Танай үсний урт ямар вэ?', SERVICES).altered, []);
  // The same shape for the other three the old head test collapsed onto common words.
  assert.deepEqual(serviceNameReport('Энэ бол тусдаа нөхөн сэргээх эмчилгээ юм.',
    [{ name: 'CICA нөхөн сэргээх эмчилгээ', prices: ['198000'], rows: [] }]).altered, []);
  assert.deepEqual(serviceNameReport('Манайд тэжээл байгаа.',
    [{ name: 'CMC тэжээл', prices: ['132000'], rows: [] }]).altered, []);
  assert.deepEqual(serviceNameReport('Тайралт хийлгэх үү?',
    [{ name: 'Чёлк тайралт', prices: ['22000'], rows: [] }]).altered, []);
});

test('DONE-TEST: names written exactly are never reported', () => {
  const r = serviceNameReport(
    'Үсний угийн будаг: 135,000₮\nДунд үсний будаг: 176,000₮\nУрт үсний будаг: 200,000₮', SERVICES);
  assert.deepEqual(r.altered, []);
  assert.equal(r.exact.length, 3);
});

test('DONE-TEST: a service the reply never mentions is NOT an alteration', () => {
  const r = serviceNameReport('Сор: 120,000₮–190,000₮ байна.', SERVICES);
  assert.deepEqual(r.altered, []);
  assert.deepEqual(r.exact, ['Сор']);
});

test('a price two services share cannot say which one was meant', () => {
  const shared = [
    { name: 'Эрэгтэй тайралт', prices: ['66000'], rows: [] },
    { name: 'Эмэгтэй тайралт', prices: ['66000'], rows: [] },
  ];
  assert.deepEqual(serviceNameReport('Тайралт 66,000₮ байна.', shared).altered, [],
    'quoting 66,000 says which AMOUNT, not which SERVICE');
});

test('the price test is the digits-only reduction, not a substring test', () => {
  // `20` must not match `20,000` — the rule the price guarantee already rests on.
  assert.deepEqual(serviceNameReport('20 хувийн хөнгөлөлт.',
    [{ name: 'Тонирование', prices: ['20000'], rows: [] }]).altered, []);
  // And the separator does not matter: 176 000 is 176,000.
  assert.deepEqual(serviceNameReport('Дунд урттай үс: 176 000₮',
    [{ name: 'Дунд үсний будаг', prices: ['176000'], rows: [] }]).altered, ['Дунд үсний будаг']);
});

test('a number too short to be a price is never evidence about a service', () => {
  // The four-digit floor, exercised so it can FAIL. A price list line whose figure is a
  // session count or a percentage — «- CICA курс (3 удаа): 3» — must not make the bare `3`
  // in an unrelated sentence say the reply renamed that service. Without the floor this
  // reports «CICA курс», which is the whole class of small-number coincidences the
  // digits-only reduction exists to refuse.
  const shortPriced = servicesFromPrefix('=== ҮНИЙН ЖАГСААЛТ ===\n- CICA курс (3 удаа): 3', 'ҮНИЙН ЖАГСААЛТ');
  assert.deepEqual(shortPriced, [{ name: 'CICA курс', prices: [], rows: ['CICA курс (3 удаа): 3'] }],
    'a sub-four-digit figure is not collected as a price at all');
  assert.deepEqual(serviceNameReport('Нэг курс нь 3 удаа.', shortPriced).altered, []);
});

test('matching is case- and NFC-insensitive, per rule 6', () => {
  const r = serviceNameReport('ШУЛУУН ХИМИ: 430,000₮', [{ name: 'Шулуун хими', prices: ['430000'], rows: [] }]);
  assert.deepEqual(r.exact, ['Шулуун хими']);
});

test('servicesFromPrefix folds variants under one name and collects every price', () => {
  const prefix = [
    '=== ҮНИЙН ЖАГСААЛТ ===',
    '- CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮',
    '- CICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮',
    '- Сор: 120,000₮–190,000₮',
    '=== ДАРААГИЙН ХЭСЭГ ===',
    '- Энэ мөр өөр хэсэгт байгаа тул тооцогдохгүй: 999,000₮',
  ].join('\n');
  const got = servicesFromPrefix(prefix, 'ҮНИЙН ЖАГСААЛТ');
  assert.deepEqual(got, [
    { name: 'CICA нөхөн сэргээх эмчилгээ', prices: ['198000', '154000'], rows: [
      'CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮',
      'CICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮',
    ] },
    { name: 'Сор', prices: ['120000', '190000'], rows: ['Сор: 120,000₮–190,000₮'] },
  ], 'price-list ORDER throughout, and the rows verbatim');
});

test('servicesFromPrefix returns [] when the heading is absent — determinate, not truncated', () => {
  assert.deepEqual(servicesFromPrefix('=== ӨӨР ХЭСЭГ ===\n- Сор: 1,000₮', 'ҮНИЙН ЖАГСААЛТ'), []);
});

test('DONE-TEST: faqAnswersFromPrefix reads the ANSWER line, not the question', () => {
  // renderTenantSections writes `- {question}` then the answer indented beneath it, so
  // sectionRows — which returns only dashed lines — would return the QUESTIONS. Reading
  // the questions and calling them answers is exactly the confusion this test pins.
  const prefix = [
    '=== ТҮГЭЭМЭЛ АСУУЛТ ===',
    '- Үс маань хуурай байна, юу хийх вэ?',
    '  CICA нөхөн сэргээх эмчилгээ: 198,000₮. Мастер үсчин зөвлөж өгнө.',
    '- Хаана байрладаг вэ?',
    '  Яармагийн Номин Хайпермаркетын баруун талд.',
    '=== ДАРААГИЙН ===',
    '- Энэ хэсэг тооцогдохгүй',
    '  бас энэ ч тооцогдохгүй',
  ].join('\n');
  assert.deepEqual(faqAnswersFromPrefix(prefix, 'ТҮГЭЭМЭЛ АСУУЛТ'), [
    'CICA нөхөн сэргээх эмчилгээ: 198,000₮. Мастер үсчин зөвлөж өгнө.',
    'Яармагийн Номин Хайпермаркетын баруун талд.',
  ]);
});

test('a question with no answer beneath it is skipped, never paired with the next', () => {
  const prefix = '=== ТҮГЭЭМЭЛ АСУУЛТ ===\n- Асуулт нэг\n- Асуулт хоёр\n  Хариулт хоёр.';
  assert.deepEqual(faqAnswersFromPrefix(prefix, 'ТҮГЭЭМЭЛ АСУУЛТ'), ['Хариулт хоёр.']);
});

test('no FAQ section means no answers', () => {
  assert.deepEqual(faqAnswersFromPrefix('=== ӨӨР ===\n- x\n  y', 'ТҮГЭЭМЭЛ АСУУЛТ'), []);
});
