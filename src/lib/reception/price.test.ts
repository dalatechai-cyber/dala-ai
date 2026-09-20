import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePriceQuote, priceText, type PricedService, type PriceQuoteInput } from './price.ts';
import { entriesFrom, matchService, toTerm } from '../services/match.ts';
import { extractNumerals } from '../mn/extract.ts';

const CONFIRMED = new Date('2026-09-20T00:00:00Z');
const TAIL = 'Дэлгэрэнгүйг утсаар лавлана уу.';

const SERVICES: PricedService[] = [
  {
    serviceId: 'ombre', name: 'Омбре',
    variants: [{ variantKey: '', priceKind: 'range', priceMin: '500000', priceMax: '640000', confirmedAt: CONFIRMED }],
  },
  {
    serviceId: 'cut', name: 'Эмэгтэй тайралт',
    variants: [
      { variantKey: 'Мастер', priceKind: 'range', priceMin: '66000', priceMax: '88000', confirmedAt: CONFIRMED },
      { variantKey: '1-р зэрэг', priceKind: 'exact', priceMin: '55000', priceMax: null, confirmedAt: CONFIRMED },
    ],
  },
];

const ENTRIES = entriesFrom(
  SERVICES.map((s) => ({ id: s.serviceId, name: s.name })),
  [],
);

const ask = (over: Partial<PriceQuoteInput> = {}): PriceQuoteInput => ({
  text: 'Омбре хэд вэ', priceIntent: true, entries: ENTRIES, services: SERVICES,
  tail: TAIL, currencySymbol: '₮', currencySymbolBefore: false, ...over,
});

test('a unique, confirmed, priced service is served from the row', () => {
  const r = decidePriceQuote(ask());
  assert.equal(r.serve, true);
  assert.equal(r.serve === true && r.body, `Омбре — 500,000₮ - 640,000₮\n${TAIL}`);
});

// RELOCATED FROM prompt/tenant.test.ts. `extractNumerals` joins digit runs across `-`, so a
// range written without the symbol on BOTH endpoints reduces to one eleven-digit token.
// Part 1 removed the only other place a price was rendered, so this is now the only line in
// the system that can get it wrong.
test('a served range does not fuse into one numeral', () => {
  const r = decidePriceQuote(ask());
  assert.equal(r.serve, true);
  if (r.serve !== true) return;
  const digits = extractNumerals(r.body).map((n) => n.digits);
  assert.deepEqual(digits, ['500000', '640000']);
  assert.ok(!digits.some((d) => d.length > 6), `a fused token: ${digits.join(', ')}`);
});

test('every variant is served, so a master rate never stands in for a junior one', () => {
  const r = decidePriceQuote(ask({ text: 'Эмэгтэй тайралт хэд вэ' }));
  assert.equal(r.serve, true);
  assert.equal(
    r.serve === true && r.body,
    `Эмэгтэй тайралт (Мастер) — 66,000₮ - 88,000₮\nЭмэгтэй тайралт (1-р зэрэг) — 55,000₮\n${TAIL}`,
  );
});

test('no price intent means this path never runs, whatever the text names', () => {
  const r = decidePriceQuote(ask({ priceIntent: false }));
  assert.equal(r.serve, false);
  assert.equal(r.serve === false && r.reason, 'no_price_intent');
});

// `matchService` returns ambiguous and too_vague as VERDICTS rather than ties to break, and
// this is the layer that must respect that. A confident wrong service is the failure the
// whole mechanism exists to prevent.
test('anything but a unique match refuses, and says which verdict it was', () => {
  for (const [text, verdict] of [['хэд вэ', 'none'], ['юу ч биш', 'none']] as const) {
    const r = decidePriceQuote(ask({ text }));
    assert.equal(r.serve, false);
    assert.equal(r.serve === false && r.reason, 'service_not_unique');
    assert.equal(r.serve === false && r.verdict, verdict);
  }
});

// D-020: the price guarantee rests on the TENANT having said the number. An unsigned figure
// is one we would be saying for them.
test('an unconfirmed figure is never served', () => {
  const unsigned: PricedService[] = [{
    ...SERVICES[0]!,
    variants: [{ ...SERVICES[0]!.variants[0]!, confirmedAt: null }],
  }];
  const r = decidePriceQuote(ask({ services: unsigned }));
  assert.equal(r.serve, false);
  assert.equal(r.serve === false && r.reason, 'unconfirmed_price');
});

// RELOCATED. formatMoney answers null rather than 0 or NaN for a value it cannot read, and
// here that has to refuse the whole quote — a half-rendered price list is worse than none.
test('a price the compiler cannot read refuses the whole quote', () => {
  const broken: PricedService[] = [{
    ...SERVICES[1]!,
    variants: [
      SERVICES[1]!.variants[0]!,
      { ...SERVICES[1]!.variants[1]!, priceMin: 'not-a-number' },
    ],
  }];
  const r = decidePriceQuote(ask({ text: 'Эмэгтэй тайралт хэд вэ', services: broken }));
  assert.equal(r.serve, false);
  assert.equal(r.serve === false && r.reason, 'price_unreadable');
});

