import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTenantSections, planBranches, SECTION_LABELS, hasTenantData, type TenantKb } from '../prompt/tenant.ts';
import { renderStablePrefix } from '../prompt/render.ts';
import { cannedHashOf, loadTenantKb } from '../prompt/sections.ts';
import { cannedSectionBody, MODEL_INVISIBLE_KINDS, type CannedRow } from '../gate/match.ts';
import { DAY_ONE_KB } from '../prompt/tenantKb.fixtures.ts';
import { handleReception, type ReceptionInput } from '../reception/handle.ts';
import { renderVolatile } from '../reception/volatile.ts';
import {
  CLARIFY_BRANCH_KIND, branchNamesFromPrefix, branchTerms, establishedBranches, namedIn, termsForPrefix,
} from './branches.ts';
import { branchFactSource, judgeBranches } from './facts.ts';
import { withBranches } from '../replycases/run.ts';
import {
  BOOKING_LINE, HANDOFF, ONE_BRANCH_KB, ONE_BRANCH_SCENARIOS, TEST_CLARIFY, TWO_BRANCH_KB, TWO_BRANCH_STEMS, ZAISAN,
  outcomesHash, runScenarios, scenarioInput,
} from './branches.fixtures.ts';

const APPROVED = '2026-09-25T00:00:00Z';
const REVIEWED = '2026-09-24T00:00:00Z';
const YARMAG = 'Яармаг салбар';
const ZAISAN_NAME = 'Зайсан салбар';
const YARMAG_ADDRESS_ROW = 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд';
const ZAISAN_ADDRESS_ROW = `Хаяг: ${ZAISAN.address}`;

/**
 * What these inputs compiled to and answered BEFORE 0047, recorded by running the pre-change
 * code on 2026-09-25 (`renderTenantSections` + `renderStablePrefix` at commit 5edc916, and
 * `handleReception` over `ONE_BRANCH_SCENARIOS`). They are measurements of the old code, not
 * values derived from the new — which is what makes them evidence that nothing moved.
 */
const PRE_0047 = {
  oneBranchContentHash: '6163be7823e4b34ec7966114d2dbd049ad1fe2eb7a7ef0176a51866d9334e125',
  dayOneContentHash: 'e27fe8d717da071c3e5d49418bc7c644bed5c5a4bca264890a2fff237c2bda70',
  oneBranchCannedHash: '03c1b1b8336d876ebe4aecaa4ff73646e9e655dcbe742a5d65b24ecdfb1e4004',
  oneBranchReplies: 'eacb060e25769f269bdcba0cca3ea8cc287c1b8a7ec655e2aa827f4fd6f7c046',
};

