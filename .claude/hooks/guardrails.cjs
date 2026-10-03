#!/usr/bin/env node
'use strict';

/**
 * DalaTech guardrails — a Claude Code PreToolUse hook, committed so cloud
 * sessions follow it too (wired in .claude/settings.json).
 *
 * ASK (a person confirms) before:
 *   - `supabase db push`, `supabase db reset` against a linked/remote database,
 *     and the Supabase MCP's apply_migration / merge_branch / execute_sql that
 *     changes data or schema;
 *   - `npm audit fix --force` (or `-f`);
 *   - merging into, or pushing to, main/master (git push/merge, `gh pr merge`,
 *     the GitHub MCP's merge_pull_request, MCP file writes on main);
 *   - Vercel Production changes: `vercel env add|rm|update … production`,
 *     `vercel --prod`, `vercel promote|rollback|redeploy`, `vercel alias set|rm`,
 *     and the Vercel MCP's alias / promote / rollback calls and env /
 *     deployment calls that target production.
 * DENY:
 *   - writing the blocked number (FORBIDDEN_NUMBER below) into any file (Write,
 *     Edit, MultiEdit, NotebookEdit, MCP file/doc writes, or a shell command
 *     that writes).
 *
 * Shell commands are split into simple commands and words the way a shell
 * would (quotes, `;`, `&&`, `||`, `|`, `cd`, `bash -c`), so a commit message
 * that merely mentions "push to main" is not a push.
 *
 * Reads the hook's JSON on stdin; prints a decision only when a rule fires.
 * A hook that cannot parse its input lets the call through (it must never
 * block ordinary work by crashing) — the rules are a safety net, not the
 * only control.
 */

const { execFileSync } = require('child_process');
const path = require('path');

// Built from parts so this file never contains the number it blocks (and can
// still be edited under its own rule). Matched in any spelling: digits split
// by up to three spaces, dashes, dots, brackets or slashes, never inside a
// longer number — the same rule as dala-ai's
// scripts/guards/check-no-banned-number.mjs.
const FORBIDDEN_NUMBER = ['9927', '3339'].join('');
const SEP = '[\\s\\u00a0\\-\\u2010-\\u2015.()/_]{0,3}';
const FORBIDDEN_RUN = new RegExp(`(?<![0-9])${FORBIDDEN_NUMBER.split('').join(SEP)}(?![0-9])`, 'u');
const hasForbidden = (text) => FORBIDDEN_RUN.test(String(text).normalize('NFC'));
const IS_MAIN = /^(?:main|master)$/;

function decide(decision, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `DalaTech guardrail: ${reason}` } };
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch (_) {
    return null;
  }
}

/** Every string inside a value (tool inputs nest: edits[], files[], …). */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

// ── A small shell reader ────────────────────────────────────────────────
/**
 * Split a command line into simple commands, each a list of words with quotes
 * removed. Operators (; && || | & and newlines) separate commands; redirections
 * stay as words. Good enough for the rules below; not a full shell.
 */
function simpleCommands(line) {
  const commands = [];
  let words = [];
  let word = null;
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const s = String(line || '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      word = (word || '') + s.slice(i + 1, j === -1 ? s.length : j);
      i = j === -1 ? s.length : j;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { text += s[j + 1]; j += 2; } else { text += s[j]; j += 1; }
      }
      word = (word || '') + text;
      i = j;
    } else if (c === '\\' && i + 1 < s.length) {
      word = (word || '') + s[i + 1];
      i += 1;
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && s[i + 1] === '>') { endWord(); words.push('&>'); i += 1; continue; }
      if (c === '&' && /[<>]/.test(s[i - 1] || '')) { word = (word || '') + c; continue; }
      endCommand();
      if ((c === '|' || c === '&') && s[i + 1] === c) i += 1;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word || '') + c;
    }
  }
  endCommand();
  return commands;
}

const LAUNCHERS = new Set(['sudo', 'npx', 'bunx', 'pnpx', 'env', 'command', 'exec', 'time', 'nohup']);

/** The program a simple command runs (launchers and VAR=x skipped), and its arguments. */
function programOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    if (LAUNCHERS.has(path.basename(w))) { i += 1; while (i < words.length && /^-/.test(words[i])) i += 1; continue; }
    if (/^(?:pnpm|yarn|npm)$/.test(w) && /^(?:dlx|exec)$/.test(words[i + 1] || '')) { i += 2; while (i < words.length && /^-/.test(words[i])) i += 1; continue; }
    break;
  }
  if (i >= words.length) return { program: '', args: [] };
  const program = path.basename(words[i]).replace(/@[^/]*$/, '');
  return { program, args: words.slice(i + 1) };
}

