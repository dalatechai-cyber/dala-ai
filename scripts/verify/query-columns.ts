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
 * The parser lives in `querysites.ts` and is shared with `postgrest.ts`, which asks the
 * same facts of a real PostgREST rather than of the applied schema. It reads literal
 * `.select('…')` strings and literal
 * `.insert({…})` / `.update({…})` / `.upsert({…})` key sets. A dynamically built select, a
 * spread, or a computed key cannot be resolved statically — and those are listed as
 * UNCHECKED with their file and line rather than skipped. A skip nobody can see is the
 * failure mode this file exists to remove, and reintroducing it one layer up would be a
 * poor joke.
 */
import { execFileSync } from 'node:child_process';
import { CHECKED_ROOTS, chainsFromSource, topLevelSplit } from './querysites.ts';

const SRC = CHECKED_ROOTS.join(' + ');
const db = process.argv[2] ?? 'dala_verify';

type Site = { file: string; line: number; table: string; columns: string[] };

const sites: Site[] = [];
const unchecked: string[] = [];

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

for (const c of chainsFromSource(CHECKED_ROOTS)) {
  if (c.select !== null) parseSelect(c.select, c.table, c.file, c.line);
  else if (c.selectUnparseable) unchecked.push(`${c.file}:${c.line} .select() argument is not a literal`);

  for (const w of c.writes) {
    if (w.keys === null) { unchecked.push(`${c.file}:${c.line} .${w.verb}() keys are not statically resolvable`); continue; }
    if (w.keys.length > 0) sites.push({ file: c.file, line: c.line, table: c.table, columns: w.keys });
  }
}

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
console.log(`  checked ${checkedColumns} column references across ${sites.length} query sites in ${SRC}`);
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
