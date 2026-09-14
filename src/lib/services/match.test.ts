import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesFrom, matchService, subsetCollisions, termTokens, toTerm } from './match.ts';

const svc = (names: string[]) => names.map((n) => ({ id: n, name: n }));

/** The names that collide on Matrix's own confirmed list. */
const COLLIDING = svc([
  'Сор', 'Оффис колор /Сор/',
  'CICA эмчилгээ', 'CICA нөхөн сэргээх эмчилгээ', 'Хими эмэгтэй / CICA',
  'Тэжээл', 'CMC тэжээл',
]);

const uniqueName = (text: string, entries: ReturnType<typeof entriesFrom>) => {
  const r = matchService(text, entries);
  return r.verdict === 'unique' ? r.match.name : r.verdict;
};

test('tokens drop punctuation and keep both scripts', () => {
  assert.deepEqual(termTokens('Оффис колор /Сор/'), ['оффис', 'колор', 'сор']);
  assert.deepEqual(termTokens('Хими эмэгтэй / CICA'), ['хими', 'эмэгтэй', 'cica']);
  assert.deepEqual(termTokens('Хумс нөхөлт (1 хумс)'), ['хумс', 'нөхөлт', '1', 'хумс']);
  assert.deepEqual(termTokens('   '), []);
});

test('DONE-TEST: EVERY TOKEN MUST OCCUR — which is what separates the colliding names', () => {
  // Matching on ANY token makes «Сор» and «Оффис колор /Сор/» permanently
  // indistinguishable: the first name's only token is a subset of the second's.
  const e = entriesFrom(COLLIDING, []);
  assert.equal(uniqueName('сортой будаг', e), 'Сор', 'names сор and not оффис');
  assert.equal(uniqueName('оффис колор сор', e), 'Оффис колор /Сор/', 'most specific wins');
});

test('agglutination is covered without a morphological analyser', () => {
  // «сортой» is «сор» plus the comitative; a token-prefix hit finds it.
  const e = entriesFrom(svc(['Сор']), []);
  assert.equal(uniqueName('Эмэгтэй сортой будаг хийлгэх гэсийн', e), 'Сор');
});

test('a Latin alias needs no transliteration engine (D-067)', () => {
  const e = entriesFrom(svc(['Сор', 'Будаг /бүтэн/']), [
    { serviceId: 'Сор', alias: 'sor' },
    { serviceId: 'Будаг /бүтэн/', alias: 'buten' },
  ]);
  assert.equal(uniqueName('sor hed ve', e), 'Сор');
  assert.equal(uniqueName('buten', e), 'Будаг /бүтэн/', 'the real corpus follow-up');
});

test('DONE-TEST: AMBIGUITY IS A VERDICT, NEVER A SILENT PICK', () => {
  // Two services reachable at the same specificity must reach the caller as both. A
  // confident wrong service is the plausible-and-wrong answer this whole mechanism exists
  // to prevent — worse than no answer, because the customer believes it.
  const e = entriesFrom(svc(['Хумсны гоёл', 'Гоёлын засалт']), [
    { serviceId: 'Хумсны гоёл', alias: 'гоёл' },
    { serviceId: 'Гоёлын засалт', alias: 'гоёл' },
  ]);
  const r = matchService('гоёл хэд вэ', e);
  assert.equal(r.verdict, 'ambiguous');
  assert.deepEqual(
    r.verdict === 'ambiguous' ? r.matches.map((m) => m.name).sort() : [],
    ['Гоёлын засалт', 'Хумсны гоёл'],
  );
});

test('no match is the safe answer and the common one', () => {
  const e = entriesFrom(COLLIDING, []);
  // Bare «cica» names none of the three: each needs a second token. A miss costs a worse
  // reply; a wrong unique costs a wrong price.
  assert.equal(matchService('cica', e).verdict, 'none');
  assert.equal(matchService('Хаяг', e).verdict, 'none');
  assert.equal(matchService('сайн байна уу', e).verdict, 'none');
});

test('DONE-TEST: THE THREE CICA NAMES SEPARATE WHEN THE CUSTOMER TYPES ENOUGH', () => {
  const e = entriesFrom(COLLIDING, [{ serviceId: 'Хими эмэгтэй / CICA', alias: 'cica хими' }]);
  assert.equal(uniqueName('cica эмчилгээ', e), 'CICA эмчилгээ');
  assert.equal(uniqueName('CICA нөхөн сэргээх эмчилгээ', e), 'CICA нөхөн сэргээх эмчилгээ');
  assert.equal(uniqueName('хими эмэгтэй cica', e), 'Хими эмэгтэй / CICA');
  assert.equal(uniqueName('cica хими', e), 'Хими эмэгтэй / CICA', 'via the alias');
});

test('an alias repairs a name whose qualifier customers do not say', () => {
  // «Оффис колор /Сор/» requires «сор» as a token, so the natural «оффис колор» reaches
  // NOTHING until an alias says so. The parenthetical is the salon's bookkeeping, not
  // what a customer types — which is what alias rows are for.
  const bare = entriesFrom(COLLIDING, []);
  assert.equal(matchService('оффис колор', bare).verdict, 'none');
  const aliased = entriesFrom(COLLIDING, [{ serviceId: 'Оффис колор /Сор/', alias: 'оффис колор' }]);
  assert.equal(uniqueName('оффис колор', aliased), 'Оффис колор /Сор/');
});

test('DONE-TEST: A ONE-TOKEN MATCH ON A SHORT STEM IS NOT EVIDENCE', () => {
  // `mn/match.ts` accepts over-matching by design, and «Сор» is a one-token name three
  // characters long. Measured: «сорри» — a customer apologising — reaches the service.
  // This is the argument for a specificity floor above the matcher, not a bug in it.
  const e = entriesFrom(svc(['Сор']), []);
  for (const innocent of ['сорри', 'соронз татдаг', 'сорил өгсөн', 'шүүс сорох']) {
    assert.equal(uniqueName(innocent, e), 'Сор', `${innocent} reaches Сор on one token`);
  }
  // Two tokens is not magic, but it is the cheapest thing that separates a service name
  // from a word that merely starts like one.
  const r = matchService('сорри', e);
  assert.ok(r.verdict === 'unique' && r.match.tokens === 1, 'and the caller can see it was one');
});

test('subsetCollisions names what no alias row can repair', () => {
  const found = subsetCollisions(entriesFrom(COLLIDING, []))
    .map((c) => `${c.subset} < ${c.superset}`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  assert.deepEqual(found, [
    'CICA эмчилгээ < CICA нөхөн сэргээх эмчилгээ',
    'Сор < Оффис колор /Сор/',
    'Тэжээл < CMC тэжээл',
  ]);
});

test('an empty term can never match', () => {
  assert.deepEqual(toTerm('///').tokens, []);
  const e = entriesFrom(svc(['X']), [{ serviceId: 'X', alias: '///' }]);
  assert.equal(matchService('///', e).verdict, 'none');
});

test('the verdict is stable across runs', () => {
  const e = entriesFrom(svc(['B', 'A']), [{ serviceId: 'B', alias: 'z' }, { serviceId: 'A', alias: 'z' }]);
  const first = matchService('z', e);
  for (let i = 0; i < 5; i++) assert.deepEqual(matchService('z', e), first);
});
