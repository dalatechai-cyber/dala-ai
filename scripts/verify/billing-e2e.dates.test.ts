// ONE CLOCK (NOTES.md, 2026-10-04): billing-e2e.ts must not name a calendar date in its code.
// A fixed date beside the wall clock is how `verify` went red on 2026-10-04 (#288) and would have
// on 2026-11-01; every date there is placed relative to today. Comments may quote history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('billing-e2e.ts names no calendar date outside its comments', () => {
  const src = readFileSync('scripts/verify/billing-e2e.ts', 'utf8');
  const code = src.split('\n').map((line, i) => ({ n: i + 1, text: line.replace(/^\s*(\*|\/\/|\/\*\*).*$/u, '').replace(/\s\/\/\s.*$/u, '') }));
  const dated = code.filter((l) => /\b20\d\d-[01]\d(-[0-3]\d)?\b|\b20\d\d\.[01]\d\.[0-3]\d\b|\b20\d\d[01]\d-\d{4}\b/u.test(l.text));
  assert.deepEqual(dated.map((l) => `${l.n}: ${l.text.trim()}`), []);
});
