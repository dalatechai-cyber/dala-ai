import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesFrom, matchService, subsetCollisions, termIsSpecific, termTokens, toTerm } from './match.ts';
import { MIN_STEM_CHARS } from '../gate/match.ts';

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
  assert.equal(uniqueName('оффис колор сор', e), 'Оффис колор /Сор/', 'most specific wins');
  assert.equal(uniqueName('CICA нөхөн сэргээх', e), 'none',
    'three of that name\'s FOUR tokens reach it not at all — every token means every token');
  assert.equal(uniqueName('cmc тэжээл', e), 'CMC тэжээл', 'and not «Тэжээл», which needs no cmc');

  // «сортой будаг» named «Сор» until the specificity floor landed, and now reports
  // `too_vague`. That is the change, not a regression: the customer has typed one
  // three-character token that both «Сор» and «Оффис колор /Сор/» contain, the two differ
  // in price by 3.2x, and D-075's corpus instance is unresolvable between them. The
  // all-tokens rule still does its half — «оффис» is genuinely absent — but "not the long
  // name" is not the same fact as "therefore the short one".
  assert.equal(uniqueName('сортой будаг', e), 'too_vague');
});

test('agglutination is covered without a morphological analyser', () => {
  // «ботоксны» is «ботокс» plus the genitive; a token-prefix hit finds it.
  //
  // The fixture was «Сор» / «сортой» — the same mechanism on the same real corpus line —
  // until the specificity floor made that name unmatchable on its own. Swapping it
  // silently would leave this test looking like it still covered a one-token short name,
  // so the floor's effect on the OLD fixture is asserted here too rather than deleted.
  const e = entriesFrom(svc(['Ботокс']), []);
  assert.equal(uniqueName('ботоксны үнэ хэд вэ', e), 'Ботокс');
  assert.equal(uniqueName('ботокс хийлгэх гэсэн юм', e), 'Ботокс');

  const short = entriesFrom(svc(['Сор']), []);
  assert.equal(uniqueName('Эмэгтэй сортой будаг хийлгэх гэсийн', short), 'too_vague',
    'agglutination still FINDS it; the floor is what declines to act on it');
});

test('a Latin alias needs no transliteration engine (D-067)', () => {
  const e = entriesFrom(svc(['Ботокс', 'Будаг /бүтэн/']), [
    { serviceId: 'Ботокс', alias: 'botoks' },
    { serviceId: 'Будаг /бүтэн/', alias: 'buten' },
  ]);
  assert.equal(uniqueName('botoks hed ve', e), 'Ботокс');
  assert.equal(uniqueName('buten', e), 'Будаг /бүтэн/', 'the real corpus follow-up');

  // A Latin alias is held to the same floor as a Cyrillic name, and for the same reason:
  // `sor` is three code points and prefixes `sorri`, `sort`, `soronz`. The transliteration
  // argument (D-067) is untouched — what changes is how SHORT an alias may be, in either
  // script. A tenant needing «Сор» in Latin writes a longer alias, as they must in Cyrillic.
  const shortAlias = entriesFrom(svc(['Сор']), [{ serviceId: 'Сор', alias: 'sor' }]);
  assert.equal(uniqueName('sor hed ve', shortAlias), 'too_vague');
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

  // D-101 CHANGED THIS LINE, and CLAUDE.md's «the three CICA names DO separate at two
  // tokens or more» is superseded for this one pair. «CICA эмчилгээ» is a strict SUBSET of
  // «CICA нөхөн сэргээх эмчилгээ», so a customer typing the shorter name in full has
  // written something the longer service's customer would also write. That is «Сор» ⊂
  // «Оффис колор /Сор/» exactly, and it was answered `unique` here only because the
  // subset relation was computed for REPORTING and never consulted when matching.
  //
  // Matrix is unaffected: its confirmed list carries one CICA service, not three. This
  // fixture keeps all three because the collision is what it exists to exercise.
  //
  // D-102 changed the VERDICT again, not the finding: the subset is answered with its
  // family rather than refused, so a customer typing «cica эмчилгээ» is shown both CICA
  // services and picks. `uniqueName` reports the verdict when it is not `unique`.
  assert.equal(uniqueName('cica эмчилгээ', e), 'family');
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
  // characters long. Measured in D-092: «сорри» — a customer apologising — reached the
  // service. This test recorded that as the argument FOR a specificity floor; the floor
  // now exists, so it records the floor holding.
  const e = entriesFrom(svc(['Сор']), []);
  for (const innocent of ['сорри', 'соронз татдаг', 'сорил өгсөн', 'шүүс сорох']) {
    assert.equal(uniqueName(innocent, e), 'too_vague', `${innocent} must not reach Сор`);
  }

  // `too_vague` and not `none`: the caller still sees WHAT was nearly matched and on how
  // many tokens. A silent downgrade to `none` would make the over-match uncountable, which
  // is D-070's console.info by another name.
  const r = matchService('сорри', e);
  assert.equal(r.verdict, 'too_vague');
  assert.deepEqual(r.verdict === 'too_vague' ? r.matches.map((m) => m.name) : [], ['Сор']);
  assert.ok(r.verdict === 'too_vague' && r.matches[0]!.tokens === 1
    && r.matches[0]!.specific === false, 'the caller can see it was one token and why it failed');
});

test('DONE-TEST: THE FLOOR IS TWO TOKENS, OR ONE THAT CLEARS MIN_STEM_CHARS', () => {
  // Stated as the exemption `stem_sequence` uses: several tokens that must ALL occur are
  // their own specificity, which is what a length floor is a proxy for in the one-token
  // case. Reusing MIN_STEM_CHARS rather than inventing a second number is the point — a
  // service name is matched against the same customer prose a topic stem is.
  assert.equal(MIN_STEM_CHARS, 4, 'the floor is borrowed; if this moves, re-read both uses');

  assert.equal(termIsSpecific(toTerm('Ботокс')), true, 'six code points, one token');
  assert.equal(termIsSpecific(toTerm('Хими')), true, 'exactly at the floor');
  assert.equal(termIsSpecific(toTerm('Сор')), false, 'three');
  assert.equal(termIsSpecific(toTerm('Ора')), false, 'D-088 named this one too');
  assert.equal(termIsSpecific(toTerm('Эхо')), false);
  assert.equal(termIsSpecific(toTerm('CMC тэжээл')), true, 'two tokens, one of them short');
  assert.equal(termIsSpecific(toTerm('///')), false, 'no tokens is not specific');

  // The floor is applied to the WINNERS, after most-specific-wins. An entry reachable both
  // vaguely and specifically is judged on its best reading, not punished for the worst.
  const e = entriesFrom(svc(['Сор']), [{ serviceId: 'Сор', alias: 'сор будаг' }]);
  assert.equal(uniqueName('сор будаг хийлгэнэ', e), 'Сор', 'the two-token alias rescues it');
  assert.equal(uniqueName('сортой', e), 'too_vague', 'the bare name still does not');
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
