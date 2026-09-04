/**
 * Prove a credential survives Postgres.
 *
 *     TENANT_KEK_V1=<base64> TENANT_KEK_ACTIVE_VERSION=v1 \
 *       node scripts/verify/secret-roundtrip.ts [database]
 *
 * The unit tests seal and open in memory. They cannot tell whether the bytes survive a
 * `bytea` column, whether the generated `channel_key` really is what the primary key is
 * built on, whether `on conflict (tenant_id, channel_key, kind)` names a real unique
 * index, or whether the value PostgREST would hand back is the shape `decodeBytea`
 * expects. Those are database facts, and this exercises them against a real PostgreSQL.
 *
 * What it still does **not** prove, and must never be written as if it did: nothing here
 * touches a Supabase project, PostgREST, or `service_role`. It confirms the storage and
 * the SQL; the transport is unverified until a project exists.
 *
 * It drives `scripts/kek/seal.ts` as a subprocess rather than importing it, so what is
 * checked is the command an operator actually runs — including its argument handling and
 * its own self-check.
 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadTenantSecret } from '../../src/lib/secrets/tenantSecret.ts';

const DB = process.argv[2] ?? 'dala_verify';
const TENANT = '9f2b1c44-0000-4000-8000-000000000001';
const OTHER_TENANT = '9f2b1c44-0000-4000-8000-000000000002';
const CHANNEL = '9f2b1c44-0000-4000-8000-00000000000a';
const OTHER_CHANNEL = '9f2b1c44-0000-4000-8000-00000000000b';
// Not a real token, and shaped like one on purpose: an `EAA…` prefix is what the
// documentary CHECK on this column looks for.
const TOKEN = 'EAAtestNotARealTokenJustLongEnoughToLookLikeOne0123456789';

const psql = (sql: string): string =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-tAq', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

/**
 * Run one check and report it only once it has actually finished.
 *
 * `fn: () => void` is what this was first written as, and with an async body it swallowed
 * every assertion: `step` returned before the promise settled, printed `ok`, and the
 * failure surfaced later as an unhandled rejection AFTER the summary line had already
 * claimed a pass. Seven checks reported green while one of them was reading no row at all.
 * The awaited `Promise<void>` return is the whole fix, and it is the same shape as every
 * other false green this repository has found.
 */
async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  process.stdout.write(`  ok  ${name}\n`);
}

// --- scratch rows the FKs need ------------------------------------------------------
psql(`
  insert into tenants (id, slug, display_name, vertical, timezone)
  values ('${TENANT}', 'roundtrip-a', 'Roundtrip A', 'beauty', 'Asia/Ulaanbaatar'),
         ('${OTHER_TENANT}', 'roundtrip-b', 'Roundtrip B', 'beauty', 'Asia/Ulaanbaatar')
  on conflict (id) do nothing;
  insert into tenant_channels (id, tenant_id, provider, external_id)
  values ('${CHANNEL}', '${TENANT}', 'facebook_page', '100000000000001'),
         ('${OTHER_CHANNEL}', '${OTHER_TENANT}', 'facebook_page', '100000000000002')
  on conflict (id) do nothing;
`);

// --- seal, through the operator's own command ---------------------------------------
const sql = execFileSync(
  process.execPath,
  ['scripts/kek/seal.ts', '--tenant', TENANT, '--channel', CHANNEL, '--kind', 'page_token'],
  { input: TOKEN, encoding: 'utf8' },
);
assert.ok(!sql.includes(TOKEN), 'the emitted SQL must not contain the secret');
psql(sql);

/** Read a row back in the shape PostgREST serialises `bytea` in: hex, with the prefix. */
function readRow(tenantId: string, channelId: string, kind = 'page_token'): Record<string, unknown> {
  const row = psql(`
    select json_build_object(
      'ciphertext',  '\\x' || encode(ciphertext, 'hex'),
      'wrapped_dek', '\\x' || encode(wrapped_dek, 'hex'),
      'kek_version', kek_version,
      'aad', aad,
      'status', status)
    from tenant_secrets
    where tenant_id = '${tenantId}' and channel_key = '${channelId}' and kind = '${kind}';
  `);
  assert.notEqual(row, '', 'expected a tenant_secrets row');
  return JSON.parse(row) as Record<string, unknown>;
}

const db = (data: unknown) =>
  ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain['maybeSingle'] = async () => ({ data, error: null });
      return chain;
    },
  }) as never;

