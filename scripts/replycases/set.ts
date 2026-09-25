/**
 * A tenant's test set: one JSON file that is BOTH the founder's native-read set and the
 * source of the tenant's permanent `reply_cases` rows (D-120).
 *
 * One file for both on purpose. A case the founder read is the case the gate will judge —
 * same message, same history, same assertions — so the first run through
 * `scripts/bakeoff/testset.ts` is the proof the rows need before they may be switched on,
 * and nothing can drift between "what was read" and "what gates deploys".
 *
 * Everything here is PURE: parsing, the SQL the rows are written with, the activation
 * statement, and the Markdown report. The runner does the I/O.
 *
 * ## Why a case is validated before it can exist
 *
 * An active case that cannot pass blocks every production deploy. So a case that could
 * never pass is refused here, before it is a row: an `expected_body` that its own
 * must-not list rejects (checked with the gate's own `judge()`), a must-include that a
 * must-not swallows, a one-character assertion that any reply trips, a history that does
 * not alternate. None of this proves a case RIGHT — only the founder's read does that —
 * but it proves it is not self-contradictory.
 */
import { judge, type ReplyCase } from '../../src/lib/replycases/run.ts';
import { cpLength, fold, nfc } from '../../src/lib/mn/text.ts';
import { numeralsNotAllowed, extractNumerals, maskUrls } from '../../src/lib/mn/extract.ts';

export type Turn = { role: 'user' | 'assistant'; content: string };

export type SetCase = {
  id: string;
  category: string;
  source: string;
  text: string;
  history: Turn[];
  expect: string;
  mustInclude: string[];
  /** The case's own list, before `always_not` is merged in. */
  mustNotInclude: string[];
  expectedBody: string | null;
};

export type TestSet = {
  title: string;
  tenantSlug: string;
  notePrefix: string;
  report: string;
  /** Where the generated insert and activation files live. */
  sql: string;
  activationSql: string;
  categories: Record<string, string>;
  alwaysNot: string[];
  cases: SetCase[];
};

/** Shortest assertion accepted: a one-character substring matches nearly any reply. */
export const MIN_ASSERTION_CP = 2;

const ID = /^[a-z][a-z0-9-]{0,15}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function strings(v: unknown, where: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errors.push(`${where}: must be an array of strings`);
    return [];
  }
  return v as string[];
}

/** NFC is required, not applied: a fixture that is not NFC would be stored as written. */
function checkText(s: string, where: string, errors: string[]): void {
  if (s.trim() === '') errors.push(`${where}: is blank`);
  if (nfc(s) !== s) errors.push(`${where}: is not NFC`);
}

