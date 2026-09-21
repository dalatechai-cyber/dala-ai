import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceNameReport } from './serviceNames.ts';

// Matrix's real dye names and the model's real rewrite of them, 2026-09-21.
const NAMES = ['Үсний угийн будаг', 'Дунд үсний будаг', 'Урт үсний будаг', 'Сор', 'Шулуун хими'];

test('DONE-TEST: THE MEASURED REWRITE IS CAUGHT', () => {
  // Verbatim from the run: the head noun «будаг» dropped, only the gloss kept.
  const r = serviceNameReport(
    'Будалтын үнэ урт, төрлөөс хамаарна:\n\nДунд урттай үс (мөрнөөс дээш): 176,000₮\n'
    + 'Урт үс (мөр давсан): 200,000₮\nҮсний угийн будаг: 135,000₮', NAMES);
  assert.deepEqual(r.altered, ['Дунд үсний будаг', 'Урт үсний будаг']);
  assert.deepEqual(r.exact, ['Үсний угийн будаг'], 'the one it got right is not reported');
});

test('DONE-TEST: names written exactly are never reported', () => {
  const r = serviceNameReport(
    'Үсний угийн будаг: 135,000₮\nДунд үсний будаг: 176,000₮\nУрт үсний будаг: 200,000₮', NAMES);
  assert.deepEqual(r.altered, []);
  assert.equal(r.exact.length, 3);
});

test('DONE-TEST: a service the reply never mentions is NOT an alteration', () => {
  // The head-token test is what separates "renamed it" from "did not discuss it". Without
  // it every reply would report every service the tenant sells.
  const r = serviceNameReport('Сор: 120,000₮–190,000₮ байна.', NAMES);
  assert.deepEqual(r.altered, []);
  assert.deepEqual(r.exact, ['Сор']);
});

test('a single-token name cannot be "altered" — absent just means unmentioned', () => {
  assert.deepEqual(serviceNameReport('Бид олон үйлчилгээтэй.', ['Сор']).altered, []);
});

test('the head test ignores tokens shorter than four characters', () => {
  // «үс» appears in half the corpus; a 2-character head would fire on everything.
  const r = serviceNameReport('Танд үс засъя.', ['Урт үс']);
  assert.deepEqual(r.altered, []);
});

test('matching is case- and NFC-insensitive, per rule 6', () => {
  const r = serviceNameReport('ШУЛУУН ХИМИ: 430,000₮', ['Шулуун хими']);
  assert.deepEqual(r.exact, ['Шулуун хими']);
});