// `none` and `on_inspection` are real answers the prompt already gives — `none` carries the
// refusal topic that says WHY. Serving a number over them would delete a working refusal.
test('a non-numeric kind falls through rather than being served', () => {
  for (const kind of ['none', 'on_inspection'] as const) {
    const svc: PricedService[] = [{
      ...SERVICES[0]!,
      variants: [{ variantKey: '', priceKind: kind, priceMin: null, priceMax: null, confirmedAt: CONFIRMED }],
    }];
    const r = decidePriceQuote(ask({ services: svc }));
    assert.equal(r.serve, false);
    assert.equal(r.serve === false && r.reason, 'not_numeric');
  }
});

// THE INERTNESS TEST. Everything above can be true and nothing is sent until a human has
// signed the one sentence a customer actually reads.
test('with no reviewed tail sentence the whole mechanism is inert', () => {
  for (const tail of [null, '   ']) {
    const r = decidePriceQuote(ask({ tail }));
    assert.equal(r.serve, false);
    assert.equal(r.serve === false && r.reason, 'no_reviewed_tail');
  }
});

test('priceText keeps the symbol on both endpoints and the spaces around the dash', () => {
  assert.equal(
    priceText({ variantKey: '', priceKind: 'range', priceMin: '80000', priceMax: '150000', confirmedAt: CONFIRMED }, '₮', false),
    '80,000₮ - 150,000₮',
  );
  assert.equal(
    priceText({ variantKey: '', priceKind: 'exact', priceMin: '33000', priceMax: null, confirmedAt: CONFIRMED }, '₮', false),
    '33,000₮',
  );
  assert.equal(
    priceText({ variantKey: '', priceKind: 'range', priceMin: 'x', priceMax: '1', confirmedAt: CONFIRMED }, '₮', false),
    null,
  );
});

// D-100, the founder's call 2026-09-20: a bare «будаг» answers with ALL THREE lengths in
// one message rather than asking which one. *"That's what a receptionist says when someone
// asks about colouring, it uses a mechanism I've already approved, and it needs no
// migration and no new sentence. The customer self-selects."*
//
// The alternative was a clarifying question, and it would have cost a new
// `canned_response_kinds` row and a new reviewed Mongolian sentence — none of the 21 kinds
// is a question, they are all statements or refusals. Serving every variant answers the
// ambiguity with DATA, which `decidePriceQuote` already does by construction.
//
// Pinned as a test rather than written down, because the behaviour it depends on —
// serve-every-variant-or-none — is one `if` away from becoming pick-the-first, and that
// change would read as a tidy-up. Note what the alternative failure looks like: a customer
// asking «будаг хэдээр хийх вэ» told «135,000₮» and arriving with shoulder-length hair.
test('a bare «будаг» serves every length, because the customer self-selects', () => {
  const entries = [{ serviceId: 'budag', name: 'Будаг', terms: [toTerm('Будаг')] }];
  const services = [{
    serviceId: 'budag', name: 'Будаг',
    variants: [
      { variantKey: 'Хүзүүний урт',   priceKind: 'exact' as const, priceMin: '135000', priceMax: null, confirmedAt: CONFIRMED },
      { variantKey: 'Далны дээгүүр',  priceKind: 'exact' as const, priceMin: '176000', priceMax: null, confirmedAt: CONFIRMED },
      { variantKey: 'Далнаас доош',   priceKind: 'exact' as const, priceMin: '200000', priceMax: null, confirmedAt: CONFIRMED },
    ],
  }];
  const r = decidePriceQuote(ask({ text: 'будаг хэдээр хийх вэ', entries, services }));
  assert.equal(r.serve, true);
  assert.equal(r.serve === true && r.body,
    'Будаг (Хүзүүний урт) — 135,000₮\n'
    + 'Будаг (Далны дээгүүр) — 176,000₮\n'
    + 'Будаг (Далнаас доош) — 200,000₮\n'
    + TAIL);
});

// The other half of the founder's «Будаг» question, and it needed no change at all:
// most-specific-wins already means a bare «будаг» cannot reach the two-token names.
// Measured against the intake's real 36 services before answering him.
test('«Будаг арилгалт» and «Дип будаг» match only when NAMED', () => {
  const entries = [
    { serviceId: 'budag',  name: 'Будаг',          terms: [toTerm('Будаг')] },
    { serviceId: 'arilga', name: 'Будаг арилгалт', terms: [toTerm('Будаг арилгалт')] },
    { serviceId: 'dip',    name: 'Дип будаг',      terms: [toTerm('Дип будаг')] },
  ];
  const bare = matchService('будаг', entries);
  assert.equal(bare.verdict, 'unique');
  assert.equal(bare.verdict === 'unique' && bare.match.name, 'Будаг');

  for (const [q, want] of [['будаг арилгалт', 'Будаг арилгалт'], ['дип будаг', 'Дип будаг']] as const) {
    const m = matchService(q, entries);
    assert.equal(m.verdict, 'unique');
    assert.equal(m.verdict === 'unique' && m.match.name, want);
  }
});
