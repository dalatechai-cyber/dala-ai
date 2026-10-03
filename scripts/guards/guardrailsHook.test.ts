import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The committed Claude Code guardrail hook (.claude/hooks/guardrails.cjs) has
// its own tests next to it; run them as part of `npm test` so a change that
// weakens the hook fails CI.
test('the guardrail hook asks before risky actions and refuses the blocked number', () => {
  const r = spawnSync(process.execPath, ['--test', '.claude/hooks/guardrails.test.cjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
