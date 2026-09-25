#!/usr/bin/env node
// GUARD: every canned-response key a prompt block names actually exists.
//
// The gate's blocks end by telling the model to copy a specific pinned sentence — named
// by key, so that L0 stays byte-identical across tenants. A key that no `canned_responses`
// row can ever have is a check with no answer: at runtime the renderer finds nothing, and
// what a customer sees depends on what the model improvises in the gap.
//
// This is not hypothetical. It is how the check was written: the first draft of the ten
// blocks named nine keys, and only ONE of them was seeded. `canned_response_kinds` was
// written when the gate had six checks — Ш0 and Ш9 were added under review, Ш6 was
// promoted out of the abuse check, and Ш4/Ш5 were only ever described as "out of scope"
// in prose. Nothing connected the two documents, so the drift was invisible.
//
// Drafts are checked too, deliberately. Catching it at promotion time means catching it
// after a native speaker has already spent their attention on the wording.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './_walk.mjs';

const BLOCK_DIRS = ['prompt/platform', 'prompt/drafts'];
const MIGRATIONS = 'supabase/migrations';
const problems = [];

// The seeded kinds, read from the migrations rather than from a list kept in step by hand.
const seeded = new Set();
if (fs.existsSync(MIGRATIONS)) {
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    // Bounded by the NEXT statement, not by a semicolon.
    //
    // The first version of this guard ended the block at /[\s\S]*?;/ and read 8 of the 16
    // seeded kinds, because `('budget_exhausted_notice', 'Ceiling reached; hand off to the
    // phone')` puts a semicolon INSIDE a description string. It then reported six real
    // keys as unseeded. A guard that silently under-reads its own source produces false
    // failures here and would produce false passes in the mirror case.
    // ascii-safe: SQL identifiers and quoted kind literals are ASCII by construction.
    for (const segment of sql.split(/insert\s+into\s+/i).slice(1)) {
      if (!/^canned_response_kinds\b/i.test(segment)) continue;
      for (const m of segment.matchAll(/\(\s*'([a-z_]+)'\s*,/g)) seeded.add(m[1]);
    }
  }
}
if (seeded.size === 0) {
  problems.push(`No canned_response_kinds seed found under ${MIGRATIONS}. Either the seed moved or this guard stopped reading it — both make every check below vacuous.`);
}

const referenced = new Map();
for (const dir of BLOCK_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mn.txt')).sort()) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    // A key is a lower_snake token in ASCII double quotes. Mongolian prose uses «…»,
    // so the two never collide.
    for (const m of body.matchAll(/"([a-z][a-z_]*)"/g)) {
      const where = referenced.get(m[1]) ?? [];
      where.push(`${dir}/${file}`);
      referenced.set(m[1], where);
    }
  }
}

// Kinds the model never sees, mirrored from `MODEL_INVISIBLE_KINDS` in src/lib/gate/match.ts.
//
// A guard cannot import TypeScript, so the list is duplicated and then CHECKED against the
// original below — a copy that can go stale silently is the defect this whole file exists
// to catch, and writing one inside it would be the joke telling itself.
const INVISIBLE = ['image_received', 'comment_public_reply', 'handover_notice', 'handover_reclaim', 'clarify_branch'];
const MATCH_TS = 'src/lib/gate/match.ts';
if (fs.existsSync(MATCH_TS)) {
  const src = fs.readFileSync(MATCH_TS, 'utf8');
  const m = src.match(/MODEL_INVISIBLE_KINDS:\s*readonly string\[\]\s*=\s*\[([^\]]*)\]/);
  if (m === null) {
    problems.push(`Could not read MODEL_INVISIBLE_KINDS out of ${MATCH_TS}. It moved or was renamed, and this guard's copy of it is now unverifiable — which makes the check below vacuous rather than wrong.`);
  } else {
    // ascii-safe: a canned kind is a lower_snake ASCII token in straight single quotes.
    const actual = [...m[1].matchAll(/'([a-z][a-z_]*)'/g)].map((x) => x[1]).sort();
    if (actual.join(',') !== [...INVISIBLE].sort().join(',')) {
      problems.push(
        `MODEL_INVISIBLE_KINDS in ${MATCH_TS} is [${actual.join(', ')}], but this guard's copy is ` +
        `[${[...INVISIBLE].sort().join(', ')}]. Update the INVISIBLE list in this file to match.`);
    }
  }
}

for (const [key, files] of referenced) {
  if (INVISIBLE.includes(key)) {
    problems.push(
      `Prompt block names canned-response key "${key}", which is filtered OUT of the prompt.\n` +
      `      Referenced by: ${[...new Set(files)].join(', ')}\n` +
      `      "${key}" is served by the platform without ever calling the model (see\n` +
      `      MODEL_INVISIBLE_KINDS in ${MATCH_TS}), so it is deliberately absent from the\n` +
      `      compiled prefix. A block telling the model to copy it is an instruction pointing\n` +
      `      at a line the model cannot see — the gap D-058 left, with the model improvising\n` +
      `      into it. Either drop the reference, or stop filtering the kind.`);
    continue;
  }
  if (!seeded.has(key)) {
    problems.push(
      `Prompt block names canned-response key "${key}", which no migration seeds.\n` +
      `      Referenced by: ${[...new Set(files)].join(', ')}\n` +
      `      At runtime the renderer finds nothing and the customer gets whatever the model\n` +
      `      improvises in the gap. Add the kind to a migration, or use a seeded one:\n` +
      `      ${[...seeded].sort().join(', ')}`);
  }
}

fail('check-gate-keys', problems);
