#!/usr/bin/env node
// GUARD: a Next.js route handler exporting only GET caches every Supabase read for a
// YEAR, and `export const dynamic = 'force-dynamic'` does NOT stop it. Only
// `cache: 'no-store'` does. (CLAUDE.md rule 8.) Next door this cost $12.43 and produced
// three cron runs that read `active: 0` from a populated table with HTTP 200 and
// error: null.
//
// This guard runs in BOTH directions, which is the point:
//   1. No module outside the shared client factory may construct a Supabase client.
//   2. The shared client factory must actually pin `cache: 'no-store'`.
// Direction 2 is what catches the regression where someone "cleans up" the custom fetch
// and every call site silently starts caching again.
import fs from 'node:fs';
import { walk, stripComments, fail } from './_walk.mjs';

const SHARED_FETCH = 'src/lib/supabase/fetch.ts';
const SHARED_DIR = 'src/lib/supabase/';
const problems = [];

// --- Direction 2: the shared factory must pin no-store -----------------------
if (!fs.existsSync(SHARED_FETCH)) {
  problems.push(`${SHARED_FETCH} is missing — the one place cache:'no-store' is set.`);
} else {
  const src = stripComments(fs.readFileSync(SHARED_FETCH, 'utf8'));
  if (!/cache\s*:\s*['"]no-store['"]/.test(src)) {
    problems.push(
      `${SHARED_FETCH} no longer sets cache:'no-store'. Every Supabase read in the app ` +
      `will be cached for a year, silently, returning stale rows with HTTP 200 and error: null.`);
  }
  if (/dynamic\s*=\s*['"]force-dynamic['"]/.test(src) && !/no-store/.test(src)) {
    problems.push(`${SHARED_FETCH} relies on force-dynamic, which does NOT disable fetch caching.`);
  }
}

// --- Direction 1: nobody else constructs a client ----------------------------
for (const file of walk('src')) {
  const rel = file.replace(/^\.\//, '');
  if (rel.startsWith(SHARED_DIR)) continue;
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  if (/\bcreateClient\s*\(/.test(src)) {
    problems.push(
      `${rel} constructs a Supabase client directly. Import from '@/lib/supabase/*' instead — ` +
      `a bare client does not carry cache:'no-store'.`);
  }
  // A TYPE-only import is fine: it erases at compile time and cannot construct a client.
  // What must not happen is a VALUE import, which can. `import type {...}` and the inline
  // `import { type X }` form are both allowed; anything else from that package is not.
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s*from\s+['"]@supabase\/supabase-js['"]/g)) {
    const clause = (m[1] ?? '').trim();
    const typeOnly =
      clause.startsWith('type ') ||
      (clause.startsWith('{') &&
        clause.slice(1, -1).split(',').every((s) => s.trim() === '' || s.trim().startsWith('type ')));
    if (!typeOnly) {
      problems.push(
        `${rel} value-imports @supabase/supabase-js. Only ${SHARED_DIR}* may do that — ` +
        `a bare client does not carry cache:'no-store'. (\`import type\` is allowed.)`);
    }
  }
}

fail('check-supabase-nostore', problems);
