#!/usr/bin/env node
/**
 * Every column named in a PostgREST query in `src/` exists in the real schema.
 *
 * ## The gap this closes
 *
 * `STATUS.md` has said since Track 2 that no query in `src/` has ever been sent over the
 * wire: every one is exercised against a stub. A stub answers whatever the test wants, so
 * a `.select('naem')` or an insert naming a column that does not exist passes every test
 * in the suite and fails the first time it reaches PostgREST — which, on the send path, is
 * the first real customer message.
 *
 * The repository already knows this bug class. `worker/reception.ts` carries a hand-written
 * test pinning one insert's `tenant_id` with the note that omitting it "is a write that
 * every stub accepts and PostgREST rejects". This is that test generalised: it reads the
 * columns out of the SOURCE and checks them against a database that has actually had the
 * migrations applied.
 *
 * It needs no credentials and no Supabase project. CI's scratch PostgreSQL carries the same
 * schema, which is the whole point — the check runs on every PR.
 *
 * ## What it cannot parse, it REPORTS
 *
 * The parser is deliberately simple: it reads literal `.select('…')` strings and literal
 * `.insert({…})` / `.update({…})` / `.upsert({…})` key sets. A dynamically built select, a
 * spread, or a computed key cannot be resolved statically — and those are listed as
 * UNCHECKED with their file and line rather than skipped. A skip nobody can see is the
 * failure mode this file exists to remove, and reintroducing it one layer up would be a
 * poor joke.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const db = process.argv[2] ?? 'dala_verify';

type Site = { file: string; line: number; table: string; columns: string[] };

const sites: Site[] = [];
const unchecked: string[] = [];

/**
 * Split on commas that are not nested.
 *
 * Tracks braces and brackets as well as parentheses: an insert whose value is itself an
 * object — `detail: cond ? { a } : { a, b }` — is extremely common here, and a splitter
 * that only counted parens gave up on it and reported the whole site as unresolvable.
 * Under-reading is not as bad as a silent skip, but it is still a check that quietly
 * covers less than it appears to.
 */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** `a, b, other!inner(c, d)` → columns on this table, plus embedded (table, columns). */
function parseSelect(list: string, table: string, file: string, line: number): void {
  if (list.trim() === '*') return;                      // nothing named, nothing to check
  const own: string[] = [];
  for (const part of topLevelSplit(list)) {
    const embed = part.match(/^([a-z_0-9]+)\s*(?:!(?:inner|left))?\s*\((.*)\)$/is);
    if (embed !== null) {
      parseSelect(embed[2] ?? '', embed[1] ?? '', file, line);
      continue;
    }
    // `alias:column` renames; the real column is on the right.
    const renamed = part.match(/^[a-z_0-9]+\s*:\s*([a-z_0-9]+)$/i);
    const name = (renamed?.[1] ?? part).trim();
    if (/^[a-z_][a-z_0-9]*$/i.test(name)) own.push(name);
    else unchecked.push(`${file}:${line} select fragment not statically resolvable: ${part}`);
  }
  if (own.length > 0) sites.push({ file, line, table, columns: own });
}

/** Literal object keys from `{ a: 1, 'b': 2 }`. Returns null when it cannot be trusted. */
function parseObjectKeys(src: string): string[] | null {
  let depth = 0;
  let body = '';
  let started = false;
  for (const ch of src) {
    if (ch === '{') { depth += 1; started = true; if (depth === 1) continue; }
    if (ch === '}') { depth -= 1; if (depth === 0) break; }
    if (started) body += ch;
  }
  if (!started) return null;
  if (body.includes('...')) return null;                // a spread hides its keys
  // Strip line comments BEFORE flattening newlines. Otherwise a trailing `// …` comment
  // swallows the key on the following line once the newline becomes a space, and the whole
  // site reports as unresolvable — which is honest but covers less than it looks like.
  const flat = body.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join(' ');
  const keys: string[] = [];
  for (const part of topLevelSplit(flat)) {
    const m = part.match(/^'?([a-z_][a-z_0-9]*)'?\s*:/i);
    if (m === null) return null;
    keys.push(m[1] ?? '');
  }
  return keys;
}

function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;

    const text = fs.readFileSync(full, 'utf8');
    const re = /\.from\('([a-z_0-9]+)'\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const table = m[1] ?? '';
      const line = text.slice(0, m.index).split('\n').length;
      const rest = text.slice(m.index + m[0].length);
      // Bound the chain: the next statement or the next .from() ends it, whichever first.
      const stops = [rest.indexOf(';'), rest.indexOf('.from(')].filter((x) => x >= 0);
      const window = rest.slice(0, stops.length > 0 ? Math.min(...stops) : rest.length);

      const sel = window.match(/\.select\(\s*(['"`])([^'"`]*)\1/);
      if (sel !== null) parseSelect(sel[2] ?? '', table, full, line);
      else if (/\.select\(/.test(window)) unchecked.push(`${full}:${line} .select() argument is not a literal`);

      for (const verb of ['insert', 'update', 'upsert'] as const) {
        const at = window.indexOf(`.${verb}(`);
        if (at < 0) continue;
        const keys = parseObjectKeys(window.slice(at));
        if (keys === null) { unchecked.push(`${full}:${line} .${verb}() keys are not statically resolvable`); continue; }
        if (keys.length > 0) sites.push({ file: full, line, table, columns: keys });
      }
    }
  }
}

walk(SRC);

// ---- the schema, from the database rather than from a doc -------------------
const raw = execFileSync('psql', ['-d', db, '-tAc',
  "select table_name || ':' || string_agg(column_name, ',') from information_schema.columns " +
  "where table_schema='public' group by table_name"], { encoding: 'utf8' });

const schema = new Map<string, Set<string>>();
for (const row of raw.split('\n').filter((r) => r.trim() !== '')) {
  const [t, cols] = row.split(':');
  schema.set(t ?? '', new Set((cols ?? '').split(',')));
}

const problems: string[] = [];
for (const s of sites) {
  const cols = schema.get(s.table);
  if (cols === undefined) {
    problems.push(`${s.file}:${s.line} queries table "${s.table}", which does not exist`);
    continue;
  }
  for (const c of s.columns) {
    if (!cols.has(c)) problems.push(`${s.file}:${s.line} ${s.table}.${c} does not exist`);
  }
}

const checkedColumns = sites.reduce((n, s) => n + s.columns.length, 0);
console.log(`  checked ${checkedColumns} column references across ${sites.length} query sites in ${SRC}/`);
if (unchecked.length > 0) {
  console.log(`  ${unchecked.length} reference(s) NOT statically resolvable (listed, never skipped silently):`);
  for (const u of unchecked) console.log(`    - ${u}`);
}
if (problems.length > 0) {
  console.error(`QUERY COLUMN CHECK FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('QUERY COLUMNS OK (every literal column reference exists in the applied schema)');
