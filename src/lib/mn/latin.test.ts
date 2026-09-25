import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyrillicKey, isLatinToken, latinKeys, respell } from './latin.ts';

test('customers\' Latin spellings meet the word they mean', () => {
  // Each pair measured in Matrix's corpus on 2026-09-24.
  for (const [latin, word] of [
    ['usnii', 'үсний'], ['himi', 'хими'], ['unuudur', 'өнөөдөр'], ['tsag', 'цаг'], ['cag', 'цаг'],
    ['hayag', 'хаяг'], ['shuluun', 'шулуун'], ['huuhdiin', 'хүүхдийн'], ['vsnii', 'үсний'],
    ['medegdehgvin', 'мэдэгдэхгүйн'], ['ci', 'чи'],
  ]) {
    assert.ok(latinKeys(latin as string).includes(cyrillicKey(word as string) as string), `${latin} → ${word}`);
  }
});

test('DONE-TEST: «usnii» meets BOTH «үсний» and «усны» — the ambiguity is data, not a guess', () => {
  // The founder's example. The key merges «ү» and «у», and «ы» and «ий», on purpose: that is
  // how customers write them. A caller then has two candidates to settle by context or ask.
  assert.equal(cyrillicKey('үсний'), cyrillicKey('усны'));
  assert.notEqual(cyrillicKey('үсний'), cyrillicKey('усан'));
});

test('a letter the tables do not know makes the token unmappable, never silently dropped', () => {
  assert.deepEqual(latinKeys('café'), []);
  assert.equal(cyrillicKey('ab'), null);
  assert.equal(isLatinToken('hayag'), true);
  assert.equal(isLatinToken('хаяг'), false);
  assert.equal(isLatinToken('2026'), false);
});

test('respell replaces known Latin words and leaves everything else exactly as written', () => {
  const out = respell('Usnii himi hed ve?', [{ latin: 'usnii', cyrillic: 'үсний' }, { latin: 'himi', cyrillic: 'хими' }]);
  assert.equal(out, 'үсний хими hed ve?');
  assert.equal(respell('хаяг', [{ latin: 'hayag', cyrillic: 'хаяг' }]), null, 'nothing to replace is null');
  assert.equal(respell('hayag', []), null);
});

test('a two-word row wins over the single words: context is what settled it', () => {
  const out = respell('us bish usnii himi', [
    { latin: 'usnii', cyrillic: 'усны' }, { latin: 'usnii himi', cyrillic: 'үсний хими' },
  ]);
  assert.equal(out, 'us bish үсний хими');
});
