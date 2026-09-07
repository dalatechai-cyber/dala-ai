/**
 * Every PostgREST call chain in `src/`, read out of the source once.
 *
 * ## Why this is a module and not two copies
 *
 * `query-columns.ts` checks column references against the applied schema; `postgrest.ts`
 * checks them against what a real PostgREST actually exposes. They ask different questions
 * of the same facts, and until 2026-09-07 they each had their own idea of what a call site
 * looked like — `query-columns.ts` walked a bounded chain window and read `.select()`,
 * `.insert()`, `.update()` and `.upsert()`; `postgrest.ts` matched only `.from('t').select(…)`
 * with the select immediately adjacent.
 *
 * So the transport check — the one that runs against the wire, the layer D-029's third bug
 * lived in — saw no writes at all. `worker/reception.ts` already carries a hand-written test
 * pinning one insert's `tenant_id`, with the note that omitting it "is a write that every
 * stub accepts and PostgREST rejects": that is precisely the class, and it was checked in
 * one place by hand rather than everywhere by machine.
 *
 * Two parsers drifting is the shape this repository keeps finding (D-026's two orderings,
 * D-053's two calendars). One walker, two consumers.
 *
 * ## What it cannot parse, it MARKS
 *
 * A dynamically built select, a spread, or a computed key cannot be resolved statically.
 * Those come back as `null` — never as an empty list — so a caller can report them. A skip
 * nobody can see is the failure mode both checks exist to remove.
 */
import fs from 'node:fs';
import path from 'node:path';

export type WriteUse = {
  verb: 'insert' | 'update' | 'upsert';
  /** Literal keys, or null when the payload hides them (a spread, a variable, a computed key). */
  keys: string[] | null;
};

export type ChainUse = {
  file: string;
  line: number;
  table: string;
  /** The literal select list, or null when there is no `.select()` in the chain. */
  select: string | null;
  /** True when a `.select()` is present but its argument is not a literal. */
  selectUnparseable: boolean;
  writes: WriteUse[];
};

/**
 * Split on commas that are not nested.
 *
 * Tracks braces and brackets as well as parentheses: an insert whose value is itself an
 * object — `detail: cond ? { a } : { a, b }` — is extremely common here, and a splitter
 * that only counted parens gave up on it and reported the whole site as unresolvable.
 * Under-reading is not as bad as a silent skip, but it is still a check that quietly
 * covers less than it appears to.
 */
export function topLevelSplit(s: string): string[] {
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

/** Remove `//` and block comments, leaving string literals — which may contain `//` — alone. */
export function stripComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] ?? '';
    const next = s[i + 1];
    if (ch === '/' && next === '/') { const nl = s.indexOf('\n', i); if (nl < 0) break; i = nl - 1; continue; }
    if (ch === '/' && next === '*') { const end = s.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < s.length && s[i] !== quote) { if (s[i] === '\\') { out += s[i] ?? ''; i += 1; } out += s[i] ?? ''; i += 1; }
      out += quote;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Literal object keys from `{ a: 1, 'b': 2 }`. Returns null when it cannot be trusted. */
