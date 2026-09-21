import { strict as assert } from 'node:assert';
import test from 'node:test';
import { checkPriceBinding, type PriceBinding } from './priceBinding.ts';

/** Matrix's real confirmed rows — the collision D-075 says no alias can repair. */
const SOR: PriceBinding = {
  service: 'Сор',
  allowedPrices: ['120,000', '190,000'],
  otherServices: [{ name: 'Оффис колор', prices: ['380,000', '460,000'] }],
};

test('DONE-TEST: A FOREIGN PRICE SERVED SILENTLY IS A FAILURE', () => {
  // The exact shape D-075 names: a REAL price of this tenant, on the allow-list, so every
  // existing guard passes it — against the wrong service. 3.2x the true answer.
  const reply = 'Сор 380,000₮–460,000₮ байна.';
  const f = checkPriceBinding(reply, SOR);
  assert.equal(f.length, 2, `expected both endpoints flagged, got ${JSON.stringify(f)}`);
  assert.equal(f[0]?.code, 'foreign_price');
  assert.equal(f[0]?.belongsTo, 'Оффис колор');
});

test('DONE-TEST: NAMING THE OTHER SERVICE IS DISAMBIGUATION, NOT A FAILURE', () => {
  // This is the ancestor's real reply, and it is the BEST answer in the corpus for this
  // question. A check that failed here would be deleted by the first person who read it.
  const reply = 'Сор бол 120,000 – 190,000₮ байдаг. '
    + '(Энэ нь «Оффис колор»-той өөр үйлчилгээ шүү — Оффис колор нь гурван будаг хосолсон '
    + 'бөгөөд 380,000 – 460,000₮ байдаг.)';
  assert.deepEqual(checkPriceBinding(reply, SOR), []);
});

test('the right price for the right service passes', () => {
  assert.deepEqual(checkPriceBinding('Сор 120,000₮–190,000₮ байна.', SOR), []);
});

test('a reply with no price at all passes — silence is not mis-binding', () => {
  assert.deepEqual(checkPriceBinding('Аль үйлчилгээг асууж байна вэ?', SOR), []);
});

test('DONE-TEST: A LINK\'S DIGITS ARE NOT A PRICE', () => {
  // D-074: a Maps slug put a `9` on Matrix's allow-list because its characters were read
  // as content. The same mistake here would invent price findings out of URLs.
  //
  // Matrix's own link cannot demonstrate it — `ckEXBLoq4FnxJHq16` yields only «4» and «16»,
  // which the 4-digit floor already discards, so a test built on it passes with masking
  // REMOVED and proves nothing. That is how the first version of this test was written.
  // A link carrying a long id is the case that actually collides, and it is not exotic:
  // booking and order URLs routinely embed one.
  const reply = 'Сор 120,000₮. Дэлгэрэнгүй: https://example.mn/booking/380000';
  assert.deepEqual(checkPriceBinding(reply, SOR), [],
    'the 380000 inside the URL path must not be read as «Оффис колор»\'s price');

  // And the control that makes the line above evidence: the same digits OUTSIDE a URL
  // are still caught. Without this, masking everything would also pass.
  assert.equal(checkPriceBinding('Сор 380,000₮.', SOR).length, 1);
});

test('separators do not hide a foreign price', () => {
  // digitsOf means 380000, «380,000» and «380 000» are one claim.
  for (const form of ['380000', '380,000', '380 000']) {
    const f = checkPriceBinding(`Сор ${form}₮ байна.`, SOR);
    assert.equal(f.length, 1, `«${form}» must be caught, got ${JSON.stringify(f)}`);
  }
});

test('DONE-TEST: «ТЭЖЭЭЛ» ⊂ «CMC ТЭЖЭЭЛ» — the subset collision still binds', () => {
  // D-075's third pair, found by subsetCollisions and asked about by nobody until now.
  const spec: PriceBinding = {
    service: 'Тэжээлийн тос',
    allowedPrices: ['49,500'],
    otherServices: [{ name: 'CMC тэжээл', prices: ['132,000'] }],
  };
  assert.equal(checkPriceBinding('Тэжээлийн тос 132,000₮.', spec).length, 1);
  assert.deepEqual(checkPriceBinding('Тэжээлийн тос 49,500₮.', spec), []);
  // Naming both is the disambiguating answer Dala gave in the bake-off (e04).
  assert.deepEqual(
    checkPriceBinding('CMC тэжээл 132,000₮, харин тэжээлийн тос 49,500₮ байна.', spec), []);
});

test('hair «Будаг» must not be answered with the nail price', () => {
  const spec: PriceBinding = {
    service: 'Будаг',
    allowedPrices: ['135,000', '176,000', '200,000'],
    otherServices: [{ name: 'Гелэн будалт', prices: ['50,000'] }],
  };
  assert.equal(checkPriceBinding('Будаг 50,000₮ байна.', spec).length, 1);
  assert.deepEqual(
    checkPriceBinding('Үсний будалт 135,000₮-өөс 200,000₮. Хумсны гелэн будалт бол 50,000₮.', spec),
    [], 'naming the nail service is the hair-vs-nail disambiguation the founder asked for');
});
