'use strict';

/**
 * The DalaTech guardrail hook (.claude/hooks/guardrails.cjs), run the way
 * Claude Code runs it: JSON on stdin, a decision (or nothing) on stdout.
 * Run: node --test .claude/hooks/guardrails.test.cjs
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'guardrails.cjs');
const N = ['9927', '3339'].join(''); // never written literally, so this file passes its own rule

function run(event) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout) return 'allow';
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.match(out.permissionDecisionReason, /^DalaTech guardrail: /);
  return out.permissionDecision;
}

// A scratch git repository whose current branch we choose.
function repoOn(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  return dir;
}
const bash = (command, cwd) => run({ tool_name: 'Bash', tool_input: { command }, cwd: cwd || os.tmpdir() });

test('supabase db push and npm audit fix --force ask first', () => {
  assert.equal(bash('supabase db push'), 'ask');
  assert.equal(bash('npx supabase --debug db push --linked'), 'ask');
  assert.equal(bash('npm audit fix --force'), 'ask');
  assert.equal(bash('npm audit fix'), 'allow');
  assert.equal(bash('supabase db diff'), 'allow');
});

test('pushing to main/master asks; other branches do not', () => {
  const feature = repoOn('claude/feature');
  const main = repoOn('main');
  assert.equal(bash('git push origin main', feature), 'ask');
  assert.equal(bash('git push -u origin HEAD:main', feature), 'ask');
  assert.equal(bash('git push origin +master', feature), 'ask');
  assert.equal(bash('git push origin refs/heads/main', feature), 'ask');
  assert.equal(bash('git push --all origin', feature), 'ask');
  assert.equal(bash('git push', main), 'ask', 'a bare push while on main');
  assert.equal(bash('git push origin HEAD', main), 'ask');
  assert.equal(bash('git push -u origin claude/feature', feature), 'allow');
  assert.equal(bash('git push', feature), 'allow');
  assert.equal(bash('git push origin claude/main-menu-fix', feature), 'allow', 'a branch merely containing "main"');
});

test('merging into main asks', () => {
  const feature = repoOn('claude/feature');
  const main = repoOn('main');
  assert.equal(bash('gh pr merge 83 --squash'), 'ask');
  assert.equal(bash('git merge claude/feature', main), 'ask');
  assert.equal(bash('git checkout main && git merge claude/feature', feature), 'ask');
  assert.equal(bash('git merge origin/main', feature), 'allow', 'bringing main into a feature branch is fine');
  assert.equal(bash('git merge-base HEAD origin/main', main), 'allow');
  assert.equal(run({ tool_name: 'mcp__github__merge_pull_request', tool_input: { owner: 'o', repo: 'r', pullNumber: 1 } }), 'ask');
  assert.equal(run({ tool_name: 'mcp__github__create_or_update_file', tool_input: { branch: 'main', path: 'a', content: 'x' } }), 'ask');
  assert.equal(run({ tool_name: 'mcp__github__create_or_update_file', tool_input: { branch: 'claude/x', path: 'a', content: 'x' } }), 'allow');
});

test('Vercel Production changes ask; Preview does not', () => {
  assert.equal(bash('vercel env add QPAY_USERNAME production'), 'ask');
  assert.equal(bash('vercel env rm X production --yes'), 'ask');
  assert.equal(bash('vercel --prod'), 'ask');
  assert.equal(bash('vercel deploy --prod'), 'ask');
  assert.equal(bash('vercel promote dpl_123'), 'ask');
  assert.equal(bash('vercel env add X preview'), 'allow');
  assert.equal(bash('vercel env ls'), 'allow');
  const env = (target) => ({ tool_name: 'mcp__Vercel__create_project_env', tool_input: { idOrName: 'p', requestBody: { key: 'K', value: 'v', type: 'plain', target } } });
  assert.equal(run(env(['production'])), 'ask');
  assert.equal(run(env(['preview'])), 'allow');
  assert.equal(run({ tool_name: 'mcp__Vercel__request_promote', tool_input: {} }), 'ask');
  assert.equal(run({ tool_name: 'mcp__supabase__apply_migration', tool_input: { name: 'x', query: 'select 1' } }), 'ask');
  assert.equal(run({ tool_name: 'mcp__supabase__execute_sql', tool_input: { query: 'select 1' } }), 'allow');
});

test('the blocked number is never written into a file', () => {
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: `phone ${N}` } }), 'deny');
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a.txt', old_string: 'x', new_string: `call ${N}` } }), 'deny');
  assert.equal(run({ tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/a.txt', edits: [{ old_string: 'a', new_string: N }] } }), 'deny');
  assert.equal(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/a.ipynb', new_source: N } }), 'deny');
  assert.equal(bash(`echo ${N} > notes.txt`), 'deny');
  assert.equal(bash(`echo ${N} | tee -a notes.txt`), 'deny');
  assert.equal(bash(`sed -i 's/x/${N}/' notes.txt`), 'deny');
  assert.equal(run({ tool_name: 'mcp__github__create_or_update_file', tool_input: { branch: 'claude/x', path: 'a', content: N } }), 'deny');
  // Any spelling: spaced, dashed, dotted.
  for (const spelled of [`${N.slice(0, 4)} ${N.slice(4)}`, `${N.slice(0, 4)}-${N.slice(4)}`, N.split('').join('.')]) {
    assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: `утас ${spelled}` } }), 'deny', spelled);
  }
  // Inside a longer number it is a different number.
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: `id 1${N}5` } }), 'allow');
  // Removing it, or searching for it, is fine.
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a.txt', old_string: N, new_string: '' } }), 'allow');
  assert.equal(bash(`grep -rn ${N} .`), 'allow');
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: 'phone 76001888' } }), 'allow');
});

test('ordinary work passes, and unreadable input never blocks', () => {
  assert.equal(bash('npm test'), 'allow');
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }), 'allow');
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
