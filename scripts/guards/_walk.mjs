// Shared file walker for the guard scripts. No dependencies on purpose: a guard
// that needs an install is a guard that gets skipped.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'dist', 'build', '.vercel']);

export function walk(dir, exts = ['.ts', '.tsx', '.mjs', '.js']) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // and /* *​/ comments so a guard never fires on prose about the rule it enforces. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

export function fail(name, problems) {
  if (problems.length === 0) {
    console.log(`✓ ${name}`);
    return;
  }
  console.error(`✗ ${name} — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  process.exit(1);
}
