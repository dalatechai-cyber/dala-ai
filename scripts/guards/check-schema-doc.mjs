#!/usr/bin/env node
// GUARD: `docs/schema.md` names every migration that exists.
//
// CLAUDE.md points at that file as **the schema** — "beats every section file's DDL" — so
// somebody writing INSERTs by hand reads it and trusts it. When this guard was written it
// documented `0001` and `0002` and had never heard of the ten migrations after them,
// including `0011`, which adds a NOT NULL column with NO DEFAULT to five tables. Following
// the document would have produced INSERTs the database refuses.
//
// That is the same defect as `supabase_migrations.schema_migrations` holding one row from
// April: a source that answers plausibly instead of admitting it cannot see. The fix for
// the instance is an edit; the fix for the CLASS is that the drift cannot happen quietly
// again, which is this file.
//
// It checks NAMING, not correctness. A migration mentioned with a wrong description still
// passes — no static check can read SQL and judge prose. What it makes impossible is the
// silent case: a migration that the document does not know exists at all.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './_walk.mjs';

const MIGRATIONS = 'supabase/migrations';
const DOC = 'docs/schema.md';
const problems = [];

if (!fs.existsSync(MIGRATIONS)) fail('check-schema-doc', [`${MIGRATIONS} does not exist`]);
if (!fs.existsSync(DOC)) fail('check-schema-doc', [`${DOC} does not exist`]);

const doc = fs.readFileSync(DOC, 'utf8');
const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

if (files.length === 0) problems.push(`no migrations found in ${MIGRATIONS}`);

for (const file of files) {
  const stem = file.replace(/\.sql$/, '');       // 0011_provenance
  const number = stem.slice(0, 4);               // 0011
  // Either the full stem (`0011_provenance`) or the bare number in backticks. The range
  // form `0001`–`0012` in the status table counts for the endpoints only, deliberately:
  // a range is a claim about applying cleanly, not a description of what each one adds.
  if (doc.includes(stem)) continue;
  problems.push(
    `${file} is not named in ${DOC}. A schema document that does not know a migration ` +
    `exists is worse than no document: it is read as authoritative. Add a row to ` +
    `"What every migration after 0001 adds" saying what it changes for someone writing ` +
    `INSERTs by hand.`,
  );
  void number;
}

// The reverse direction: a row for a migration that no longer exists means somebody
// renamed or removed one and left the description behind, which reads as current.
for (const m of doc.matchAll(/`?(\d{4}_[a-z0-9_]+)`?/g)) {
  const named = m[1];
  if (!files.includes(`${named}.sql`)) {
    problems.push(`${DOC} describes ${named}, which is not in ${MIGRATIONS}`);
  }
}

fail('check-schema-doc', problems);
