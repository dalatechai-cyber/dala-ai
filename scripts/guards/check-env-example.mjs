#!/usr/bin/env node
// GUARD: .env.example is the contract for what the platform reads.
//
// Both directions, because each catches a different real failure:
//   1. Code reads a name that .env.example does not document -> a deploy that boots and
//      then fails at the first webhook, with a message nobody can act on.
//   2. .env.example documents a name no code reads -> a secret provisioned, rotated and
//      worried about forever for no reason. Dead entries also hide live ones.
import fs from 'node:fs';
import { walk, stripComments, fail } from './_walk.mjs';

const EXAMPLE = '.env.example';
const problems = [];

if (!fs.existsSync(EXAMPLE)) {
  fail('check-env-example', [`${EXAMPLE} is missing.`]);
}

const exampleSrc = fs.readFileSync(EXAMPLE, 'utf8');
// Documented = uncommented assignments, plus commented ones in the Optional block.
const documented = new Set();
// A name may be documented before it is wired, but only with an explicit
// `# pending: <track>` marker on the same line. That keeps the not-yet-used set
// countable and forces whoever wires it to delete the marker.
const pending = new Set();
for (const line of exampleSrc.split('\n')) {
  const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
  if (!m) continue;
  documented.add(m[1]);
  if (/#\s*pending:/.test(line)) pending.add(m[1]);
}

// Names Next.js / Node / Vercel provide themselves.
const AMBIENT = new Set(['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_REGION', 'CI', 'PORT', 'npm_package_version']);

const read = new Map();
for (const file of walk('src')) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  // Two access shapes, and the guard must know both or it reports confident nonsense:
  //   1. process.env.NAME             — direct
  //   2. required('NAME') and friends — this codebase's fail-closed accessors in
  //      src/lib/env.ts, which is how nearly every real read happens.
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g,
    /\b(?:required|requiredJsonMap|secretSet)\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      if (!name || AMBIENT.has(name)) continue;
      if (!read.has(name)) read.set(name, `${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
}

// A third shape the first two cannot see: a name BUILT from a template literal, as
// src/lib/crypto/kek.ts does for `TENANT_KEK_V${version}` — one accessor covering a whole
// family of variables, because a KEK rotation needs V1 and V2 live at once. The literal
// name exists nowhere, so both directions of this guard were blind to it: the read went
// unnoticed, and every variable in the family looked documented-but-unread.
//
// It matches the template literal wherever it appears rather than only inside a
// `required(` call, because the name is usually built one line before it is used (it is
// also wanted for the error message). That is deliberately looser than the other two
// patterns, and the looseness is bounded three ways: the prefix must be SCREAMING_SNAKE,
// it must be at least MIN_PREFIX characters, and every prefix found is printed in the
// summary line — so a prefix that starts excusing variables it should not is visible on
// every run rather than silently widening the guard.
const TEMPLATE_NAME = /`([A-Z][A-Z0-9_]{3,})\$\{/g;
const MIN_PREFIX = 4;
const prefixes = new Map();
for (const file of walk('src')) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const re = new RegExp(TEMPLATE_NAME.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const prefix = m[1];
    if (prefix.length < MIN_PREFIX) {
      problems.push(`${file} builds an env name from a template literal with a prefix shorter than ${MIN_PREFIX} characters (\`${prefix}\`), which this guard cannot check. Give it a real prefix or read the name literally.`);
      continue;
    }
    if (!prefixes.has(prefix)) prefixes.set(prefix, `${file}:${src.slice(0, m.index).split('\n').length}`);
  }
}
const matchedPrefix = (name) => [...prefixes.keys()].find((p) => name.startsWith(p) && name !== p);

for (const [name, where] of read) {
  if (!documented.has(name)) {
    problems.push(`${where} reads process.env.${name}, which ${EXAMPLE} does not document.`);
  }
}
for (const name of documented) {
  const viaPrefix = matchedPrefix(name);
  if (read.has(name) || viaPrefix) {
    if (viaPrefix && !read.has(name)) {
      if (pending.has(name)) {
        problems.push(
          `${EXAMPLE} still marks ${name} as \`# pending:\`, but ${prefixes.get(viaPrefix)} builds that name from \`${viaPrefix}\` and reads it. ` +
          `Delete the pending marker — it exists to shrink, not to linger.`);
      }
      continue;
    }
    if (pending.has(name)) {
      problems.push(
        `${EXAMPLE} still marks ${name} as \`# pending:\`, but ${read.get(name)} now reads it. ` +
        `Delete the pending marker — it exists to shrink, not to linger.`);
    }
    continue;
  }
  if (pending.has(name)) continue;  // documented, unread, and honestly declared as future work
  problems.push(
    `${EXAMPLE} documents ${name}, which no code under src/ reads. Either use it, delete it, ` +
    `or mark it \`# pending: <which track wires it>\` so the debt is visible and countable.`);
}

const stale = [...pending].filter((n) => !documented.has(n));
if (stale.length) problems.push(`${EXAMPLE} marks unknown name(s) pending: ${stale.join(', ')}`);
console.log(`  (${read.size} read, ${prefixes.size} computed prefix(es): ${[...prefixes.keys()].join(', ') || 'none'}, ${pending.size} declared pending, ${documented.size} documented)`);

fail('check-env-example', problems);