function compile(kb: TenantKb) {
  const r = renderStablePrefix(renderTenantSections(kb, APPROVED));
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`);
  return r.rendered;
}

const CANNED: CannedRow[] = ONE_BRANCH_KB.canned.map((c) => ({ ...c, reviewedAt: REVIEWED }));
const CLARIFY_ROW: CannedRow = { kind: CLARIFY_BRANCH_KIND, body: TEST_CLARIFY, reviewedAt: REVIEWED };

function twoBranchInput(over: Partial<ReceptionInput> = {}): Omit<ReceptionInput, 'customerMessage'> {
  const r = compile(TWO_BRANCH_KB);
  const input = scenarioInput(r.promptStable, r.allowedNumbers, {
    canned: [...CANNED, CLARIFY_ROW], branches: TWO_BRANCH_STEMS, ...over,
  });
  // As `reception/load.ts` builds it: links do not count against the script share. The
  // one-location fixture leaves this empty because its recorded pre-0047 replies did.
  return { ...input, tenantGuard: { ...input.tenantGuard, scriptShareExclusions: [...input.tenantGuard.allowedUrls] } };
}

async function one(input: Omit<ReceptionInput, 'customerMessage'>, message: string, reply: string, history: ReceptionInput['history'] = []) {
  const [o] = await runScenarios(handleReception, input, [{ message, reply, history }]);
  if (o === undefined) throw new Error('no outcome');
  return o;
}

// ---------------------------------------------------------------------------
// (a) One location: byte-for-byte what it was.
// ---------------------------------------------------------------------------

test('DONE-TEST (a): A ONE-LOCATION TENANT COMPILES BYTE-FOR-BYTE THE PREFIX IT HAD BEFORE 0047', () => {
  assert.equal(compile(ONE_BRANCH_KB).contentHash, PRE_0047.oneBranchContentHash);
  assert.equal(compile(DAY_ONE_KB).contentHash, PRE_0047.dayOneContentHash);
  assert.equal(cannedHashOf(ONE_BRANCH_KB.canned), PRE_0047.oneBranchCannedHash);
});

test('DONE-TEST (a): ONE branch row, however different its facts, changes nothing — a tenant is split only at two', () => {
  // The salon adding its CURRENT branch as a row first (the natural order) must not move the
  // live prefix before the second one exists.
  const oneRow: TenantKb = {
    ...ONE_BRANCH_KB,
    branches: [TWO_BRANCH_KB.branches[1] ?? { name: 'x', contacts: [], hours: [], prices: [] }],
  };
  assert.equal(planBranches(oneRow), null);
  assert.equal(compile(oneRow).contentHash, PRE_0047.oneBranchContentHash);
  assert.deepEqual(branchNamesFromPrefix(compile(oneRow).promptStable), []);
});

test('DONE-TEST (a): adding the clarify row does not move canned_hash, so it cannot make a live tenant stale', () => {
  // D-082's outage shape: a row swept into the cached section moves the hash on the publish
  // side only and 503s every reply with `canned_stale`. The kind is model-invisible.
  assert.ok(MODEL_INVISIBLE_KINDS.includes(CLARIFY_BRANCH_KIND));
  const withClarify = [...ONE_BRANCH_KB.canned, { kind: CLARIFY_BRANCH_KIND, body: TEST_CLARIFY }];
  assert.equal(cannedHashOf(withClarify), PRE_0047.oneBranchCannedHash);
  assert.equal(cannedSectionBody(SECTION_LABELS.canned, withClarify).includes(TEST_CLARIFY), false);
});

test('DONE-TEST (a): A ONE-LOCATION TENANT GIVES EXACTLY THE REPLIES IT GAVE BEFORE 0047', async () => {
  const r = compile(ONE_BRANCH_KB);
  const outcomes = await runScenarios(handleReception, scenarioInput(r.promptStable, r.allowedNumbers, { branches: [] }), ONE_BRANCH_SCENARIOS);
  assert.equal(outcomesHash(outcomes), PRE_0047.oneBranchReplies);
  // And with live branch rows present but a prefix that lists none: the PREFIX decides, so a
  // row added before the publish cannot change a reply either.
  const withRows = await runScenarios(
    handleReception, scenarioInput(r.promptStable, r.allowedNumbers, { branches: TWO_BRANCH_STEMS }), ONE_BRANCH_SCENARIOS,
  );
  assert.equal(outcomesHash(withRows), PRE_0047.oneBranchReplies);
});

test('(a) L4 is unchanged for no branches and for one', () => {
  const base = { now: new Date('2026-09-27T04:00:00Z'), timezone: 'Asia/Ulaanbaatar', surface: 'direct_message' as const, hours: ONE_BRANCH_KB.hours, closures: [] };
  const before = renderVolatile({ ...base, branches: [] });
  assert.equal(renderVolatile({ ...base, branches: [{ name: ZAISAN_NAME, hours: [] }] }), before);
  assert.ok(before.includes('ОДОО: НЭЭЛТТЭЙ'));
});

// ---------------------------------------------------------------------------
// The compiled prefix for two branches.
// ---------------------------------------------------------------------------

test('two branches: what differs moves to each branch, what is shared stays where it was', () => {
  const p = compile(TWO_BRANCH_KB).promptStable;
  assert.deepEqual(branchNamesFromPrefix(p), [YARMAG, ZAISAN_NAME]);
  const main = (label: string) => p.slice(p.indexOf(`=== ${label} ===`)).split('\n\n')[0] ?? '';
  // The tenant-wide contacts keep only the shared website and booking link: no address that
  // would read as "the salon's" while belonging to one branch.
  assert.equal(main(SECTION_LABELS.contacts).includes('Хаяг'), false);
  assert.ok(main(SECTION_LABELS.contacts).includes('Вэбсайт'));
  // The price list keeps services priced the same everywhere, and loses the one that differs.
  assert.ok(main(SECTION_LABELS.priceList).includes('Усан хими'));
  assert.equal(main(SECTION_LABELS.priceList).includes('Эмэгтэй тайралт'), false);
  // The week differs on Sunday, so there is no tenant-wide week at all.
  assert.equal(p.includes(`=== ${SECTION_LABELS.hours} ===`), false);
  assert.ok(p.includes(`=== ${SECTION_LABELS.hours} — ${ZAISAN_NAME} ===\n`));
  assert.ok(p.includes('- Ням: 12:00 - 18:00'));
  assert.ok(hasTenantData(p));
  // Every branch fact is on the allow-list, so the numeral guard never refuses one.
  for (const n of ['40,000', '99112233', '12:00', '18:00']) assert.ok(compile(TWO_BRANCH_KB).allowedNumbers.includes(n), n);
});

test('two branches whose overrides are identical are one fact, and nothing is split for it', () => {
  const same: TenantKb = {
    ...ONE_BRANCH_KB,
    branches: [
      { name: YARMAG, contacts: [{ kind: 'phone', value: '70000000' }], hours: [], prices: [] },
      { name: ZAISAN_NAME, contacts: [{ kind: 'phone', value: '70000000' }], hours: [], prices: [] },
    ],
  };
  const p = compile(same).promptStable;
  assert.ok(p.includes('=== ХОЛБОО БАРИХ ===\n- Хаяг: Яармагийн Номин Хайпермаркетын баруун талд'));
  assert.ok(p.includes('- Утас: 70000000'));
  assert.equal(p.includes(`=== ${SECTION_LABELS.contacts} — `), false);
  assert.deepEqual(branchNamesFromPrefix(p), [YARMAG, ZAISAN_NAME]);
});

test('an unconfirmed branch price is shown with no figure — never the tenant-wide price it says is wrong', () => {
  const kb: TenantKb = {
    ...TWO_BRANCH_KB,
    branches: [
      TWO_BRANCH_KB.branches[0] ?? { name: YARMAG, contacts: [], hours: [], prices: [] },
      { name: ZAISAN_NAME, contacts: [], hours: [], prices: [{ service: 'Үсний угийн будаг', variantKey: '', variant: null }] },
    ],
  };
  const p = compile(kb).promptStable;
  const src = branchFactSource(p, []);
  assert.ok(src !== null);
  // Naming the service states nothing about a branch; quoting Яармаг's price for Зайсан,
  // whose price is unknown, is handed off — never corrected to a number Зайсан does not have.
  assert.equal(judgeBranches('Үсний угийн будаг хийдэг.', src, { branches: [], from: 'none' }).kind, 'pass');
  assert.equal(judgeBranches('Үсний угийн будаг: 135,000₮', src, { branches: [ZAISAN_NAME], from: 'message' }).kind, 'handoff');
  // The last section of the prefix, so it ends the string.
  assert.ok(p.endsWith(`=== ${SECTION_LABELS.priceList} — ${ZAISAN_NAME} ===\n- Үсний угийн будаг`), p.slice(-200));
  assert.ok(p.includes(`=== ${SECTION_LABELS.priceList} — ${YARMAG} ===\n- Үсний угийн будаг: 135,000₮`));
});

// ---------------------------------------------------------------------------
// (b) Two branches: ask when it depends, answer when it does not.
// ---------------------------------------------------------------------------

test('DONE-TEST (b): A BRANCH-DEPENDENT ANSWER TO A CUSTOMER WHO NAMED NO BRANCH IS REPLACED BY THE QUESTION', async () => {
  const input = twoBranchInput();
  for (const [message, reply] of [
    ['Хаяг хаана вэ?', YARMAG_ADDRESS_ROW],                                             // one branch, guessed
    ['Хаяг хаана вэ?', `Яармаг: ${ZAISAN.address.slice(0, 0)}Яармагийн Номин Хайпермаркетын баруун талд. Зайсан: ${ZAISAN.address}.`], // both, mixed
    ['Утас хэд вэ?', 'Утас: 76001888, 80905498'],
    ['Байршлын холбоос?', `Байршлын холбоос нь ${ZAISAN.maps} байна.`],
    ['Эмэгтэй мастер тайралт хэд вэ?', 'Эмэгтэй тайралт (Мастер): 35,000₮'],
    ['Хэдэн цагт ажилладаг вэ?', 'Даваагаас Бямба хүртэл 10:00-20:00 цагт ажилладаг.'],
  ] as const) {
    const o = await one(input, message, reply);
    assert.deepEqual(o.drafts, [{ body: TEST_CLARIFY, answeredBy: 'canned' }], `${message} → ${reply}`);
    assert.ok(o.flags.includes('branch_asked'), `${message}: ${o.flags.join(',')}`);
  }
});

test('DONE-TEST (b): AN ANSWER THAT IS THE SAME AT EVERY BRANCH IS SENT WITHOUT ASKING', async () => {
  const input = twoBranchInput();
  for (const [message, reply] of [
    ['Усан хими хэд вэ?', 'Усан хими: 132,000₮–154,000₮'],
    // A per-branch service, but this variant costs the same at both: nothing to ask.
    ['1-р зэргийн эмэгтэй тайралт хэд вэ?', 'Эмэгтэй тайралт (1-р зэрэг): 25,000₮'],
    ['Сайн байна уу', 'Сайн байна уу! Танд юугаар туслах вэ?'],
    ['Урьдчилгаа хэд вэ?', 'Мастер үсчин: 20,000₮'],
  ] as const) {
    const o = await one(input, message, reply);
    assert.deepEqual(o.drafts, [{ body: reply, answeredBy: 'model' }], `${message}: ${o.flags.join(',')}`);
    assert.equal(o.flags.some((f) => f.startsWith('branch_')), false, message);
  }
});

test('(b) the question is only ever the REVIEWED line: none, and the handoff is served, never the guess', async () => {
  const missing = await one(twoBranchInput({ canned: CANNED }), 'Хаяг хаана вэ?', YARMAG_ADDRESS_ROW);
  assert.deepEqual(missing.drafts, [{ body: HANDOFF, answeredBy: 'canned' }]);
  assert.ok(missing.flags.includes('branch_ask_unavailable'));

  // An unreviewed clarify row stops the whole reply before anything is drafted — the canned
  // section's own review gate (`renderCannedSection`), exactly as for any other kind.
  const unreviewed = await one(twoBranchInput({ canned: [...CANNED, { ...CLARIFY_ROW, reviewedAt: null }] }), 'Хаяг хаана вэ?', YARMAG_ADDRESS_ROW);
  assert.equal(unreviewed.outcome, 'retry');
  assert.deepEqual(unreviewed.drafts, []);
});

test('(b) asked once and still not answered: the handoff, not the same question again', async () => {
  const o = await one(twoBranchInput(), 'аль нь ч хамаагүй', YARMAG_ADDRESS_ROW, [
    { role: 'user', content: 'Хаяг хаана вэ?' },
    { role: 'assistant', content: TEST_CLARIFY },
  ]);
  assert.deepEqual(o.drafts, [{ body: HANDOFF, answeredBy: 'canned' }]);
  assert.ok(o.flags.includes('branch_ask_repeated'));
});

// ---------------------------------------------------------------------------
// (c) A customer who names a branch gets that branch's facts, and only those.
// ---------------------------------------------------------------------------

test('DONE-TEST (c): NAMED IN CYRILLIC OR LATIN, THE BRANCH\'S OWN FACTS ARE SENT AS WRITTEN', async () => {
  const input = twoBranchInput();
  for (const [message, reply] of [
    ['Зайсан салбарын хаяг хаана вэ?', ZAISAN_ADDRESS_ROW],
    ['Зайсангийн утас?', 'Утас: 99112233'],
    ['zaisan salbariin hayag', ZAISAN_ADDRESS_ROW],
    ['yarmag salbar haana baidag ve', YARMAG_ADDRESS_ROW],
    ['Яармагт эмэгтэй мастер тайралт хэд вэ?', 'Эмэгтэй тайралт (Мастер): 35,000₮'],
  ] as const) {
    const o = await one(input, message, reply);
    assert.deepEqual(o.drafts, [{ body: reply, answeredBy: 'model' }], `${message}: ${o.flags.join(',')}`);
  }
});

test('DONE-TEST (c): NAMED, AND ANSWERED ABOUT THE OTHER BRANCH OR BOTH: THE NAMED BRANCH\'S ROWS ONLY', async () => {
  const input = twoBranchInput();
  const cases: [string, string, string][] = [
    ['zaisan salbariin hayag', YARMAG_ADDRESS_ROW, ZAISAN_ADDRESS_ROW],
    ['Яармагийн утас?', 'Утас: 99112233', 'Утас: 76001888, 80905498'],
    ['yarmag salbar hayag', `Яармагийн Номин Хайпермаркетын баруун талд, мөн Зайсан: ${ZAISAN.address}.`, YARMAG_ADDRESS_ROW],
    ['Зайсан салбарын байршил', 'Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16', `Байршлын холбоос: ${ZAISAN.maps}`],
  ];
  for (const [message, reply, served] of cases) {
    const o = await one(input, message, reply);
    assert.deepEqual(o.drafts, [{ body: served, answeredBy: 'deterministic' }], `${message}: ${o.flags.join(',')}`);
    assert.ok(o.flags.includes('branch_facts_served'), message);
  }
});

test('(c) a customer who names BOTH branches may be answered about both', async () => {
  const reply = `${YARMAG_ADDRESS_ROW}\n${ZAISAN_ADDRESS_ROW}`;
  const o = await one(twoBranchInput(), 'Яармаг, Зайсан хоёр салбарын хаяг?', reply);
  assert.deepEqual(o.drafts, [{ body: reply, answeredBy: 'model' }], o.flags.join(','));
});

test('the reply-case gate judges a new branch prefix with THAT prefix\'s branch links', () => {
  const ctx = {
    branches: [], tenantGuard: { allowedUrls: ['https://www.matrixecosalon.org/'], scriptShareExclusions: ['Сор', 'https://www.matrixecosalon.org/'] },
  } as unknown as Parameters<typeof withBranches>[0];
  const next = withBranches(ctx, [{ name: ZAISAN_NAME, stems: ['zaisan'], hours: [], contacts: [{ kind: 'maps_url', value: ZAISAN.maps }, { kind: 'phone', value: ZAISAN.phone }] }]);
  assert.deepEqual(next.tenantGuard.allowedUrls, ['https://www.matrixecosalon.org/', ZAISAN.maps]);
  assert.deepEqual(next.tenantGuard.scriptShareExclusions, ['Сор', 'https://www.matrixecosalon.org/', ZAISAN.maps]);
  // And back: the branch's link goes, the tenant's stays.
  assert.deepEqual(withBranches(next, []).tenantGuard.allowedUrls, ['https://www.matrixecosalon.org/']);
});

test('(c) a branch named earlier by the CUSTOMER carries over; the other branch\'s fact is asked about, not overruled', async () => {
  const history: ReceptionInput['history'] = [
    { role: 'user', content: 'Зайсан салбар' },
    { role: 'assistant', content: ZAISAN_ADDRESS_ROW },
  ];
  const same = await one(twoBranchInput(), 'утас нь?', 'Утас: 99112233', history);
  assert.deepEqual(same.drafts, [{ body: 'Утас: 99112233', answeredBy: 'model' }]);
  // «What about the other one?» names no branch and means a different one.
  const other = await one(twoBranchInput(), 'нөгөө салбарынх?', 'Утас: 76001888, 80905498', history);
  assert.deepEqual(other.drafts, [{ body: TEST_CLARIFY, answeredBy: 'canned' }]);
  // The BOT naming a branch is not the customer choosing it.
  const botOnly = await one(twoBranchInput(), 'утас?', 'Утас: 99112233', [{ role: 'assistant', content: `${ZAISAN_NAME}: ${ZAISAN.address}` }]);
  assert.deepEqual(botOnly.drafts, [{ body: TEST_CLARIFY, answeredBy: 'canned' }]);
});

// ---------------------------------------------------------------------------
// (d) The facts guard never states one branch's address or price for the other.
// ---------------------------------------------------------------------------

test('DONE-TEST (d): ONE BRANCH\'S PRICE, IN THE MODEL\'S OWN WORDS, IS NEVER SENT FOR THE OTHER', async () => {
  // «35,000» is Яармаг's Мастер price. Written loosely, `guard/facts.ts` replaces it with its
  // row — Яармаг's — and the branch check then serves Зайсан's own row instead.
  const o = await one(twoBranchInput(), 'Зайсан салбарт эмэгтэй мастер тайралт хэд вэ?', 'Мастер тайралт 35,000₮ байна.');
  assert.deepEqual(o.drafts, [{ body: 'Эмэгтэй тайралт (Мастер): 40,000₮', answeredBy: 'deterministic' }]);
  assert.ok(o.flags.includes('fact_restated') && o.flags.includes('branch_facts_served'), o.flags.join(','));
});

test('DONE-TEST (d): ONE BRANCH\'S ADDRESS OR WEEK, PARAPHRASED, IS NEVER SENT FOR THE OTHER', async () => {
  const address = await one(twoBranchInput(), 'Зайсан салбар хаана байрладаг вэ?', 'Бид Номин Хайпермаркетын баруун талд байрладаг.');
  assert.deepEqual(address.drafts, [{ body: ZAISAN_ADDRESS_ROW, answeredBy: 'deterministic' }], address.flags.join(','));

  const week = await one(twoBranchInput(), 'zaisan-d nyam garigt hed tsagt ajilladag ve', 'Ням гарагт 11:00-19:00 цагт ажилладаг.');
  const zaisanWeek = compile(TWO_BRANCH_KB).promptStable.split(`=== ${SECTION_LABELS.hours} — ${ZAISAN_NAME} ===\n`)[1]
    ?.split('\n\n')[0]?.split('\n').map((l) => l.slice(2)).join('\n');
  assert.deepEqual(week.drafts, [{ body: zaisanWeek, answeredBy: 'deterministic' }], week.flags.join(','));
});

test('(d) no counterpart row: the handoff line, never the other branch\'s value', () => {
  const kb: TenantKb = {
    ...TWO_BRANCH_KB,
    branches: [
      { name: YARMAG, contacts: [{ kind: 'instagram', value: 'https://instagram.com/test_yarmag' }], hours: [], prices: [] },
      TWO_BRANCH_KB.branches[1] ?? { name: ZAISAN_NAME, contacts: [], hours: [], prices: [] },
    ],
  };
  const src = branchFactSource(compile(kb).promptStable, []);
  assert.ok(src !== null);
  const v = judgeBranches('Инстаграм: https://instagram.com/test_yarmag', src, { branches: [ZAISAN_NAME], from: 'message' });
  assert.equal(v.kind, 'handoff');
});

test('(d) text the tenant approved is never read as the model choosing a branch', () => {
  const src = branchFactSource(compile(TWO_BRANCH_KB).promptStable, [HANDOFF, BOOKING_LINE]);
  assert.ok(src !== null);
  // The handoff line carries Яармаг's phone numbers; quoted whole it is the salon's own line.
  assert.equal(judgeBranches(`Уучлаарай. ${HANDOFF}`, src, { branches: [], from: 'none' }).kind, 'pass');
  assert.equal(judgeBranches('Утас: 76001888, 80905498', src, { branches: [], from: 'none' }).kind, 'ask');
});

// ---------------------------------------------------------------------------
// Naming a branch.
// ---------------------------------------------------------------------------

test('a word two branches share, or one shorter than four letters, names neither', () => {
  const terms = branchTerms([
    { name: 'Яармаг салбар', stems: ['yarmag', 'ya', 'salbar'] },
    { name: 'Зайсан салбар', stems: [] },
  ]);
  // `ya` is too short; `salbar` is «салбар», in both names, whichever script it is typed in.
  assert.deepEqual(terms, [
    { name: 'Яармаг салбар', terms: ['yarmag', 'яармаг'] },
    { name: 'Зайсан салбар', terms: ['зайсан'] },
  ]);
  // «салбар» is in nearly every location question; it must not establish every branch.
  assert.deepEqual(namedIn('Хэдэн салбартай вэ?', null, terms), []);
  assert.deepEqual(namedIn('salbar haana ve', null, terms), []);
  // A spelling listed under the OTHER branch too names both — so neither keeps it, and
  // Яармаг is left with nothing, which the loader refuses to publish.
  assert.deepEqual(branchTerms([
    { name: 'Яармаг салбар', stems: ['yarmag'] },
    { name: 'Зайсан салбар', stems: ['yarmag'] },
  ]).map((b) => b.terms), [[], ['зайсан']]);
  assert.deepEqual(branchTerms([{ name: 'Төв салбар', stems: [] }, { name: 'Зайсан салбар', stems: [] }])[0]?.terms, []);
});

test('named by stem prefix, in either script, NFC or not, and through a known spelling', () => {
  const terms = termsForPrefix([YARMAG, ZAISAN_NAME], TWO_BRANCH_STEMS);
  assert.deepEqual(namedIn('Зайсангийн салбар хаана вэ', null, terms), [ZAISAN_NAME]);
  assert.deepEqual(namedIn('ZAYSAN-d baidag uu', null, terms), [ZAISAN_NAME]);
  assert.deepEqual(namedIn('Яармаг'.normalize('NFD'), null, terms), [YARMAG]);
  assert.deepEqual(namedIn('Яармаг, Зайсан хоёрын хаяг', null, terms), [YARMAG, ZAISAN_NAME]);
  // Not a token start: «оязайсан» is not «зайсан».
  assert.deepEqual(namedIn('оязайсан', null, terms), []);
  // A Latin spelling the tenant's `spellings` settled reaches the Cyrillic name.
  assert.deepEqual(namedIn('jaarmagt baina uu', 'яармагт baina uu', termsForPrefix([YARMAG, ZAISAN_NAME], [])), [YARMAG]);
  // A live row the prefix does not list adds nothing.
  assert.deepEqual(termsForPrefix([YARMAG], [{ name: 'Шинэ салбар', stems: ['shine'] }]).map((t) => t.name), [YARMAG]);
});

test('this message first, then the latest CUSTOMER turn, never the bot\'s', () => {
  const terms = termsForPrefix([YARMAG, ZAISAN_NAME], TWO_BRANCH_STEMS);
  assert.deepEqual(establishedBranches('Зайсан?', null, [{ role: 'user', content: 'Яармаг' }], terms), { branches: [ZAISAN_NAME], from: 'message' });
  assert.deepEqual(establishedBranches('утас?', null, [{ role: 'user', content: 'Яармаг' }, { role: 'assistant', content: 'Зайсан' }], terms),
    { branches: [YARMAG], from: 'history' });
  assert.deepEqual(establishedBranches('утас?', null, [{ role: 'assistant', content: 'Зайсан' }], terms), { branches: [], from: 'none' });
});

// ---------------------------------------------------------------------------
// L4: «open now», per branch when the weeks differ.
// ---------------------------------------------------------------------------

test('L4 says which branch is open when their weeks differ, and one line when they do not', () => {
  const yarmagWeek = ONE_BRANCH_KB.hours;
  const zaisanWeek = [...ONE_BRANCH_KB.hours.filter((h) => h.weekday !== 0), { weekday: 0, opens: '12:00:00', closes: '18:00:00', closed: false }];
  // Sunday 2026-09-27, 11:30 in Ulaanbaatar: Яармаг opened at 11:00, Зайсан opens at 12:00.
  const at = { now: new Date('2026-09-27T03:30:00Z'), timezone: 'Asia/Ulaanbaatar', surface: 'direct_message' as const, hours: yarmagWeek, closures: [] };
  const split = renderVolatile({ ...at, branches: [{ name: YARMAG, hours: yarmagWeek }, { name: ZAISAN_NAME, hours: zaisanWeek }] });
  assert.ok(split.includes(`ОДОО (${YARMAG}): НЭЭЛТТЭЙ`), split);
  assert.ok(split.includes(`ОДОО (${ZAISAN_NAME}): ХААЛТТАЙ`), split);
  assert.equal(split.includes('ОДОО: '), false);
  const joint = renderVolatile({ ...at, branches: [{ name: YARMAG, hours: yarmagWeek }, { name: ZAISAN_NAME, hours: yarmagWeek }] });
  assert.ok(joint.includes('ОДОО: НЭЭЛТТЭЙ'));
  assert.equal(joint.includes(`(${YARMAG})`), false);
});

// ---------------------------------------------------------------------------
// The loader: only confirmed branches, and never one nobody can name.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function stubDb(tables: Record<string, Row[] | Row | null>) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
    const answer = () => ({ data: tables[table] ?? (table === 'tenants' || table === 'tenant_booking' ? null : []), error: null });
    chain['maybeSingle'] = async () => answer();
    chain['then'] = (res: (v: unknown) => unknown) => res(answer());
    return chain;
  };
  return { from } as never;
}

const TENANT_ROW = { currency_symbol: '₮', currency_symbol_before: false, default_locale: 'mn-MN' };
const SERVICES = [{ id: 's1', name: 'Үсний угийн будаг' }];
const VARIANTS = [{ id: 'v1', service_id: 's1', variant_key: '', price_kind: 'exact', price_min: '135000.00', price_max: null, refusal_topic: null }];

test('loader: an unconfirmed branch is left out and NAMED, and one confirmed branch is one location', async () => {
  const out = await loadTenantKb(stubDb({
    tenants: TENANT_ROW, services: SERVICES, service_variants: VARIANTS,
    tenant_branches: [
      { id: 'b1', name: YARMAG, stems: [], ordinal: 0, provenance: 'tenant_confirmed' },
      { id: 'b2', name: ZAISAN_NAME, stems: [], ordinal: 1, provenance: 'seeded' },
    ],
    branch_contact_points: [{ branch_id: 'b2', kind: 'address', value: ZAISAN.address }],
  }), { tenantId: 't' });
  assert.ok(out.ok);
  assert.deepEqual(out.ok && out.unconfirmed.branchesExcluded, [ZAISAN_NAME]);
  assert.deepEqual(out.ok && out.kb.branches.map((b) => b.name), [YARMAG]);
  assert.equal(out.ok && planBranches(out.kb), null);
});

test('loader: a branch no customer could name refuses the publish instead of looping the question', async () => {
  const out = await loadTenantKb(stubDb({
    tenants: TENANT_ROW,
    tenant_branches: [
      { id: 'b1', name: 'Төв салбар', stems: [], ordinal: 0, provenance: 'tenant_confirmed' },
      { id: 'b2', name: ZAISAN_NAME, stems: [], ordinal: 1, provenance: 'tenant_confirmed' },
    ],
  }), { tenantId: 't' });
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.detail.includes('«Төв салбар»'), !out.ok ? out.detail : '');
});

test('loader: a name that cannot round-trip as a heading refuses — its facts would be invisible', async () => {
  const out = await loadTenantKb(stubDb({
    tenants: TENANT_ROW,
    tenant_branches: [
      { id: 'b1', name: `${YARMAG} `, stems: ['yarmag'], ordinal: 0, provenance: 'tenant_confirmed' },
      { id: 'b2', name: ZAISAN_NAME, stems: ['zaisan'], ordinal: 1, provenance: 'tenant_confirmed' },
    ],
  }), { tenantId: 't' });
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.detail.includes('cannot be a section heading'), !out.ok ? out.detail : '');
});

test('loader: branch prices resolve to their service; unconfirmed is kept as "no figure", an inactive service is dropped', async () => {
  const out = await loadTenantKb(stubDb({
    tenants: TENANT_ROW, services: SERVICES,
    service_variants: [...VARIANTS, { id: 'v9', service_id: 'inactive', variant_key: '', price_kind: 'exact', price_min: '1000.00', price_max: null, refusal_topic: null }],
    tenant_branches: [
      { id: 'b1', name: YARMAG, stems: ['yarmag'], ordinal: 0, provenance: 'tenant_confirmed' },
      { id: 'b2', name: ZAISAN_NAME, stems: ['zaisan'], ordinal: 1, provenance: 'tenant_confirmed' },
    ],
    branch_variant_prices: [
      { branch_id: 'b1', variant_id: 'v1', price_kind: 'exact', price_min: '140000.00', price_max: null, confirmed_at: REVIEWED },
      { branch_id: 'b2', variant_id: 'v1', price_kind: 'exact', price_min: '150000.00', price_max: null, confirmed_at: null },
      { branch_id: 'b2', variant_id: 'v9', price_kind: 'exact', price_min: '2000.00', price_max: null, confirmed_at: REVIEWED },
    ],
  }), { tenantId: 't' });
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.deepEqual(out.kb.branches[0]?.prices, [{ service: 'Үсний угийн будаг', variantKey: '', variant: { variantKey: '', priceKind: 'exact', priceMin: '140000.00', priceMax: null, refusalTopic: null } }]);
  assert.deepEqual(out.kb.branches[1]?.prices, [{ service: 'Үсний угийн будаг', variantKey: '', variant: null }]);
  const p = compile(out.kb).promptStable;
  assert.ok(p.includes(`— ${YARMAG} ===\n- Үсний угийн будаг: 140,000₮`));
  assert.ok(p.endsWith(`— ${ZAISAN_NAME} ===\n- Үсний угийн будаг`), p.slice(-200));
  assert.equal(p.includes('150,000'), false);
});
