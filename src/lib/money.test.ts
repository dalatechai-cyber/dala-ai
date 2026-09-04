import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usdToNano, nanoToUsd, fromDb, toDb, NANO_PER_USD } from './money.ts';

test('a Haiku cache-read token does not round to zero', () => {
  // $0.0000001 per token. This is the number that motivates bigint nano-USD: in a
  // numeric(14,6) column, or in a float accumulation, it truncates to nothing and the
  // ledger under-reports EVERY row — systematically, so it never averages out.
  const perToken = usdToNano(0.0000001);
  assert.equal(perToken, 100n);
  assert.equal(perToken * 1_000_000n, usdToNano(0.1));
});

test('a million cache-read tokens accumulate exactly, with no float drift', () => {
  let total = 0n;
  for (let i = 0; i < 1_000_000; i += 1) total += 100n;
  assert.equal(total, usdToNano(0.1));
  assert.equal(nanoToUsd(total), 0.1);
});

test('the D-004 ceiling round-trips exactly', () => {
  assert.equal(usdToNano(22.86), 22_860_000_000n);
  assert.equal(usdToNano(1), NANO_PER_USD);
});

test('a bigint that already lost precision in transit is REFUSED, not trusted', () => {
  // PostgREST serialises bigint as a JSON number. Above 2^53 the damage is done before
  // we see it; this cannot repair it, only refuse to pretend otherwise.
  assert.throws(() => fromDb(Number.MAX_SAFE_INTEGER + 2, 'cost_nanousd'), /precision/);
  assert.equal(fromDb('9007199254740993', 'cost_nanousd'), 9007199254740993n);
  assert.equal(fromDb(1_000n, 'x'), 1_000n);
});

test('sending an unrepresentable amount refuses rather than truncating', () => {
  assert.throws(() => toDb(BigInt(Number.MAX_SAFE_INTEGER) + 1n), /without loss/);
});

test('a negative or non-finite amount is not spendable', () => {
  for (const bad of [-1, NaN, Infinity]) assert.throws(() => usdToNano(bad));
});