/** Parse and validate a set. Every problem is reported, not only the first. */
export function parseSet(raw: unknown): { ok: true; set: TestSet } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim() === '') { errors.push(`${k}: required`); return ''; }
    return v;
  };
  const title = str('title');
  const tenantSlug = str('tenant_slug');
  const notePrefix = str('note_prefix');
  const report = str('report');
  const sql = str('sql');
  const activationSql = str('activation_sql');
  if (tenantSlug !== '' && !SLUG.test(tenantSlug)) errors.push('tenant_slug: not a slug');
  if (notePrefix !== '' && !SLUG.test(notePrefix)) errors.push('note_prefix: letters, digits and hyphens only');
  const categories: Record<string, string> = {};
  const rawCats = o['categories'];
  if (typeof rawCats !== 'object' || rawCats === null || Array.isArray(rawCats)) errors.push('categories: required');
  else for (const [k, v] of Object.entries(rawCats)) categories[k] = String(v);
  const alwaysNot = strings(o['always_not'], 'always_not', errors);
  alwaysNot.forEach((s, i) => checkText(s, `always_not[${i}]`, errors));

  const cases: SetCase[] = [];
  const seen = new Set<string>();
  const rawCases = o['cases'];
  if (!Array.isArray(rawCases) || rawCases.length === 0) errors.push('cases: required');
  for (const [i, rc] of (Array.isArray(rawCases) ? rawCases : []).entries()) {
    const c = (rc ?? {}) as Record<string, unknown>;
    const id = typeof c['id'] === 'string' ? c['id'] : '';
    const at = `case ${id === '' ? `#${i}` : id}`;
    if (!ID.test(id)) errors.push(`${at}: id must match ${ID}`);
    if (seen.has(id)) errors.push(`${at}: duplicate id`);
    seen.add(id);
    const category = typeof c['category'] === 'string' ? c['category'] : '';
    if (!(category in categories)) errors.push(`${at}: category «${category}» is not in categories`);
    const text = typeof c['text'] === 'string' ? c['text'] : '';
    checkText(text, `${at}.text`, errors);
    const expect = typeof c['expect'] === 'string' ? c['expect'] : '';
    if (expect.trim() === '') errors.push(`${at}.expect: required`);
    const source = typeof c['source'] === 'string' ? c['source'] : '';
    if (source.trim() === '') errors.push(`${at}.source: required`);

    const history: Turn[] = [];
    const rawHistory = c['history'] ?? [];
    if (!Array.isArray(rawHistory)) errors.push(`${at}.history: must be an array`);
    for (const [j, t] of (Array.isArray(rawHistory) ? rawHistory : []).entries()) {
      const tt = (t ?? {}) as Record<string, unknown>;
      const role = tt['role'];
      const content = typeof tt['content'] === 'string' ? tt['content'] : '';
      const want = j % 2 === 0 ? 'user' : 'assistant';
      if (role !== want) errors.push(`${at}.history[${j}]: expected role ${want}`);
      checkText(content, `${at}.history[${j}].content`, errors);
      history.push({ role: want, content });
    }
    if (history.length % 2 !== 0) errors.push(`${at}.history: must end with an assistant turn`);

    const mustInclude = strings(c['must_include'], `${at}.must_include`, errors);
    const mustNotInclude = strings(c['must_not_include'], `${at}.must_not_include`, errors);
    for (const [k, s] of [...mustInclude, ...mustNotInclude].entries()) {
      checkText(s, `${at} assertion ${k}`, errors);
      if (cpLength(s.trim()) < MIN_ASSERTION_CP) errors.push(`${at}: assertion «${s}» is shorter than ${MIN_ASSERTION_CP} characters`);
    }
    const eb = c['expected_body'];
    const expectedBody = typeof eb === 'string' ? eb : null;
    if (eb !== undefined && eb !== null && typeof eb !== 'string') errors.push(`${at}.expected_body: must be a string`);
    if (expectedBody !== null) checkText(expectedBody, `${at}.expected_body`, errors);

    const allNot = merged(mustNotInclude, alwaysNot);
    for (const inc of mustInclude) {
      for (const exc of allNot) {
        if (fold(inc).includes(fold(exc))) errors.push(`${at}: must_include «${inc}» contains must_not «${exc}», so no reply can pass`);
      }
    }
    if (expectedBody !== null) {
      const why = judge(asReplyCase({ id, category, source, text, history, expect, mustInclude, mustNotInclude, expectedBody }, alwaysNot, 0), expectedBody);
      if (why.length > 0) errors.push(`${at}: its own expected_body fails it: ${why.join('; ')}`);
    }
    cases.push({ id, category, source, text, history, expect, mustInclude, mustNotInclude, expectedBody });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, set: { title, tenantSlug, notePrefix, report, sql, activationSql, categories, alwaysNot, cases } };
}

/** The case's must-not list with the set-wide list after it, first occurrence kept. */
export function merged(own: readonly string[], always: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...own, ...always]) {
    const k = fold(s);
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}

/** The case as `replycases/run.ts` judges it. `n` is the numeric id the runner needs. */
export function asReplyCase(c: SetCase, alwaysNot: readonly string[], n: number): ReplyCase {
  return {
    id: n,
    customerMessage: c.text,
    history: c.history,
    expectedBody: c.expectedBody,
    mustInclude: c.mustInclude,
    mustNotInclude: merged(c.mustNotInclude, alwaysNot),
    note: null,
  };
}

/**
 * The `note` a case is stored with. It starts `<prefix>:<id> ` so a row can be found by its
 * set id — for the insert's own idempotence and for the activation statement.
 */
export function noteOf(set: TestSet, c: SetCase): string {
  return `${set.notePrefix}:${c.id} — ${c.expect}`;
}

// ---------------------------------------------------------------------------------- SQL

/** A SQL string literal. Standard-conforming strings, so only the quote is doubled. */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function textArray(xs: readonly string[]): string {
  return xs.length === 0 ? `'{}'::text[]` : `array[${xs.map(lit).join(', ')}]::text[]`;
}

