import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { aadFor, NIL_UUID, sealForRow } from '../crypto/envelope.ts';
import {
  decodeBytea,
  loadTenantSecret,
  recordSecretError,
  recordSecretOk,
  revokeSecret,
  WRITABLE_SECRET_COLUMNS,
  type SecretOutcome,
  type SecretRef,
} from './tenantSecret.ts';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CHANNEL_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHANNEL_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TOKEN = 'EAAG1234567890abcdefghijklmnopqrstuvwxyz';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');

const refA: SecretRef = { tenantId: TENANT_A, channelId: CHANNEL_A, kind: 'page_token' };
const refB: SecretRef = { tenantId: TENANT_B, channelId: CHANNEL_B, kind: 'page_token' };

/**
 * Set environment for the duration of ONE await, then put it back.
 *
 * It has to `await fn()` inside the try. A synchronous version returns the promise and
 * runs its `finally` immediately, so the environment is restored before the code under
 * test reaches its first `process.env` read — and every KEK lookup then fails for a
 * reason that has nothing to do with the test. That is how the first eight of these
 * failed.
 */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prior.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Both KEK versions present, so "which key" is a choice the code has to make correctly. */
const bothKeks = { TENANT_KEK_V1: KEY_V1, TENANT_KEK_V2: KEY_V2, TENANT_KEK_ACTIVE_VERSION: 'v1' };

const hex = (b: Buffer) => `\\x${b.toString('hex')}`;

/**
 * Build a `tenant_secrets` row exactly as the seal script would, so every test that reads
 * one is reading real ciphertext rather than a fixture somebody typed.
 */
function row(opts: { ref?: SecretRef; sealAs?: SecretRef; secret?: string; kekVersion?: number; kekB64?: string; status?: string } = {}) {
  const identity = opts.ref ?? refA;
  const sealAs = opts.sealAs ?? identity;
  const version = opts.kekVersion ?? 1;
  const kek = Buffer.from(opts.kekB64 ?? (version === 2 ? KEY_V2 : KEY_V1), 'base64');
  const aad = aadFor(sealAs);
  const sealed = sealForRow(Buffer.from(opts.secret ?? TOKEN, 'utf8'), kek, aad);
  return {
    ciphertext: hex(sealed.ciphertext),
    wrapped_dek: hex(sealed.wrappedDek),
    kek_version: version,
    aad,
    status: opts.status ?? 'active',
  };
}

/** Records every filter and patch, and counts reads, so caching would be visible. */
function stubDb(result: { data?: unknown; error?: unknown } = {}) {
  const ops: { table: string; op: string; filters: string[]; patch?: Record<string, unknown> }[] = [];
  let reads = 0;
  const from = (table: string) => {
    const rec = { table, op: 'select', filters: [] as string[] } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'select', 'in', 'is']) {
      chain[m] = (...args: unknown[]) => {
        rec.filters.push(`${m}(${args.map(String).join(',')})`);
        return chain;
      };
    }
    chain['update'] = (patch: Record<string, unknown>) => {
      rec.op = 'update';
      rec.patch = patch;
      return chain;
    };
    chain['maybeSingle'] = async () => {
      reads += 1;
      return { data: 'data' in result ? result.data : null, error: result.error ?? null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ error: result.error ?? null });
    return chain;
  };
  return { ops, db: { from } as never, reads: () => reads };
}

const load = (r: { data?: unknown; error?: unknown }, ref = refA, env: Record<string, string | undefined> = bothKeks): Promise<SecretOutcome> =>
  withEnv(env, () => loadTenantSecret(stubDb(r).db, ref));

// ---------------------------------------------------------------------------
// The happy path, and the query that reaches it
// ---------------------------------------------------------------------------

test('a provisioned binding decrypts to the token that was sealed', async () => {
  const r = await load({ data: row() });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.secret, TOKEN);
  assert.equal(r.ok && r.kekVersion, 1);
});

test('a rotating binding is still usable — rotation is not an outage', async () => {
  const r = await load({ data: row({ status: 'rotating' }) });
  assert.equal(r.ok && r.status, 'rotating');
});