/** git's subcommand, skipping git's own options (-C dir, -c k=v, --git-dir=…). */
function gitSubcommand(args, cwd) {
  let dir = cwd;
  let i = 0;
  while (i < args.length && /^-/.test(args[i])) {
    if (args[i] === '-C') { dir = path.resolve(dir || process.cwd(), args[i + 1] || '.'); i += 2; continue; }
    if (args[i] === '-c' || args[i] === '--git-dir' || args[i] === '--work-tree' || args[i] === '--namespace') { i += 2; continue; }
    i += 1;
  }
  return { sub: args[i] || '', rest: args.slice(i + 1), dir };
}

/** Where a git push lands: does any destination name main/master? */
function pushTargetsMain(rest, dir) {
  if (rest.some((a) => a === '--all' || a === '--mirror')) return true;
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (/^--(?:repo|receive-pack|exec|push-option|signed)$/.test(a) || a === '-o') { i += 1; continue; }
    if (/^-/.test(a)) continue;
    positional.push(a);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return IS_MAIN.test(currentBranch(dir) || '');
  return refspecs.some((spec) => {
    const s = spec.replace(/^\+/, '');
    const dest = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
    const name = dest.replace(/^refs\/heads\//, '');
    if (name === 'HEAD' || name === '@') return IS_MAIN.test(currentBranch(dir) || '');
    return IS_MAIN.test(name);
  });
}

// Shell writes. Redirections are looked for outside quotes only, and
// `>/dev/null`, `2>&1` do not write a file.
const WRITES_IN_SHELL = /\btee\b|\bsed\b[^|;&]*\s-[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i|\bdd\b[^|;&]*\bof=|writeFile|appendFile|write_text|write_bytes|\.write\(|\bopen\([^)]*['"][wa]/;
function redirectsToFile(cmd) {
  const unquoted = String(cmd).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
  const cleaned = unquoted.replace(/[0-9&]?>>?\s*\/dev\/null\b/g, ' ').replace(/[0-9]*>&[0-9-]+/g, ' ');
  return /(^|[^<0-9-])>{1,2}|(^|\s)[0-9]>{1,2}/.test(cleaned);
}

const SQL_CHANGES = /\b(?:create|alter|drop|truncate|grant|revoke|insert|update|delete|merge|comment\s+on|vacuum|reindex)\b/i;

function checkSimpleCommand(words, state) {
  const { program, args } = programOf(words);
  if (!program) return null;
  if (program === 'cd') {
    state.cwd = path.resolve(state.cwd || process.cwd(), args[0] || process.env.HOME || '.');
    return null;
  }
  if (/^(?:bash|sh|zsh|dash)$/.test(program)) {
    const c = args.indexOf('-c');
    if (c !== -1 && args[c + 1]) return checkShell(args[c + 1], state);
    return null;
  }
  if (program === 'eval') return checkShell(args.join(' '), state);
  if (program === 'supabase') {
    const db = args.indexOf('db');
    const verb = db === -1 ? '' : args.slice(db + 1).find((a) => !/^-/.test(a)) || '';
    if (verb === 'push') return decide('ask', '`supabase db push` changes the database. Confirm before it runs.');
    if (verb === 'reset' && args.some((a) => /^--(?:linked|db-url)(?:=|$)/.test(a))) {
      return decide('ask', '`supabase db reset` against a remote database wipes it. Confirm before it runs.');
    }
    return null;
  }
  if (program === 'npm' && args[0] === 'audit' && args.includes('fix') && args.some((a) => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) {
    return decide('ask', '`npm audit fix --force` can install breaking major versions. Confirm before it runs.');
  }
  if (program === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
    return decide('ask', 'merging a pull request. Confirm before it runs.');
  }
  if (program === 'git') {
    const { sub, rest, dir } = gitSubcommand(args, state.cwd);
    if (sub === 'push' && pushTargetsMain(rest, dir)) {
      return decide('ask', 'pushing to main/master. Confirm before it runs.');
    }
    if ((sub === 'checkout' || sub === 'switch') && !rest.some((a) => /^-[bBcC]$|^--orphan$|^--$/.test(a))
      && IS_MAIN.test(rest.find((a) => !/^-/.test(a)) || '')) state.switchedToMain = true;
    if (sub === 'merge' && (state.switchedToMain || IS_MAIN.test(currentBranch(dir) || ''))) {
      return decide('ask', 'merging into main/master. Confirm before it runs.');
    }
    return null;
  }
  if (program === 'vercel') {
    const positional = args.filter((a) => !/^-/.test(a));
    const prod = args.some((a) => a === '--prod' || a === '--production' || /^--target=production$/.test(a))
      || args.some((a, i) => a === '--target' && args[i + 1] === 'production');
    const envChange = positional[0] === 'env' && /^(?:add|rm|remove|update)$/.test(positional[1] || '') && args.includes('production');
    const live = /^(?:promote|rollback|redeploy)$/.test(positional[0] || '');
    const alias = positional[0] === 'alias' && (/^(?:set|rm|remove)$/.test(positional[1] || '') || positional.length >= 3);
    if (prod || envChange || live || alias) return decide('ask', 'a Vercel Production change. Confirm before it runs.');
  }
  return null;
}

function checkShell(cmd, state) {
  for (const words of simpleCommands(cmd)) {
    const result = checkSimpleCommand(words, state);
    if (result) return result;
  }
  return null;
}

function checkBash(command, cwd) {
  const cmd = String(command || '');
  if (hasForbidden(cmd) && (WRITES_IN_SHELL.test(cmd) || redirectsToFile(cmd))) {
    return decide('deny', 'writing the blocked number into a file is not allowed.');
  }
  return checkShell(cmd, { cwd: cwd || process.cwd(), switchedToMain: false });
}

function targetsProduction(input) {
  return strings(input).some((s) => /^production$/i.test(s));
}

const MCP_WRITES = /(create_or_update_file|push_files|write|upload|update_doc|update_file|create_file|create_draft|update_draft|__update$|__batch$|__create$)/i;

function checkMcp(tool, input) {
  if (MCP_WRITES.test(tool) && strings(input).some(hasForbidden)) {
    return decide('deny', 'writing the blocked number into a file is not allowed.');
  }
  if (/^mcp__github__merge_pull_request$|^mcp__github__enable_pr_auto_merge$/.test(tool)) {
    return decide('ask', 'merging a pull request. Confirm before it runs.');
  }
  if (/^mcp__github__(create_or_update_file|push_files|delete_file)$/.test(tool)
    && IS_MAIN.test(String((input && input.branch) || '').replace(/^refs\/heads\//, ''))) {
    return decide('ask', 'writing to main/master on GitHub. Confirm before it runs.');
  }
  if (/^mcp__supabase__(apply_migration|merge_branch)$/.test(tool)) {
    return decide('ask', 'a database migration (the MCP form of `supabase db push`). Confirm before it runs.');
  }
  if (tool === 'mcp__supabase__execute_sql' && SQL_CHANGES.test(String((input && input.query) || ''))) {
    return decide('ask', 'SQL that changes data or schema. Confirm before it runs.');
  }
  if (/^mcp__[Vv]ercel__(request_promote|request_rollback|promote|rollback|assign_alias)/.test(tool)) {
    return decide('ask', 'a Vercel Production change. Confirm before it runs.');
  }
  if (/^mcp__[Vv]ercel__(create_project_env|edit_project_env|update_shared_env_variable|delete_project_env|create_deployment)$/.test(tool) && targetsProduction(input)) {
    return decide('ask', 'a Vercel Production change. Confirm before it runs.');
  }
  return null;
}

function checkFileWrite(tool, input) {
  // Only what would be written counts: removing the number (old_string) is fine.
  const { file_path: _f, notebook_path: _n, old_string: _o, edits, ...rest } = input;
  const written = strings(rest);
  if (Array.isArray(edits)) edits.forEach((e) => written.push(String((e && e.new_string) || '')));
  if (written.some(hasForbidden)) {
    return decide('deny', 'writing the blocked number into a file is not allowed.');
  }
  return null;
}

function evaluate(event) {
  const tool = String((event && event.tool_name) || '');
  const input = (event && event.tool_input) || {};
  if (tool === 'Bash') return checkBash(input.command, event.cwd);
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return checkFileWrite(tool, input);
  if (tool.startsWith('mcp__')) return checkMcp(tool, input);
  return null;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let result = null;
    try { result = evaluate(JSON.parse(raw)); } catch (_) { process.exit(0); }
    if (result) process.stdout.write(JSON.stringify(result));
    process.exit(0);
  });
}

module.exports = { evaluate, hasForbidden, simpleCommands };
