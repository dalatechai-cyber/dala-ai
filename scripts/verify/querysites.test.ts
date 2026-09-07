import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKED_ROOTS, chainWindow, parseObjectKeys, chainsFromSource } from './querysites.ts';

test('DONE-TEST: A SEMICOLON INSIDE A COMMENT DOES NOT END THE CHAIN', () => {
  // The window was `indexOf(';')`. `settle.ts`'s ledger insert carries the comment
  // "…bill to themselves; quality is Dalatech's own process…", so the window ended after
  // two keys and the other thirteen were checked by nothing — while the site still
  // reported as checked. A mutation renaming `cost_nanousd` passed both files.
  const src = `.insert({
    tenant_id: t,
    surface,
    // one thing; and another
    cost_nanousd: n,
  });`;
  const keys = parseObjectKeys(chainWindow(src));
  assert.deepEqual(keys, ['tenant_id', 'surface', 'cost_nanousd']);
});

test('nor does a semicolon or a // inside a string literal', () => {
  // Both are in this source: Graph API URLs, and SQL fragments with semicolons.
  const src = `.insert({ url: 'https://graph.facebook.com/v21.0', q: 'select 1; select 2' });`;
  assert.deepEqual(parseObjectKeys(chainWindow(src)), ['url', 'q']);
});

test('DONE-TEST: A TRUNCATED PAYLOAD IS UNRESOLVED, NEVER PARTIALLY READ', () => {
  // The dangerous answer is the plausible one. Returning the keys found before the window
  // ran out marks the site checked and leaves the rest unexamined — the exact failure both
  // checks exist to remove, reintroduced inside the parser.
  assert.equal(parseObjectKeys('.insert({ a: 1, b: 2'), null);
  assert.deepEqual(parseObjectKeys('.insert({ a: 1, b: 2 })'), ['a', 'b']);
});

test('shorthand properties are keys, and a spread still is not', () => {
  assert.deepEqual(parseObjectKeys('.insert({ tenant_id, surface: s })'), ['tenant_id', 'surface']);
  assert.equal(parseObjectKeys('.insert({ ...row, surface: s })'), null);
});

test('the chain ends at the real statement end', () => {
  const src = `.select('a').eq('b', 1); const other = 2;`;
  assert.equal(chainWindow(src).includes('const other'), false);
});

test('every write in src/ that resolves, resolves completely', () => {
  // A regression guard on the whole tree rather than a fixture: if a payload starts
  // parsing to a truncated key list again, the count moves and this fails.
  const chains = chainsFromSource('src');
  const resolved = chains.flatMap((c) => c.writes).filter((w) => w.keys !== null);
  assert.ok(resolved.length >= 30, `expected the runtime's writes, found ${resolved.length}`);
  const ledger = chains.find((c) => c.table === 'spend_ledger' && c.writes.length > 0);
  assert.ok(ledger?.writes[0]?.keys?.includes('cost_nanousd'),
    `the ledger insert must resolve past its comment: ${JSON.stringify(ledger?.writes[0]?.keys)}`);
});

test('DONE-TEST: THE PUBLISH COMMAND IS INSIDE THE CHECKED SET', () => {
  // scripts/publish/tenant.ts is the only thing outside src/ that speaks PostgREST to the
  // REAL project. A select there naming a column the database does not have fails at an
  // operator's shell in the middle of a publish — the same failure the runtime's checks
  // exist to prevent, in the one other place that reaches production data.
  assert.ok(CHECKED_ROOTS.includes('scripts/publish'), 'the publish command must be checked');
  const chains = chainsFromSource(CHECKED_ROOTS);
  const publish = chains.filter((c) => c.file.includes('scripts/publish/'));
  assert.ok(publish.length >= 3, `expected the publish command's queries, found ${publish.length}`);
  assert.ok(publish.some((c) => c.table === 'config_revisions'),
    'the draft-revision insert must be among them — it is the one write this command makes by hand');
  for (const w of publish.flatMap((c) => c.writes)) {
    assert.notEqual(w.keys, null, `an unresolvable payload in the publish command: ${JSON.stringify(w)}`);
  }
});

test('and the verify scripts are NOT — they are psql, not PostgREST', () => {
  // Widening the set to all of scripts/ would drag in every fixture and stub in the
  // repository and report columns that no transport ever sees. The narrowness is the point.
  const roots: readonly string[] = CHECKED_ROOTS;
  assert.equal(roots.includes('scripts'), false);
  assert.equal(roots.includes('scripts/verify'), false);
});