test('the read is scoped by tenant, channel_key and kind — never by channel_id', async () => {
  // channel_key is the generated column the primary key is built on. Filtering by
  // channel_id would miss every platform-wide row, whose channel_id is null and whose
  // channel_key is the nil UUID.
  const { db, ops } = stubDb({ data: row() });
  await withEnv(bothKeks, () => loadTenantSecret(db, refA));
  const filters = ops[0]?.filters.join(' ') ?? '';
  assert.match(filters, new RegExp(`eq\\(tenant_id,${TENANT_A}\\)`));
  assert.match(filters, new RegExp(`eq\\(channel_key,${CHANNEL_A}\\)`));
  assert.match(filters, /eq\(kind,page_token\)/);
  assert.doesNotMatch(filters, /eq\(channel_id/);
});

test('a platform-wide kind is addressed by the nil UUID, matching channel_key', async () => {
  const ref: SecretRef = { tenantId: TENANT_A, channelId: null, kind: 'app_secret' };
  const { db, ops } = stubDb({ data: row({ ref }) });
  const r = await withEnv(bothKeks, () => loadTenantSecret(db, ref));
  assert.equal(r.ok, true);
  assert.match(ops[0]?.filters.join(' ') ?? '', new RegExp(`eq\\(channel_key,${NIL_UUID}\\)`));
});

test('nothing is memoised: every call reads the row again', async () => {
  // The rule this pins is CLAUDE.md 7. A warm lambda is reused across tenants, so a
  // module-scope credential cache serves tenant A's token on tenant B's request — and with
  // /{page-id}/messages that is a 400, but with /me/messages it is a successful post as
  // the wrong salon. The cheapest defence is to have nothing to leak.
  const { db, reads } = stubDb({ data: row() });
  await withEnv(bothKeks, () => loadTenantSecret(db, refA));
  await withEnv(bothKeks, () => loadTenantSecret(db, refA));
  await withEnv(bothKeks, () => loadTenantSecret(db, refA));
  assert.equal(reads(), 3);
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test('no row is token_missing, and it is not retryable', async () => {
  const r = await load({ data: null });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'token_missing');
  assert.equal(!r.ok && r.retryable, false);
});

test('a revoked binding is terminal — never retried, never spent against', async () => {
  // §3.4.5: generating a reply we cannot deliver is spend with zero value, and most of the
  // backlog will be outside Messenger's 24-hour window by the time the token is restored.
  const r = await load({ data: row({ status: 'revoked' }) });
  assert.equal(!r.ok && r.code, 'token_revoked');
  assert.equal(!r.ok && r.retryable, false);
});

test('an unreadable table is the ONE retryable failure', async () => {
  const r = await load({ error: { message: 'connection reset' } });
  assert.equal(!r.ok && r.code, 'secret_unreadable');
  assert.equal(!r.ok && r.retryable, true);
});

test('every other failure is terminal — a retry storm is not a fallback', async () => {
  const outcomes = await Promise.all([
    load({ data: null }),
    load({ data: row({ status: 'revoked' }) }),
    load({ data: row({ status: 'pending' }) }),
    load({ data: { ...row(), kek_version: '1' } }),
    load({ data: { ...row(), ciphertext: 'not-a-bytea' } }),
    load({ data: row({ kekVersion: 3 }) }),
    load({ data: row({ sealAs: refB }) }),
    load({ data: row({ secret: 'has a newline\n' }) }),
  ]);
  for (const o of outcomes) {
    assert.equal(o.ok, false);
    assert.equal(!o.ok && o.retryable, false);
  }
  assert.deepEqual(
    outcomes.map((o) => (o.ok ? 'ok' : o.code)),
    [
      'token_missing',
      'token_revoked',
      'secret_unreadable',
      'secret_unreadable',
      'secret_unreadable',
      'kek_unavailable',
      'secret_undecryptable',
      'secret_malformed',
    ],
  );
});

test('a status outside the CHECK constraint refuses rather than assuming the best', async () => {
  const r = await load({ data: row({ status: 'pending' }) });
  assert.equal(!r.ok && r.code, 'secret_unreadable');
  assert.match((r as { detail: string }).detail, /unrecognised status/);
});

// ---------------------------------------------------------------------------
// The binding — the reason any of this is more than base64
// ---------------------------------------------------------------------------

test("tenant B's row, moved onto tenant A's identity, does not decrypt", async () => {
  // The whole point of the AAD. A leaked sb_secret_ key holds BYPASSRLS and can UPDATE
  // this table; without the binding, copying two columns is a complete credential transfer
  // and the reply goes out as the wrong salon.
  const r = await load({ data: row({ sealAs: refB }) }, refA);
  assert.equal(!r.ok && r.code, 'secret_undecryptable');
});

test('the STORED aad is never what decrypts — it is a tripwire, not a boundary', async () => {
  // The row is internally perfect: sealed under B's binding AND carrying B's binding in
  // its own `aad` column. If the code decrypted with the stored value it would succeed and
  // hand tenant A a working token belonging to tenant B. It must refuse.
  const forged = row({ ref: refA, sealAs: refB });
  assert.equal(forged.aad, aadFor(refB), 'the fixture really does carry the other row binding');
  const r = await load({ data: forged }, refA);
  assert.equal(!r.ok && r.code, 'secret_undecryptable');
  assert.match((r as { detail: string }).detail, /stored binding does not match/);
});

test('the same tenant and channel under a different KIND is a different row', async () => {
  const asAppSecret = row({ ref: refA, sealAs: { ...refA, kind: 'app_secret' } });
  const r = await load({ data: asAppSecret }, refA);
  assert.equal(!r.ok && r.code, 'secret_undecryptable');
});

test('a single flipped byte in the ciphertext refuses', async () => {
  const base = row();
  const bytes = Buffer.from(base.ciphertext.slice(2), 'hex');
  bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0x01, bytes.length - 1);
  const r = await load({ data: { ...base, ciphertext: `\\x${bytes.toString('hex')}` } });
  assert.equal(!r.ok && r.code, 'secret_undecryptable');
});

// ---------------------------------------------------------------------------
// Key selection
// ---------------------------------------------------------------------------

test('the ROW names the key, and a wrong version is never retried against another', async () => {
  // Sealed under V1, stamped kek_version = 2, with BOTH keys present. Trying V1 after V2
  // fails would make the unauthenticated kek_version column a lever rather than a hint,
  // and would turn a tamper signal into a success.
  const sealedUnderV1 = row({ kekVersion: 1 });
  const r = await load({ data: { ...sealedUnderV1, kek_version: 2 } });
  assert.equal(!r.ok && r.code, 'secret_undecryptable');
});

test('during rotation, a row sealed under V2 opens under V2', async () => {
  const r = await load({ data: row({ kekVersion: 2 }) });
  assert.equal(r.ok && r.secret, TOKEN);
});

test('a KEK version the platform does not hold is kek_unavailable, not undecryptable', async () => {
  // Different blast radius, different alert: this is every tenant sealed under that
  // version, and the fix is a deployment rather than a row.
  const r = await load({ data: row({ kekVersion: 3 }) });
  assert.equal(!r.ok && r.code, 'kek_unavailable');
  assert.match((r as { detail: string }).detail, /kek v3/);
});

test('no KEK in the environment at all refuses; there is no plaintext fallback', async () => {
  const r = await load({ data: row() }, refA, { TENANT_KEK_V1: undefined, TENANT_KEK_V2: undefined, TENANT_KEK_ACTIVE_VERSION: 'v1' });
  assert.equal(!r.ok && r.code, 'kek_unavailable');
});

// ---------------------------------------------------------------------------
// What comes out has to be usable as a credential
// ---------------------------------------------------------------------------

test('a decrypted value that cannot go in a header is refused where the row is still named', async () => {
  for (const bad of ['tok\nen', 'tok\ren', ' padded ', '']) {
    // An empty secret cannot be sealed at all, so it is tested through the seal refusal
    // rather than through a row that could not exist.
    if (bad === '') {
      assert.throws(() => row({ secret: '' }), /empty/);
      continue;
    }
    const r = await load({ data: row({ secret: bad }) });
    assert.equal(!r.ok && r.code, 'secret_malformed', `${JSON.stringify(bad)} should be refused`);
  }
});

test('no failure detail carries the token, the ciphertext or the key', async () => {
  // Error strings are the most commonly logged strings in any codebase, and this one would
  // be logged next to a tenant id.
  const cases = [
    await load({ data: row({ sealAs: refB }) }),
    await load({ data: row({ kekVersion: 3 }) }),
    await load({ data: row({ secret: `${TOKEN}\n` }) }),
    await load({ data: { ...row(), ciphertext: 'nope' } }),
  ];
  for (const c of cases) {
    const detail = (c as { detail: string }).detail;
    assert.doesNotMatch(detail, /EAAG/, detail);
    assert.doesNotMatch(detail, /[0-9a-f]{32}/, detail);
  }
});

// ---------------------------------------------------------------------------
// bytea, as PostgREST actually sends it
// ---------------------------------------------------------------------------

test('bytea decodes from Postgres hex form and refuses every other shape', () => {
  assert.deepEqual(decodeBytea('\\x0001ff', 'c'), Buffer.from([0, 1, 255]));
  assert.throws(() => decodeBytea('AAEC', 'ciphertext'), /hex bytea form/);
  assert.throws(() => decodeBytea(null, 'ciphertext'), /not a bytea string/);
  assert.throws(() => decodeBytea([1, 2, 3], 'ciphertext'), /not a bytea string/);
  assert.throws(() => decodeBytea('\\xzz', 'ciphertext'), /not valid hex/);
  assert.throws(() => decodeBytea('\\x0', 'ciphertext'), /not valid hex/);
  assert.throws(() => decodeBytea('\\x', 'ciphertext'), /not valid hex/);
});

// ---------------------------------------------------------------------------
// The writers
// ---------------------------------------------------------------------------

test('every column the writers touch exists in 0001 — checked against the migration', () => {
  // With no Supabase project to try it against, a patch naming a column that does not
  // exist would be accepted by every stub in this suite and rejected by PostgREST at the
  // first real send. §3.4's draft DDL has `last_error_at`, `expires_at`, `refresh_after`
  // and `scopes`; `0001` — which docs/schema.md makes canonical — has none of them, and
  // an earlier draft of this module wrote `last_error_at` on two paths.
  const sql = readFileSync('supabase/migrations/0001_initial_schema.sql', 'utf8');
  const start = sql.indexOf('create table tenant_secrets (');
  assert.notEqual(start, -1, 'the migration must still define tenant_secrets');
  const body = sql.slice(start, sql.indexOf('\n);', start));
  const columns = new Set(
    body
      .split('\n')
      .slice(1)
      .map((l) => /^\s{2}([a-z_]+)\s+\S/.exec(l)?.[1]) // ascii-safe: Postgres column names in a migration file
      .filter((c): c is string => Boolean(c)),
  );
  assert.ok(columns.has('last_ok_at'), 'sanity: the parser found real columns');
  assert.ok(!columns.has('last_error_at'), 'sanity: 0001 really does lack last_error_at');
  for (const c of WRITABLE_SECRET_COLUMNS) assert.ok(columns.has(c), `${c} is not a column of tenant_secrets`);
});

test('the writers patch only the declared columns, and always scope by the full key', async () => {
  const now = new Date('2026-09-04T10:00:00Z');
  const writes: { patch: Record<string, unknown>; filters: string[] }[] = [];
  for (const call of [
    (db: never) => recordSecretOk(db, refA, now),
    (db: never) => recordSecretError(db, refA, 190),
    (db: never) => revokeSecret(db, refA, 190),
  ]) {
    const { db, ops } = stubDb();
    await call(db);
    const rec = ops[0];
    assert.equal(rec?.op, 'update');
    writes.push({ patch: rec?.patch ?? {}, filters: rec?.filters ?? [] });
  }
  for (const w of writes) {
    for (const k of Object.keys(w.patch)) {
      assert.ok((WRITABLE_SECRET_COLUMNS as readonly string[]).includes(k), `${k} is not declared writable`);
    }
    const f = w.filters.join(' ');
    assert.match(f, /eq\(tenant_id,/);
    assert.match(f, /eq\(channel_key,/);
    assert.match(f, /eq\(kind,/);
  }
  assert.deepEqual(writes[2]?.patch, { status: 'revoked', last_error_code: 190 });
});

test('a successful use clears the last error rather than leaving a stale one', async () => {
  const { db, ops } = stubDb();
  await recordSecretOk(db, refA, new Date('2026-09-04T10:00:00Z'));
  assert.deepEqual(ops[0]?.patch, { last_ok_at: '2026-09-04T10:00:00.000Z', last_error_code: null });
});

test('a failing write is reported, not swallowed', async () => {
  const { db } = stubDb({ error: { message: 'permission denied' } });
  assert.deepEqual(await recordSecretOk(db, refA, new Date()), { ok: false, detail: 'permission denied' });
  assert.deepEqual(await revokeSecret(db, refA, 190), { ok: false, detail: 'permission denied' });
});
