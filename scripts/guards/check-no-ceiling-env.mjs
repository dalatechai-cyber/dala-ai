#!/usr/bin/env node
// GUARD: ceilings are NEVER environment variables. (09-reconciliation.md; CLAUDE.md rule 2.)
//
// An env var is editable in a dashboard by one person in ten seconds with no review, no
// audit trail and no second pair of eyes. A spend ceiling that can move that way is not a
// ceiling. Ceilings live in exactly two places: config/platform.ts (compiled, commit-gated,
// approver named in the message) and tenant_budgets (append-only, and can only ever LOWER
// the compiled cap).
import fs from 'node:fs';
import { walk, stripComments, fail } from './_walk.mjs';

const BANNED_NAME = /CEILING|BUDGET|LIMIT|CAP_USD|MAX_SPEND/i;
// Per-tenant DATA that must come from the database, never from the platform environment.
const BANNED_EXACT = new Set([
  'PAGE_ACCESS_TOKEN', 'FACEBOOK_PAGE_ID', 'MESSENGER_VERIFY_TOKEN',
  'ALLOWED_ORIGINS', 'LOG_WEBHOOK_URL', 'ANTHROPIC_MODEL', 'DEFAULT_TENANT',
]);

const problems = [];
for (const file of walk('src')) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const re = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] || m[2];
    const line = src.slice(0, m.index).split('\n').length;
    if (BANNED_NAME.test(name)) {
      problems.push(
        `${file}:${line} reads process.env.${name} — a ceiling may not be an env var. ` +
        `Put it in config/platform.ts (commit-gated) or tenant_budgets (append-only).`);
    }
    if (BANNED_EXACT.has(name)) {
      problems.push(
        `${file}:${line} reads process.env.${name} — that is per-tenant DATA, not platform ` +
        `configuration. Read it from the database, scoped to the resolved tenant.`);
    }
  }
  // The ancestor's exact defect: a credential fallback to a platform-wide token.
  if (/\|\|\s*process\.env\.[A-Z_]*(TOKEN|SECRET|KEY)/.test(src)) {
    problems.push(
      `${file} falls back to a platform env credential with ||. That is the ancestor's ` +
      `|| process.env.PAGE_ACCESS_TOKEN defect: on a warm lambda it posts as the wrong tenant.`);
  }
  if (/\?\?\s*['"]?DEFAULT_TENANT/.test(src) || /\bDEFAULT_TENANT\b/.test(src)) {
    problems.push(`${file} references DEFAULT_TENANT. There is no default tenant, not even in dev.`);
  }
}

fail('check-no-ceiling-env', problems);
