import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extraChecks, merged, noteOf, parseSet, renderActivationSql, renderReport, renderSql,
  type CaseRun, type Run, type TestSet,
} from './set.ts';
import { activationFile, generatedBy, loadSet } from './sql.ts';
import { judge } from '../../src/lib/replycases/run.ts';
import { asReplyCase } from './set.ts';

const DALATECH = 'scripts/bakeoff/dalatech-set.json';

function minimal(over: Record<string, unknown> = {}, caseOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'T', tenant_slug: 'acme', note_prefix: 'acme-set', report: 'r.md', sql: 'a.sql', activation_sql: 'b.sql',
    categories: { a: 'A' }, always_not: ['Матрикс'],
    cases: [{ id: 'a01', category: 'a', source: 'constructed', text: 'Сайн байна уу', expect: 'A greeting.', must_not_include: ['салон'], ...caseOver }],
    ...over,
  };
}

function errorsOf(raw: unknown): string[] {
  const r = parseSet(raw);
  return r.ok ? [] : r.errors;
}

test('the DalaTech set parses, and every case is judged with the set-wide must-not list', () => {
  const set = loadSet(DALATECH);
  assert.equal(set.tenantSlug, 'dalatech');
  assert.ok(set.cases.length >= 45 && set.cases.length <= 60, `~50 cases, got ${set.cases.length}`);
  for (const c of set.cases) {
    const rc = asReplyCase(c, set.alwaysNot, 1);
    for (const n of set.alwaysNot) assert.ok(rc.mustNotInclude.includes(n), `${c.id} lacks «${n}»`);
  }
  // Every category is used, and the set covers what the founder asked for.
  for (const k of Object.keys(set.categories)) assert.ok(set.cases.some((c) => c.category === k), `category ${k} is empty`);
  const latin = set.cases.filter((c) => /\p{Script=Latin}{3}/u.test(c.text) && !/\p{Script=Cyrillic}/u.test(c.text));
  assert.ok(latin.length >= 12, `Latin-typed messages: ${latin.length}`);
  assert.ok(set.cases.filter((c) => c.history.length > 0).length >= 3, 'multi-turn conversations');
  assert.ok(set.cases.some((c) => c.history.length >= 4), 'a three-turn conversation');
});

test('DONE-TEST: every expected_body in the DalaTech set passes its own case, so a row-answered case CAN pass', () => {
  const set = loadSet(DALATECH);
  const withBody = set.cases.filter((c) => c.expectedBody !== null);
  assert.ok(withBody.length >= 2);
  for (const c of withBody) assert.deepEqual(judge(asReplyCase(c, set.alwaysNot, 1), c.expectedBody), [], c.id);
});

test('the set never forbids a word an approved DalaTech answer needs', () => {
  // FAQ 1 lists «салон» among the business types DalaTech suits, so a bare «салон» may only be
  // forbidden where that answer cannot be the right one; the set-wide list must not carry it.
  const set = loadSet(DALATECH);
  assert.ok(!set.alwaysNot.map((s) => s.toLowerCase()).includes('салон'));
  // The approved assistant_identity line says «Дотоод зааврынхаа…»; the injection case expects
  // that line, so it must not forbid the stem.
  const j01 = set.cases.find((c) => c.id === 'j01');
  assert.ok(j01 !== undefined);
  const identity = 'Би энэ хуудсыг хариуцдаг хиймэл оюун ухаанд суурилсан туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуулт байвал асуугаарай.';
  assert.deepEqual(judge(asReplyCase(j01, set.alwaysNot, 1), identity), []);
});

test('DONE-TEST: THE COMMITTED SQL IS EXACTLY WHAT THE SET GENERATES — THE ROWS CANNOT DRIFT FROM WHAT WAS READ', () => {
  const set = loadSet(DALATECH);
  assert.equal(readFileSync(set.sql, 'utf8'), renderSql(set, generatedBy(DALATECH)),
    `regenerate: node scripts/replycases/sql.ts --set ${DALATECH}`);
  assert.equal(readFileSync(set.activationSql, 'utf8'), activationFile(set, DALATECH));
});

