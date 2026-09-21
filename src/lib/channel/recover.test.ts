import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CREDENTIAL_FAILURE_STATUS, RECOVERED_STATUS, clearCredentialFailure } from './recover.ts';

/** `rows` is what the conditional UPDATE matched — [] when the predicate excluded it. */
function stubDb(rows: unknown[] = [{ id: 'c-1' }], error: unknown = null) {
  const ops: { table: string; patch?: Record<string, unknown>; filters: string[] }[] = [];
  const from = (table: string) => {
    const rec = { table, filters: [] as string[] } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    chain['update'] = (patch: Record<string, unknown>) => { rec.patch = patch; return chain; };
    chain['eq'] = (...args: unknown[]) => {
      rec.filters.push(`eq(${args.map(String).join(',')})`);
      return chain;
    };
    chain['select'] = () => chain;
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: rows, error });
    return chain;
  };
  return { ops, db: { from } as never };
}

test('DONE-TEST: A SEND CLEARS ONLY THE CREDENTIAL FAILURE, AND ONLY status', async () => {
  // Founder's call, 2026-09-21: a successful send clears `tenant_channels.status`, nothing
  // else does. The half that needs asserting is what it must NOT do — `haltChannelOutbound`
  // writes three columns, and restoring `delivery_mode` here would be Dala AI moving itself
  // back toward live on the strength of its own traffic.
  const s = stubDb();
  const out = await clearCredentialFailure(s.db, { tenantId: 't-1', channelId: 'c-1' });

  assert.deepEqual(out, { ok: true, cleared: true });
  assert.equal(s.ops[0]?.table, 'tenant_channels');
  assert.deepEqual(s.ops[0]?.patch, { status: RECOVERED_STATUS },
    'ONE column. delivery_mode and token_status are the human`s to restore, never a send`s');
});

test('DONE-TEST: THE NARROWING IS IN THE PREDICATE, NOT IN A BRANCH', async () => {
  // The CHECK allows six statuses and three must never be cleared by traffic: `suspended`
  // is an operator decision, `offboarded` is a customer who left, and `pending`/`probing`
  // have their own provisioning gate. A send is evidence about the CREDENTIAL and nothing
  // else, so it may retire exactly the one status that records a credential fault.
  //
  // That restriction lives in the WHERE clause so the database matches no row in any other
  // state. An `if` one layer up would be a branch a future caller could delete while the
  // query happily moved `offboarded → active`.
  const s = stubDb();
  await clearCredentialFailure(s.db, { tenantId: 't-1', channelId: 'c-1' });
  assert.deepEqual(s.ops[0]?.filters, [
    'eq(id,c-1)', 'eq(tenant_id,t-1)', `eq(status,${CREDENTIAL_FAILURE_STATUS})`,
  ], 'the status predicate is what makes every other state unreachable from here');
});

test('the six allowed statuses are read from the migration, not remembered', () => {
  // Same discipline as `halt.test.ts`. If a migration ever adds a status, this test is
  // where somebody is forced to ask whether a send should be able to clear it.
  //
  // SCOPED TO THE TABLE, and the first version was not. `0001` carries FIVE
  // `check (status in (...))` constraints — tenants, tenant_channels, tenant_secrets,
  // roles and config_revisions — and an unscoped regex takes the first, which is
  // `tenants.status` and a completely different vocabulary. The test caught it on its
  // first run, which is the whole argument for reading the schema instead of typing what
  // you remember of it.
  const sql = readFileSync('supabase/migrations/0001_initial_schema.sql', 'utf8');
  // No \b: rule 6 forbids it and the guard caught it here on the first run. The bound it
  // was doing is done better by the literal that always follows the name in the DDL.
  const table = /create table[^;]*?tenant_channels\s*\([\s\S]*?\n\);/.exec(sql);
  assert.ok(table !== null, 'the tenant_channels table is no longer where this test looks');
  const m = /check \(status in \(([^)]*)\)\)/.exec(table[0]);
  assert.ok(m !== null, 'the status CHECK is no longer where this test looks for it');
  const allowed = (m[1] as string).split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(allowed,
    ['pending', 'probing', 'active', 'authorization_error', 'suspended', 'offboarded']);
  assert.ok(allowed.includes(CREDENTIAL_FAILURE_STATUS));
  assert.ok(allowed.includes(RECOVERED_STATUS));
});

test('a healthy channel reports nothing cleared, so no recovery line is logged', async () => {
  // The predicate matched no row. This is the ordinary case on every send, and calling it
  // a clear would put a recovery line in the log for every reply this platform ever sends.
  const s = stubDb([]);
  assert.deepEqual(await clearCredentialFailure(s.db, { tenantId: 't-1', channelId: 'c-1' }),
    { ok: true, cleared: false });
});

test('an unreadable write is reported, never thrown', async () => {
  // The customer already has the message by the time this runs. Bookkeeping must not be
  // able to undo that or to fail the job.
  const s = stubDb([], { message: 'permission denied' });
  const out = await clearCredentialFailure(s.db, { tenantId: 't-1', channelId: 'c-1' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.detail : '', /permission denied/);
});
