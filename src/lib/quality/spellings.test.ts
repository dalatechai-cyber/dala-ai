import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appliedSpellings, candidatesFor, proposeSpellings, vocabularyFrom } from './spellings.ts';

const VOCAB = vocabularyFrom([
  '- Дунд үсний будаг: 176,000₮\n- Усан хими: 132,000₮–154,000₮\nХаяг: Яармаг',
  'Эмчилгээний хими нь зөөлөн. Химий өмнө CMC хийнэ.',
]);

test('one word fits: settled, and applied to matching', () => {
  const out = proposeSpellings(['hayag', 'une bogin us'], VOCAB, new Set());
  const hayag = out.find((p) => p.latin === 'hayag');
  assert.equal(hayag?.status, 'settled');
  assert.equal(hayag?.cyrillic, 'хаяг');
  assert.deepEqual(hayag?.evidence, ['hayag']);
});

test('words the tenant never wrote are not proposed at all', () => {
  // «bro», «ok», «storpay»: a list that grew with them would be noise.
  assert.deepEqual(proposeSpellings(['bro ok storpay'], VOCAB, new Set()), []);
});

test('inflections of one stem settle to the stem', () => {
  assert.deepEqual(candidatesFor('himi', VOCAB), ['хими', 'химий']);
  const out = proposeSpellings(['himi'], VOCAB, new Set());
  assert.equal(out[0]?.status, 'settled');
  assert.equal(out[0]?.cyrillic, 'хими');
});

test('DONE-TEST: TWO DIFFERENT WORDS ARE SETTLED BY THE NEIGHBOUR, OR ASKED', () => {
  const v = vocabularyFrom(['үсний будаг', 'усны шүүлтүүр']);
  assert.deepEqual(candidatesFor('usnii', v), ['усны', 'үсний']);
  const out = proposeSpellings(['usnii budag', 'usnii'], v, new Set());
  // The pair the tenant's text contains is settled...
  assert.deepEqual(out.find((p) => p.latin === 'usnii budag'), {
    latin: 'usnii budag', status: 'settled', cyrillic: 'үсний будаг', candidates: [], evidence: ['usnii budag', 'usnii'], seen: 1,
  });
  // ...and the single word is still a question: the next customer may write it beside
  // something else.
  const ask = out.find((p) => p.latin === 'usnii');
  assert.equal(ask?.status, 'ask');
  assert.deepEqual(ask?.candidates, ['усны', 'үсний']);
});

test('nothing already on the list is proposed again, whatever its status', () => {
  assert.deepEqual(proposeSpellings(['hayag'], VOCAB, new Set(['hayag'])), []);
});

test('only settled and confirmed rows are applied', () => {
  assert.deepEqual(appliedSpellings([
    { latin: 'a1', cyrillic: 'х', status: 'settled' }, { latin: 'a2', cyrillic: 'х', status: 'confirmed' },
    { latin: 'a3', cyrillic: 'х', status: 'ask' }, { latin: 'a4', cyrillic: '', status: 'rejected' },
  ]).map((s) => s.latin), ['a1', 'a2']);
});