/**
 * The rows, inactive. Rerunnable: a case whose `<prefix>:<id>` already exists for the
 * tenant is skipped, never duplicated and never overwritten — a case that was read and
 * activated must not be silently replaced by a later edit of the file.
 */
export function renderSql(set: TestSet, generatedBy: string): string {
  const lines: string[] = [];
  lines.push(`-- ${set.title}: ${set.cases.length} reply cases for tenant «${set.tenantSlug}», INACTIVE (D-120).`);
  lines.push(`-- GENERATED by ${generatedBy} — edit the set, then regenerate; a unit test fails on drift.`);
  lines.push('--');
  lines.push('-- The order, and none of it may be skipped:');
  lines.push('--   1. Apply this file. Every row goes in with active = false, so nothing gates a deploy yet.');
  lines.push('--   2. Run the set: node scripts/bakeoff/testset.ts (see scripts/bakeoff/README.md).');
  lines.push(`--      It answers every case through the production reply path and writes ${set.report}.`);
  lines.push('--   3. The founder reads every reply in that report.');
  lines.push('--   4. Activate — with the statement the report prints, which names only the cases that');
  lines.push('--      PASSED. The activation file beside this one switches on every case and is right');
  lines.push('--      only when the report says every case passed.');
  lines.push('-- An active case that fails blocks every production build and every publish.');
  lines.push('begin;');
  lines.push('');
  lines.push('do $$');
  lines.push('begin');
  lines.push(`  if not exists (select 1 from tenants where slug = ${lit(set.tenantSlug)}) then`);
  lines.push(`    raise exception 'no tenant with slug ${set.tenantSlug.replace(/'/g, "''")}';`);
  lines.push('  end if;');
  lines.push('end');
  lines.push('$$;');
  lines.push('');
  for (const c of set.cases) {
    const note = noteOf(set, c);
    const key = `${set.notePrefix}:${c.id}`;
    lines.push(`-- ${c.id} · ${c.category}`);
    lines.push('insert into reply_cases (tenant_id, history, customer_message, expected_body, must_include, must_not_include, note, active)');
    lines.push(`select t.id, ${lit(JSON.stringify(c.history))}::jsonb, ${lit(c.text)},`);
    lines.push(`       ${c.expectedBody === null ? 'null' : lit(c.expectedBody)},`);
    lines.push(`       ${textArray(c.mustInclude)},`);
    lines.push(`       ${textArray(merged(c.mustNotInclude, set.alwaysNot))},`);
    lines.push(`       ${lit(note)}, false`);
    lines.push(`from tenants t where t.slug = ${lit(set.tenantSlug)}`);
    lines.push(`  and not exists (select 1 from reply_cases r where r.tenant_id = t.id and split_part(r.note, ' ', 1) = ${lit(key)});`);
    lines.push('');
  }
  lines.push('commit;');
  return `${lines.join('\n')}\n`;
}

/**
 * ONE statement that switches cases on. With `ids`, only those; without, the whole set.
 *
 * It only ever switches ON. Re-running an old one would also switch back on a case a
 * person has switched off since, so the statement to run is the one the LATEST report
 * printed, never one kept from an earlier run.
 */
export function renderActivationSql(set: TestSet, ids?: readonly string[]): string {
  if (ids !== undefined && ids.length === 0) throw new Error('renderActivationSql: no ids — there is nothing to switch on');
  const keys = (ids ?? set.cases.map((c) => c.id)).map((id) => `${set.notePrefix}:${id}`);
  return `update reply_cases set active = true\n`
    + ` where tenant_id = (select id from tenants where slug = ${lit(set.tenantSlug)})\n`
    + `   and active = false\n`
    + `   and split_part(note, ' ', 1) in (${keys.map(lit).join(', ')});\n`;
}

// ------------------------------------------------------------------------------- the run

export type Call = { ms: number; kind: string; reason?: string; text?: string; usage?: Record<string, number>; usd?: number | null };

export type CaseRun = {
  id: string;
  ok: boolean;
  error?: string;
  reply: string | null;
  answeredBy: string | null;
  flags: string[];
  pass: boolean;
  outcome: 'pass' | 'wrong' | 'unchecked';
  why: string[];
  calls: Call[];
  totalMs: number;
};

