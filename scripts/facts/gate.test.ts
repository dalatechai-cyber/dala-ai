import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLinesOnly, externalPaths } from './gate.ts';

test('comment lines are notes, not copies: only code lines are checked', () => {
  assert.equal(codeLinesOnly(" * \"Дали 150,000₮/сар\" is caught\n  line: 'Дали 250,000₮',\n// Дали 1₮"), "  line: 'Дали 250,000₮',");
});

test('the config is readable and names only relative sibling paths', () => {
  for (const p of externalPaths('dalatech')) assert.match(p, /^\.\.\//u);
  assert.deepEqual(externalPaths('no-such-tenant'), []);
});
