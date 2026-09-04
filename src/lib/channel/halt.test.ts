import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haltChannelOutbound } from './halt.ts';

function stubDb(error: unknown = null) {
  const ops: { table: string; patch?: Record<string, unknown>; filters: string[] }[] = [];
  const from = (table: string) => {
    const rec = { table, filters: [] as string[] } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    chain['update'] = (patch: Record<string, unknown>) => {
      rec.patch = patch;
      return chain;
    };
    chain['eq'] = (...args: unknown[]) => {
      rec.filters.push(`eq(${args.map(String).join(',')})`);
      return chain;
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ error });
    return chain;
  };
  return { ops, db: { from } as never };
}

test('halting writes all three columns in one statement', async () => {
  const { db, ops } = await (async () => {
    const s = stubDb();
    await haltChannelOutbound(s.db, { tenantId: 't-1', channelId: 'c-1' });
    return s;
  })();
  void db;
  assert.equal(ops[0]?.table, 'tenant_channels');
  assert.deepEqual(ops[0]?.patch, {
    token_status: 'revoked',
    delivery_mode: 'off',
    status: 'authorization_error',
  });
  assert.deepEqual(ops[0]?.filters, ['eq(id,c-1)', 'eq(tenant_id,t-1)']);
});

test('delivery_mode is not optional — the CHECK forbids the one-column version', () => {
  // Read from the migration rather than asserted from memory. `check (delivery_mode <>
  // 'live' or token_status = 'active')` means `set token_status = 'revoked'` alone is
  // REJECTED on exactly the channels this matters for: the live ones. Proven against
  // PostgreSQL 16.13 in scripts/verify/secret-roundtrip.ts, which runs the failing
  // statement and asserts the error.
  const sql = readFileSync('supabase/migrations/0001_initial_schema.sql', 'utf8');
  const start = sql.indexOf('create table tenant_channels (');
  assert.notEqual(start, -1);
  const body = sql.slice(start, sql.indexOf('\n);', start));
  assert.match(body, /live_requires_active_token/);
  assert.match(body, /delivery_mode <> 'live' or token_status = 'active'/);
});

test('a failed halt is reported rather than swallowed', async () => {
  const { db } = stubDb({ message: 'permission denied' });
  assert.deepEqual(await haltChannelOutbound(db, { tenantId: 't-1', channelId: 'c-1' }), {
    ok: false,
    detail: 'haltChannelOutbound failed: permission denied',
  });
});