export type Run = {
  ranAt: string;
  tenant: string;
  model: string;
  now: string;
  source: string;
  revisionId: string | null;
  contentHash: string | null;
  contentHashAfter: string | null;
  allowedNumbers: string[];
  callsMade: number;
  results: CaseRun[];
};

/**
 * Report-only checks, on the SERVED reply. They never change a case's verdict — the gate's
 * `judge()` is the only verdict — and exist because two founder rules cannot be written as
 * substrings: "no invented digits" and "customer-facing text is Mongolian Cyrillic".
 */
export function extraChecks(reply: string | null, customerText: string, allowedNumbers: readonly string[]): string[] {
  if (reply === null) return [];
  const out: string[] = [];
  const echoed = extractNumerals(maskUrls(customerText)).map((n) => n.raw);
  const bad = numeralsNotAllowed(reply, [...allowedNumbers, ...echoed]);
  if (bad.length > 0) out.push(`numeral not on the allow-list: ${bad.join(', ')}`);
  const letters = [...maskUrls(reply)].filter((ch) => /\p{L}/u.test(ch));
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  if (letters.length > 0 && latin / letters.length > 0.3) out.push(`${Math.round((100 * latin) / letters.length)}% of letters are Latin`);
  return out;
}

const cell = (s: string | null | undefined): string => (s ?? '—').replace(/\|/g, '\\|').replace(/\n+/g, ' ⏎ ').trim();
const secs = (ms: number | undefined): string => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);

/**
 * The report, in `matrix-bakeoff.md`'s format: every reply VERBATIM from the capture.
 * Nothing here composes, shortens or paraphrases a Mongolian reply — the native read is
 * the point, and a paraphrase would make it worthless.
 */
