import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricePresentation, renderQuotedRows } from './pricePresentation.ts';
import { servicesFromPrefix } from '../quality/serviceNames.ts';

// Matrix's real dye and cut rows, as the compiled prefix writes them.
const PREFIX = [
  '=== ҮНИЙН ЖАГСААЛТ ===',
  '- Үсний угийн будаг: 135,000₮',
  '- Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮',
  '- Урт үсний будаг (мөр давсан урттай үс): 200,000₮',
  '- Сор: 120,000₮–190,000₮',
  '- Эрэгтэй тайралт: 66,000₮',
  '=== ХОЛБОО БАРИХ ===',
  '- Утас: 76001888',
].join('\n');
const SERVICES = servicesFromPrefix(PREFIX, 'ҮНИЙН ЖАГСААЛТ');

test('DONE-TEST: THE MEASURED INVENTED RANGE IS REFUSED', () => {
  // Verbatim from the «us budalt» run. Both numbers are real; the SPREAD is not, and
  // «Бүтэн будалт» is not a service.
  const r = pricePresentation('Бүтэн будалт (дунд, урт зэргээс шалтгаалан): 176,000₮–200,000₮', SERVICES);
  assert.ok(r.violations.some((v) => v.kind === 'cross_service_range'),
    'a range spanning two services is its own fault, not merely an orphan');
  assert.deepEqual(r.quoted.map((s) => s.name), ['Дунд үсний будаг', 'Урт үсний будаг']);
  assert.equal(renderQuotedRows(r.quoted),
    'Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮\nУрт үсний будаг (мөр давсан урттай үс): 200,000₮',
    'the served text is the price list\'s own bytes, variants and all');
});

test('DONE-TEST: TWO NAMES ON THE LINE DO NOT RESCUE A CROSS-SERVICE RANGE', () => {
  // This satisfies "every price has its name on the line" and still asserts a spread
  // neither service has. It is why rule (2) exists separately from rule (1).
  const r = pricePresentation('Дунд үсний будаг, Урт үсний будаг: 176,000₮–200,000₮', SERVICES);
  assert.ok(r.violations.some((v) => v.kind === 'cross_service_range'));
});

test('DONE-TEST: a price beside the WRONG service is refused — D-075\'s «Омбре 33,000₮»', () => {
  const r = pricePresentation('Урт үсний будаг: 176,000₮', SERVICES);
  assert.deepEqual(r.violations.map((v) => v.kind), ['orphaned'],
    '176,000 is Дунд үсний будаг\'s price, and Дунд үсний будаг is not on this line');
});

test('a correct reply passes, one service per line', () => {
  const r = pricePresentation(
    'Үсний угийн будаг: 135,000₮\nДунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮', SERVICES);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.quoted.map((s) => s.name), ['Үсний угийн будаг', 'Дунд үсний будаг']);
});

test('a range that is ONE service\'s own min and max passes', () => {
  assert.deepEqual(pricePresentation('Сор: 120,000₮–190,000₮', SERVICES).violations, []);
});

test('numerals that are not any service price are not considered at all', () => {
  // The phone, and a deposit the price list never rendered. A check about PRICES must not
  // fire on a token the price list does not carry — that is the numeral guard's job.
  const r = pricePresentation(
    'Та 76001888 дугаараар холбогдоно уу.\nУрьдчилгаа төлбөр 20,000₮ байна.', SERVICES);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.quoted, []);
});

test('two prices on one line without a dash is style, not a spread', () => {
  // «Эрэгтэй 66,000₮, эмэгтэй 88,000₮» is rule (4)'s business. Only a DASH asserts a range.
  const r = pricePresentation('Эрэгтэй тайралт: 66,000₮, Үсний угийн будаг: 135,000₮', SERVICES);
  assert.deepEqual(r.violations, []);
});

test('DONE-TEST: A COMMA IS NOT A RANGE SEPARATOR, even with nothing between the figures', () => {
  // The boundary the test above does NOT reach: it has words between the two prices, so a
  // mutation widening the separator to `[-–—,]` still matched nothing and passed. Measured
  // 2026-09-21 — the mutation survived, which made that test an assertion that could not
  // fail about the thing it names. Here the figures are adjacent and owned by DIFFERENT
  // services, so a comma-as-separator reports a cross-service range and this goes red.
  const r = pricePresentation('Эрэгтэй тайралт, Үсний угийн будаг: 66,000₮, 135,000₮', SERVICES);
  assert.deepEqual(r.violations, [], 'a comma lists two prices; it does not assert a spread');
});

test('DONE-TEST: A SHARED PRICE NAMES AN AMOUNT, NOT A SERVICE — measured on CICA', () => {
  // Real, 2026-09-21. «CICA хими байгаа юу?» was answered well, with both CICA prices
  // attached to a paraphrase of the name. Rule (1) fires — correctly. But 198,000 is also
  // «Хуримын засалт» and 154,000 is also «Усан хими» and «Хими арчилт», so substituting
  // "the services whose prices were quoted" served FIVE the customer never asked about.
  const SHARED = servicesFromPrefix([
    '=== ҮНИЙН ЖАГСААЛТ ===',
    '- CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮',
    '- CICA нөхөн сэргээх эмчилгээ (Курсээр): 154,000₮',
    '- Хими арчилт: 154,000₮',
    '- Хуримын засалт: 154,000₮–198,000₮',
  ].join('\n'), 'ҮНИЙН ЖАГСААЛТ');
  const r = pricePresentation('CICA бол хими биш, нэг удаа 198,000₮, курсээр 154,000₮.', SHARED);
  assert.ok(r.violations.length > 0, 'the loose naming is still a violation');
  assert.deepEqual(r.quoted, [], 'no service is identified by a price several of them share');
  assert.equal(r.ambiguous, true, 'so the caller must not guess');
});

test('a uniquely-priced service IS identified by its price alone', () => {
  const r = pricePresentation('Дунд урттай үс (мөрнөөс дээш): 176,000₮', SERVICES);
  assert.deepEqual(r.quoted.map((s) => s.name), ['Дунд үсний будаг']);
  assert.equal(r.ambiguous, false);
});

test('a tenant with no price list has nothing to check', () => {
  assert.deepEqual(pricePresentation('Сор: 120,000₮', []).violations, []);
});

test('matching is NFC-folded and case-insensitive, per rule 6', () => {
  assert.deepEqual(pricePresentation('ДУНД ҮСНИЙ БУДАГ: 176,000₮', SERVICES).violations, []);
});

test('the separator inside a figure does not change its identity', () => {
  // 176 000 is 176,000. A reply that spaces its thousands is still quoting the same price.
  assert.deepEqual(pricePresentation('Урт үсний будаг: 176 000₮', SERVICES).violations.map((v) => v.kind),
    ['orphaned']);
});