const ref = { tenantId: TENANT, channelId: CHANNEL, kind: 'page_token' as const };

await (async () => {
  const stored = readRow(TENANT, CHANNEL);

  await step('the stored row decrypts to the sealed token', async () => {
    const out = await loadTenantSecret(db(stored), ref);
    assert.equal(out.ok, true, out.ok ? '' : out.detail);
    assert.equal(out.ok && out.secret, TOKEN);
  });

  await step('bytea survived the column byte for byte', () => {
    const len = Number(
      psql(`select octet_length(ciphertext) from tenant_secrets where tenant_id = '${TENANT}' and kind = 'page_token';`),
    );
    assert.equal(len, Buffer.byteLength(TOKEN, 'utf8') + 12 + 16);
  });

  await step('re-running seal is an upsert, not a second row', () => {
    const again = execFileSync(
      process.execPath,
      ['scripts/kek/seal.ts', '--tenant', TENANT, '--channel', CHANNEL, '--kind', 'page_token'],
      { input: TOKEN, encoding: 'utf8' },
    );
    psql(again);
    assert.equal(psql(`select count(*) from tenant_secrets where tenant_id = '${TENANT}' and kind = 'page_token';`), '1');
  });

  await step('the same token re-sealed produces DIFFERENT bytes', async () => {
    const second = readRow(TENANT, CHANNEL);
    assert.notEqual(second['ciphertext'], stored['ciphertext'], 'a fresh IV and DEK every time');
    const out = await loadTenantSecret(db(second), ref);
    assert.equal(out.ok && out.secret, TOKEN);
  });

  await step('the ciphertext copied onto another tenant row does not decrypt', async () => {
    // The attack the AAD exists for, performed in SQL rather than in a stub: a
    // service_role key holds BYPASSRLS and can do exactly this UPDATE.
    psql(`
      insert into tenant_secrets (tenant_id, channel_id, kind, ciphertext, wrapped_dek, kek_version, aad)
      select '${OTHER_TENANT}', '${OTHER_CHANNEL}', 'page_token', ciphertext, wrapped_dek, kek_version, aad
      from tenant_secrets where tenant_id = '${TENANT}'
      on conflict (tenant_id, channel_key, kind) do update
        set ciphertext = excluded.ciphertext, wrapped_dek = excluded.wrapped_dek, aad = excluded.aad;
    `);
    const copied = readRow(OTHER_TENANT, OTHER_CHANNEL);
    const out = await loadTenantSecret(db(copied), {
      tenantId: OTHER_TENANT,
      channelId: OTHER_CHANNEL,
      kind: 'page_token',
    });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.code, 'secret_undecryptable');
  });

  await step('a platform-wide kind stores under the nil channel_key and reads back', async () => {
    const appSecretSql = execFileSync(
      process.execPath,
      ['scripts/kek/seal.ts', '--tenant', TENANT, '--channel', 'none', '--kind', 'app_secret'],
      { input: 'not-a-real-app-secret', encoding: 'utf8' },
    );
    psql(appSecretSql);
    const key = psql(`select channel_key from tenant_secrets where tenant_id = '${TENANT}' and kind = 'app_secret';`);
    assert.equal(key, '00000000-0000-0000-0000-000000000000');
    const out = await loadTenantSecret(db(readRow(TENANT, key, 'app_secret')), {
      tenantId: TENANT,
      channelId: null,
      kind: 'app_secret',
    });
    assert.equal(out.ok && out.secret, 'not-a-real-app-secret');
  });

  await step('a revoked row refuses even though its bytes are intact', async () => {
    psql(`update tenant_secrets set status = 'revoked' where tenant_id = '${TENANT}' and kind = 'page_token';`);
    const out = await loadTenantSecret(db(readRow(TENANT, CHANNEL)), ref);
    assert.equal(!out.ok && out.code, 'token_revoked');
  });
})();

// Only the rows this script wrote. A tenant cannot be deleted here at all: the cascade
// reaches `config_audit`, whose ENABLE ALWAYS append-only trigger refuses — which is the
// trigger working, and is why offboarding sets `tenants.status = 'purged'` rather than
// deleting the row (§2.12). The scratch database is rebuilt per run in any case, and
// every insert above is `on conflict do nothing`.
psql(`delete from tenant_secrets where tenant_id in ('${TENANT}', '${OTHER_TENANT}');`);
process.stdout.write('SECRET ROUND-TRIP PASSED (real PostgreSQL; NOT a Supabase project)\n');
