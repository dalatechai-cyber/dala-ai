import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECRET_KINDS } from './tenantSecret.ts';

/**
 * The list of secret kinds existed in THREE places and they disagreed.
 *
 * `0032` widened the database CHECK to admit `web_mint_secret`. The TypeScript union was
 * widened afterwards, when `tsc` refused a call that named it. `scripts/kek/seal.ts` kept a
 * third copy that neither change reached — so the database accepted a kind, the runtime
 * could name it, and the one command that actually puts such a row in the database refused
 * it. Nothing was red: no test drives the seal CLI's argument validation, because sealing
 * needs a real KEK and a real secret.
 *
 * The code has one copy now. This asserts the remaining pair agree, by reading the CHECK
 * out of the migration rather than transcribing it — a transcribed constraint is a fourth
 * copy wearing a test's clothes, which is why `replay.test.ts` reads its unique indexes out
 * of `0001` instead of restating them.
 */

/** Every quoted literal inside `tenant_secrets_kind_check`, as the migration declares it. */
function kindsInMigration(): string[] {
  const sql = readFileSync(new URL('../../../supabase/migrations/0032_web_mint_secret_kind.sql', import.meta.url), 'utf8');

  // The `add constraint` statement only — the file also DROPS the old constraint, and a
  // pattern loose enough to match both would read the wrong one half the time.
  const start = sql.indexOf('add constraint tenant_secrets_kind_check');
  assert.notEqual(start, -1, '0032 no longer adds tenant_secrets_kind_check under that name');
  const end = sql.indexOf(';', start);
  assert.notEqual(end, -1, 'the add-constraint statement is not terminated');
  const statement = sql.slice(start, end);

  // Comments first: `0032` explains `web_mint_secret` in a comment that names OTHER kinds,
  // and counting those would make this pass for the wrong reason.
  const withoutComments = statement.replace(/--[^\n]*/g, '');

  // ascii-safe: a SQL identifier list this repository wrote, never customer text.
  const found = [...withoutComments.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
  assert.ok(found.length > 0, 'parsed no kinds out of the CHECK — the shape changed, so this check cannot complete');
  return found;
}

test('DONE-TEST: the code list and the database CHECK name exactly the same kinds', () => {
  assert.deepEqual([...SECRET_KINDS].sort(), kindsInMigration().sort());
});

test('web_mint_secret is in both, which is the drift that motivated this', () => {
  assert.ok(SECRET_KINDS.includes('web_mint_secret'));
  assert.ok(kindsInMigration().includes('web_mint_secret'));
});

test('the seal CLI validates against the shared list rather than its own copy', () => {
  // The bug was not that seal.ts had the wrong kinds — it was that it had ANY kinds. A
  // literal array here is a copy that drifts; the import is the fix, so the import is what
  // is asserted.
  const seal = readFileSync(new URL('../../../scripts/kek/seal.ts', import.meta.url), 'utf8');
  assert.match(seal, /import \{ SECRET_KINDS \}/, 'seal.ts no longer imports the shared list');
  assert.equal(
    /const KINDS = \[/.test(seal),
    false,
    'seal.ts has grown its own kind list again — that is the exact defect this pins',
  );
});
