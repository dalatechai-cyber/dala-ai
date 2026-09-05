#!/usr/bin/env node
// GUARD: no locale-sensitive comparison in `src/`.
//
// D-026. The compiled prefix's line order reaches `content_hash`, which is the
// prompt-cache key. `localeCompare` sorts by the runtime's locale, so the same rows would
// order differently on two machines — the same defect that made SQL `order by` unusable
// here, arriving from the other direction.
//
// It is worth a guard rather than a code review because the failure is silent and remote:
// nothing errors, no test fails on the machine that wrote it, and the symptom is a cache
// that stops hitting and a bill that roughly triples. `byCodePoint` in `src/lib/mn/text.ts`
// is the intended comparator and takes no locale.
//
// Scope is `src/` only. A script that formats output for a human may sort however reads
// best; this is about anything that can reach a prompt.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './_walk.mjs';

const ROOT = 'src';
const problems = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // One deliberate exemption, spelled out rather than inferred: the test that PROVES
      // byCodePoint disagrees with localeCompare has to call localeCompare to compare
      // them. It must say so on the line or the one above, so an exemption is always a
      // sentence somebody wrote and never a filename that happened to match.
      // A CALL, not a mention. `localeCompare` appears legitimately in prose — this
      // file's own rationale, a test's title — and flagging the word rather than the
      // invocation makes the guard something people route around instead of read.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      const exempt = /guard-ok:locale/.test(line) || /guard-ok:locale/.test(lines[i - 1] ?? '');
      if (line.includes('.localeCompare(') && !exempt) {
        problems.push(
          `${full}:${i + 1} uses localeCompare. Ordering that can reach the compiled prompt ` +
          `must not depend on the runtime's locale (D-026) — use byCodePoint from lib/mn/text.ts.`,
        );
      }
    });
  }
}

if (!fs.existsSync(ROOT)) fail('check-deterministic-order', [`${ROOT} does not exist`]);
walk(ROOT);
fail('check-deterministic-order', problems);