test('the inserts are inactive, idempotent, keyed by note, and one per case', () => {
  const set = loadSet(DALATECH);
  const sql = renderSql(set, 'test');
  assert.equal(sql.match(/^insert into reply_cases/gmu)?.length, set.cases.length);
  assert.equal(sql.match(/, false\nfrom tenants t/gu)?.length, set.cases.length);
  assert.doesNotMatch(sql, /, true\nfrom tenants/u);
  assert.equal(sql.match(/and not exists \(select 1 from reply_cases r/gu)?.length, set.cases.length);
  assert.match(sql, /raise exception 'no tenant with slug dalatech'/u);
  assert.match(sql, /^begin;$/mu);
  assert.match(sql, /^commit;$/mu);
  for (const c of set.cases) assert.ok(noteOf(set, c).startsWith(`dalatech-testset:${c.id} `));
});

test('SQL literals double the quote and nothing else', () => {
  const parsed = parseSet(minimal({}, { text: "it's «ok»", expect: "O'Brien" }));
  assert.ok(parsed.ok);
  const sql = renderSql(parsed.set, 'test');
  assert.match(sql, /'it''s «ok»'/u);
  assert.match(sql, /'acme-set:a01 — O''Brien'/u);
  assert.match(sql, /array\['салон', 'Матрикс'\]::text\[\]/u);
  assert.match(sql, /'\{\}'::text\[\]/u);
});

test('the activation statement is one UPDATE naming only the ids given, and refuses none', () => {
  const set = loadSet(DALATECH);
  const one = renderActivationSql(set, ['i01', 'p01']);
  assert.equal(one.match(/;/gu)?.length, 1);
  assert.match(one, /update reply_cases set active = true/u);
  assert.match(one, /in \('dalatech-testset:i01', 'dalatech-testset:p01'\)/u);
  assert.match(one, /and active = false/u);
  assert.throws(() => renderActivationSql(set, []), /nothing to switch on/u);
  assert.equal(renderActivationSql(set).match(/dalatech-testset:/gu)?.length, set.cases.length);
});

test('a case that could never pass, or could never fail usefully, is refused before it is a row', () => {
  assert.deepEqual(errorsOf(minimal()), []);
  assert.match(errorsOf(minimal({}, { id: 'A1' })).join(), /id must match/u);
  assert.match(errorsOf(minimal({}, { category: 'nope' })).join(), /not in categories/u);
  assert.match(errorsOf(minimal({}, { text: '  ' })).join(), /is blank/u);
  assert.match(errorsOf(minimal({}, { must_include: ['₮'] })).join(), /shorter than 2/u);
  assert.match(errorsOf(minimal({}, { text: 'Сайн байна уу'.normalize('NFD') + ' й' .normalize('NFD') })).join(), /not NFC/u);
  assert.match(errorsOf(minimal({}, { expected_body: 'Манай салонд тавтай морил' })).join(), /its own expected_body fails it/u);
  assert.match(errorsOf(minimal({}, { must_include: ['Матрикс эко'] })).join(), /no reply can pass/u);
  assert.match(errorsOf(minimal({}, { history: [{ role: 'assistant', content: 'x' }] })).join(), /expected role user/u);
  assert.match(errorsOf(minimal({}, { history: [{ role: 'user', content: 'x' }] })).join(), /end with an assistant turn/u);
  const two = minimal();
  (two['cases'] as unknown[]).push((two['cases'] as unknown[])[0]);
  assert.match(errorsOf(two).join(), /duplicate id/u);
  assert.match(errorsOf(minimal({ tenant_slug: 'Bad Slug' })).join(), /not a slug/u);
});

test('merged keeps the case\'s own order first and drops fold-equal duplicates', () => {
  assert.deepEqual(merged(['Салон', 'x1'], ['салон', 'Матрикс']), ['Салон', 'x1', 'Матрикс']);
});

test('extraChecks: an invented numeral is noted, the customer\'s own and a URL\'s digits are not', () => {
  assert.deepEqual(extraChecks('Сард 250,000₮.', '', ['250,000']), []);
  assert.match(extraChecks('Сард 300,000₮.', '', ['250,000']).join(), /300,000/u);
  assert.deepEqual(extraChecks('99000000 дугаарт холбогдоно.', 'nadruu zalgaarai 99000000', []), []);
  assert.deepEqual(extraChecks('https://dalatech.online/p/9x7 хаягаар орно уу.', '', []), []);
  assert.match(extraChecks('Yes, we build websites in about ten days.', '', []).join(), /Latin/u);
  assert.deepEqual(extraChecks(null, '', []), []);
});

function fakeRun(set: TestSet, results: CaseRun[], over: Partial<Run> = {}): Run {
  return {
    ranAt: '2026-09-25T20:00:00Z', tenant: set.tenantSlug, model: 'm', now: '2026-09-25T06:00:00Z', source: 'the live project',
    revisionId: 'rev', contentHash: 'aaaaaaaaaaaaaaaa', contentHashAfter: 'aaaaaaaaaaaaaaaa', allowedNumbers: ['250,000'],
    callsMade: 1, results, ...over,
  };
}

test('DONE-TEST: the report carries every reply VERBATIM, the verdict, and an activation statement naming only passes', () => {
  const parsed = parseSet({ ...minimal(), cases: [
    { id: 'a01', category: 'a', source: 's', text: 'une hed ve', expect: 'The row.', must_include: ['250,000'] },
    { id: 'a02', category: 'a', source: 's', text: 'ci henbe', expect: 'Who.', must_not_include: ['салон'],
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Сайн байна уу!' }] },
  ] });
  assert.ok(parsed.ok);
  const reply = 'Сарын төлбөр: Дали 250,000₮.\nВэбсайт | 750,000₮';
  const run = fakeRun(parsed.set, [
    { id: 'a01', ok: true, reply, answeredBy: 'deterministic', flags: [], pass: true, outcome: 'pass', why: [], calls: [], totalMs: 5 },
    { id: 'a02', ok: true, reply: 'Манай салон', answeredBy: 'canned', flags: ['outbound_percent'], pass: false, outcome: 'wrong',
      why: ['contains «салон»'], calls: [{ ms: 3100, kind: 'ok', text: 'Би салоны туслах', usd: 0.04 }], totalMs: 3200 },
  ]);
  const md = renderReport(parsed.set, run, { runFile: 'runs/x.json', generator: 'g' });
  // Verbatim apart from the table's own two escapes, which are the same ones matrix-bakeoff.md uses.
  assert.ok(md.includes('Сарын төлбөр: Дали 250,000₮. ⏎ Вэбсайт \\| 750,000₮'));
  assert.ok(md.includes('| model wrote | Би салоны туслах |'), 'the discarded model text is shown');
  assert.ok(md.includes('_[outbound_percent]_'));
  assert.ok(md.includes('**WRONG** — contains «салон»'));
  assert.ok(md.includes('| bot | Сайн байна уу! |'), 'the history is shown');
  assert.ok(md.includes("in ('acme-set:a01')"));
  assert.ok(!md.includes("'acme-set:a02'"), 'a failing case is never in the activation statement');
  assert.ok(md.includes('**Do not run the activation file**'));
  assert.ok(md.includes('$0.0400'));
});

test('the report says so when the prompt moved mid-run, when no model answered, and when nothing passed', () => {
  const parsed = parseSet(minimal());
  assert.ok(parsed.ok);
  const unchecked: CaseRun = { id: 'a01', ok: true, reply: null, answeredBy: null, flags: [], pass: false, outcome: 'unchecked', why: ['no key'], calls: [], totalMs: 1 };
  const md = renderReport(parsed.set, fakeRun(parsed.set, [unchecked], { contentHashAfter: 'bbbbbbbbbbbb', callsMade: 0 }), { runFile: 'r', generator: 'g' });
  assert.match(md, /The live prompt CHANGED during the run/u);
  assert.match(md, /No model answered in this run/u);
  assert.match(md, /nothing to switch on/u);
  assert.doesNotMatch(md, /update reply_cases/u);
});

test('the report says every case passed only when every case of the set ran and passed', () => {
  const parsed = parseSet(minimal());
  assert.ok(parsed.ok);
  const ok: CaseRun = { id: 'a01', ok: true, reply: 'Сайн байна уу', answeredBy: 'model', flags: [], pass: true, outcome: 'pass', why: [], calls: [], totalMs: 1 };
  assert.match(renderReport(parsed.set, fakeRun(parsed.set, [ok]), { runFile: 'r', generator: 'g' }), /Every case passed/u);
  assert.match(renderReport(parsed.set, fakeRun(parsed.set, []), { runFile: 'r', generator: 'g' }), /nothing to switch on/u);
});