export function renderReport(set: TestSet, run: Run, opts: { runFile: string; generator: string }): string {
  const L: string[] = [];
  const P = (s = ''): void => { L.push(s); };
  const byId = new Map(run.results.map((r) => [r.id, r]));
  const cases = set.cases.filter((c) => byId.has(c.id));
  const results = cases.map((c) => byId.get(c.id) as CaseRun);
  const passed = results.filter((r) => r.outcome === 'pass');
  const wrong = results.filter((r) => r.outcome === 'wrong');
  const unchecked = results.filter((r) => r.outcome === 'unchecked');
  const usd = results.flatMap((r) => r.calls).map((c) => c.usd).filter((x): x is number => typeof x === 'number');
  const priced = usd.length === results.flatMap((r) => r.calls).length;

  P(`# ${set.title} — every reply, for the native read`);
  P();
  P(`Generated by \`${opts.generator}\` from \`${opts.runFile}\`. Run ${run.ranAt}, answered as of ${run.now}, `
    + `tenant \`${run.tenant}\`, model \`${run.model}\`, configuration from ${run.source}.`);
  P();
  P(`Live revision \`${run.revisionId ?? '—'}\`, prompt \`${(run.contentHash ?? '—').slice(0, 12)}\`.`);
  if (run.contentHash !== run.contentHashAfter) {
    P();
    P(`> **The live prompt CHANGED during the run** (\`${(run.contentHash ?? '—').slice(0, 12)}\` → \`${(run.contentHashAfter ?? '—').slice(0, 12)}\`). `
      + 'Cases answered before and after the change were answered by different configurations. Run it again.');
  }
  if (run.callsMade === 0 && results.some((r) => r.outcome === 'unchecked')) {
    P();
    P('> **No model answered in this run.** Every case that needs the model is UNCHECKED below. This page is not the native read; '
      + 'run it again with `ANTHROPIC_API_KEY` set.');
  }
  P();
  P('**Every Mongolian reply below is verbatim from the capture file.** Nothing is paraphrased, shortened or composed for this page.');
  P();
  P('Every message went through `gateTenant` — the gate the production build runs — so the prompt, deterministic rows, '
    + 'pinned lines, facts guard and outbound guard are production\'s own. Nothing was sent to anyone and nothing was written.');
  P();
  P('## Summary');
  P();
  P('| | |');
  P('|---|---|');
  P(`| Cases | ${results.length} |`);
  P(`| Pass | ${passed.length} |`);
  P(`| Wrong (answered, and an assertion failed) | ${wrong.length} |`);
  P(`| Unchecked (no answer could be judged) | ${unchecked.length} |`);
  P(`| Answered by the model / a row / a canned line | ${results.filter((r) => r.answeredBy === 'model').length} / `
    + `${results.filter((r) => r.answeredBy === 'deterministic').length} / ${results.filter((r) => r.answeredBy === 'canned').length} |`);
  P(`| Model calls | ${run.callsMade} |`);
  P(`| Model spend, from each call's own usage | ${usd.length === 0 ? '—' : `$${usd.reduce((a, b) => a + b, 0).toFixed(4)}${priced ? '' : ' (some calls unpriced)'}`} |`);
  P();
  P('| Category | cases | pass |');
  P('|---|---|---|');
  for (const [key, label] of Object.entries(set.categories)) {
    const inCat = cases.filter((c) => c.category === key);
    if (inCat.length === 0) continue;
    P(`| ${label} | ${inCat.length} | ${inCat.filter((c) => byId.get(c.id)?.outcome === 'pass').length} |`);
  }
  P();
  P('`model` = the model answered · `deterministic` = a tenant row answered with no model · `canned` = a reviewed line or '
    + 'published FAQ answer was served · a flag in brackets is a guard\'s record. **model wrote** is shown only where a guard '
    + 'discarded the model\'s text and served something else. **Also noted** is report-only: it never changes a verdict.');
  P();

  for (const [key, label] of Object.entries(set.categories)) {
    const inCat = cases.filter((c) => c.category === key);
    if (inCat.length === 0) continue;
    P(`## ${label}`);
    P();
    for (const c of inCat) {
      const r = byId.get(c.id) as CaseRun;
      P(`### \`${c.id}\` «${cell(c.text)}»`);
      P();
      P(`*Expected:* ${c.expect} *(${c.source})*`);
      P();
      if (c.history.length > 0) {
        P('| before | |');
        P('|---|---|');
        for (const t of c.history) P(`| ${t.role === 'user' ? 'customer' : 'bot'} | ${cell(t.content)} |`);
        P();
      }
      const call = r.calls.find((x) => x.kind === 'ok');
      const flags = r.flags.length > 0 ? ` _[${r.flags.join(', ')}]_` : '';
      P('| | reply | by | time |');
      P('|---|---|---|---|');
      P(`| **served** | ${cell(r.ok ? r.reply : `ERROR: ${r.error ?? ''}`)}${flags} | ${r.answeredBy ?? '—'} | ${secs(call?.ms)} |`);
      if (call !== undefined && r.answeredBy !== 'model') P(`| model wrote | ${cell(call.text)} | | |`);
      P();
      const verdict = r.outcome === 'pass' ? '**PASS**' : r.outcome === 'wrong' ? '**WRONG**' : '**UNCHECKED**';
      P(`${verdict}${r.why.length > 0 ? ` — ${r.why.map(cell).join('; ')}` : ''}`);
      const extra = extraChecks(r.reply, c.text, run.allowedNumbers);
      if (extra.length > 0) { P(); P(`*Also noted:* ${extra.join('; ')}`); }
      P();
    }
  }

  P('## After the read');
  P();
  P(`The cases are rows in \`reply_cases\` with \`active = false\` (\`${set.sql}\`). None gates anything until it is switched on.`);
  P();
  if (passed.length === results.length && results.length === set.cases.length) {
    P(`Every case passed. Once the read agrees with every PASS above, switch them all on (\`${set.activationSql}\` is the same statement):`);
  } else {
    P(`${passed.length} of ${set.cases.length} cases passed. **Do not run the activation file** — it switches on every case, `
      + 'and a failing active case blocks every deploy. This statement switches on only the cases that passed here; '
      + 'strike from it any the read disagrees with:');
  }
  P();
  if (passed.length === 0) {
    P('_No case passed, so there is nothing to switch on._');
  } else {
    P('```sql');
    P(renderActivationSql(set, passed.map((r) => r.id)).trimEnd());
    P('```');
  }
  P();
  P('A WRONG case is either the bot being wrong (fix the data or the code, run again) or the case being wrong (fix '
    + 'the set, regenerate the SQL, update the row). The read decides which. An UNCHECKED case could not be judged at all.');
  return `${L.join('\n')}\n`;
}