export function parseObjectKeys(src: string): string[] | null {
  let depth = 0;
  let body = '';
  let started = false;
  let closed = false;
  for (const ch of src) {
    if (ch === '{') { depth += 1; started = true; if (depth === 1) continue; }
    if (ch === '}') { depth -= 1; if (depth === 0) { closed = true; break; } }
    if (started) body += ch;
  }
  if (!started) return null;
  // An object whose brace never closes was TRUNCATED — the window ended inside it. Reading
  // the keys found so far and returning them is the worst available answer: the site then
  // reports as checked while most of its columns were never examined. `spend_ledger`'s
  // insert read as two keys that way, and a mutation renaming `cost_nanousd` sailed through
  // both checks. Undetermined is a result; a partial answer dressed as a whole one is not.
  if (!closed) return null;
  if (body.includes('...')) return null;                // a spread hides its keys
  // Strip comments BEFORE flattening newlines. Otherwise a trailing `// …` comment swallows
  // the key on the following line once the newline becomes a space.
  //
  // String-aware, and that is not fussiness: the naive `replace(/\/\/.*$/, '')` treats the
  // `//` in `'https://graph.facebook.com'` as the start of a comment and drops every key
  // after it on that line. Two of this runtime's payloads carry a URL, so the check read
  // one key and called the site done.
  const flat = stripComments(body).split('\n').join(' ');
  const keys: string[] = [];
  for (const part of topLevelSplit(flat)) {
    // `key: value`, quoted or not.
    const named = part.match(/^'?([a-z_][a-z_0-9]*)'?\s*:/i);
    if (named !== null) { keys.push(named[1] ?? ''); continue; }
    // SHORTHAND — `{ surface }` is `surface: surface`, and the key is right there. Missing
    // this made ONE shorthand poison a whole payload: `spend_ledger`'s insert has fifteen
    // literal keys and a bare `surface`, so the ledger row — the write a customer waits on
    // and the one D-004's margin is read from — reported as unresolvable and was checked
    // by nothing. It sat in the "not statically resolvable" list looking like an honest
    // limitation rather than the gap it was.
    const shorthand = part.match(/^([a-z_][a-z_0-9]*)$/i);
    if (shorthand !== null) { keys.push(shorthand[1] ?? ''); continue; }
    return null;
  }
  return keys;
}

/**
 * The call chain, ending at the statement that contains it.
 *
 * It used to be `indexOf(';')`, and a semicolon inside a COMMENT cut the window mid-payload:
 * `settle.ts`'s ledger insert carries the line "…bill to themselves; quality is Dalatech's
 * own process…", so the window ended after two keys and the other thirteen were never
 * checked by either file. Nothing said so, because a truncated payload still parses.
 *
 * So this skips comments and string literals, and stops only at a `;` that is really a
 * statement end — at depth zero, outside both. A URL's `//` and an apostrophe in an English
 * comment are the two things a naive scanner gets wrong, and both are in this source.
 */
export function chainWindow(rest: string): string {
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    const next = rest[i + 1];

    if (ch === '/' && next === '/') { const nl = rest.indexOf('\n', i); if (nl < 0) return rest.slice(0, i); i = nl; continue; }
    if (ch === '/' && next === '*') { const end = rest.indexOf('*/', i + 2); if (end < 0) return rest.slice(0, i); i = end + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < rest.length && rest[i] !== quote) { if (rest[i] === '\\') i += 1; i += 1; }
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; continue; }
    if (ch === ';' && depth <= 0) return rest.slice(0, i);
    if (depth <= 0 && rest.startsWith('.from(', i) && i > 0) return rest.slice(0, i);
  }
  return rest;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * The roots whose PostgREST calls are checked.
 *
 * `scripts/publish/` is here and the rest of `scripts/` is not, deliberately. That command
 * talks to the REAL project with real column names, so a select naming a column the database
 * does not have fails at an operator's shell mid-publish — the same failure the runtime's
 * checks exist to prevent, in the one other place that reaches production data. The verify
 * and localvalidate scripts talk to a scratch cluster over psql and are not PostgREST at all.
 */
export const CHECKED_ROOTS = ['src', 'scripts/publish'] as const;

/** Every `.from('table')…` chain in the tree, with whatever of it resolves statically. */
export function chainsFromSource(root: string | readonly string[] = CHECKED_ROOTS): ChainUse[] {
  const roots = typeof root === 'string' ? [root] : root;
  const chains: ChainUse[] = [];
  for (const file of roots.flatMap((r) => (fs.existsSync(r) ? walk(r, []) : []))) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /\.from\('([a-z_0-9]+)'\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const table = m[1] ?? '';
      const line = text.slice(0, m.index).split('\n').length;
      const window = chainWindow(text.slice(m.index + m[0].length));

      const sel = window.match(/\.select\(\s*(['"`])([^'"`]*)\1/);
      const writes: WriteUse[] = [];
      for (const verb of ['insert', 'update', 'upsert'] as const) {
        const at = window.indexOf(`.${verb}(`);
        if (at < 0) continue;
        writes.push({ verb, keys: parseObjectKeys(window.slice(at)) });
      }

      chains.push({
        file, line, table,
        select: sel === null ? null : (sel[2] ?? ''),
        selectUnparseable: sel === null && /\.select\(/.test(window),
        writes,
      });
    }
  }
  return chains;
}
