/**
 * The per-request read of a tenant's credential (V1.md's "Per-tenant token from
 * `tenant_secrets`, decrypted per request", §3.4).
 *
 * ## Why there is no cache here at all
 *
 * The ancestor holds its prompt in a module-scope `cachedBasePrompt` and its token behind
 * a `|| process.env.PAGE_ACCESS_TOKEN` fallback. At one tenant both are sensible. At two,
 * a warm Vercel lambda is reused across tenants and a module-scope credential becomes
 * tenant B replying on tenant A's token — which, combined with `/me/messages`, **succeeds**
 * and posts as the wrong salon. There is no error to catch and no log line to find.
 *
 * So this module memoises nothing, not even the KEK, and the decrypted secret is returned
 * rather than stored. The cost is one round trip and two AES operations per send; what it
 * buys is that no object exists which can outlive a request holding another tenant's
 * credential.
 *
 * ## The binding is computed, never read
 *
 * `openForRow` is passed the AAD derived from the identity we are asking about — never the
 * row's own `aad` column. That distinction is the entire security property: a
 * `service_role` key holds BYPASSRLS and can write this table, so if the row supplied its
 * own binding, an attacker copying a working ciphertext would copy the matching `aad` with
 * it and the tag would verify.
 *
 * The stored column is therefore a **tripwire, not a boundary** — the same distinction
 * §2.9 draws about the `EAA…` deny-list. It is compared, so a mismatch refuses with a
 * legible cause rather than an authentication failure whose reason is unknowable. Passing
 * it to `openForRow` would look like a harmless simplification and would silently delete
 * the defence.
 *
 * ## Codes say what happened; `retryable` says what to do
 *
 * Separate fields, because conflating them is how a permanent failure becomes a retry
 * storm: QStash redelivers, every redelivery re-reads a row that will never open, and the
 * only thing that changes is the rate. Exactly one code is retryable.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { aadFor, channelKeyOf, openForRow } from '../crypto/envelope.ts';
import { kekForVersion } from '../crypto/kek.ts';

/** The `kind` CHECK constraint on `tenant_secrets`, in TypeScript. */
/**
 * The `kind` CHECK constraint, mirrored ONCE.
 *
 * A runtime array with the type derived from it, rather than a type alone, because there
 * were three copies of this list and they disagreed. `0032` widened the database CHECK;
 * this union was widened after `tsc` caught it; and `scripts/kek/seal.ts` carried a THIRD
 * copy that neither change reached — so the one command that puts a `web_mint_secret` in
 * the database would have refused the kind the database had just been taught to accept.
 *
 * Found while writing the provisioning runbook, which is the only reason it was found at
 * all: nothing executes that path in CI, because sealing a secret needs a real KEK and a
 * real value. Anything that needs the list now imports it.
 */
export const SECRET_KINDS = [
  'page_token',
  'ig_token',
  'app_secret',
  'sip_password',
  'booking_webhook_secret',
  // The tenant server's HMAC key for POST /api/web/session (D-086, `0032`).
  'web_mint_secret',
] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

/** The `status` CHECK constraint. Only the first two can produce a credential. */
export type SecretStatus = 'active' | 'rotating' | 'revoked';

export type SecretFailureCode =
  /** No row. Onboarding is incomplete — an operator-visible state, never a silent skip. */
  | 'token_missing'
  /** Meta invalidated it (Graph 190). Terminal: halt outbound on this binding, keep inbound. */
  | 'token_revoked'
  /** The read failed, or the row is not shaped like a row. The only retryable code. */
  | 'secret_unreadable'
  /** The platform cannot decrypt ANYTHING sealed under that version: the KEK is absent. */
  | 'kek_unavailable'
  /** This row will not open under its own binding. Tamper, or a row from another KEK era. */
  | 'secret_undecryptable'
  /** It opened, and what came out cannot be used as a credential. */
  | 'secret_malformed';

export type SecretOutcome =
  | { ok: true; secret: string; kekVersion: number; status: 'active' | 'rotating' }
  | { ok: false; code: SecretFailureCode; retryable: boolean; detail: string };

export type SecretRef = { tenantId: string; channelId: string | null; kind: SecretKind };

/**
 * Decode a `bytea` as PostgREST serialises it.
 *
 * Postgres's default `bytea_output` is `hex`, so the wire form is a backslash, an `x`, and
 * hex digits. Nothing else is accepted: base64 or an array of numbers here would mean the
 * server is configured differently from what this code assumes, and quietly guessing the
 * format turns a configuration difference into an authentication failure three layers
 * down, where the cause is no longer visible.
 */
export function decodeBytea(value: unknown, column: string): Buffer {
  if (typeof value !== 'string') {
    throw new TypeError(`${column} came back as ${value === null ? 'null' : typeof value}, not a bytea string.`);
  }
  if (!value.startsWith('\\x')) {
    throw new TypeError(`${column} is not in Postgres hex bytea form. Refusing to guess the encoding.`);
  }
  const hex = value.slice(2);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(`${column} is not valid hex after the prefix.`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * A decrypted credential must survive being put in an `Authorization` header.
 *
 * A CR or LF in a header value is request splitting; `fetch` does refuse one, but as an
 * opaque `TypeError` raised inside the send, far from the row that caused it. Refusing
 * here names the row. Empty is refused for the same reason `seal` refuses to seal nothing:
 * a bearer header with no token produces a Meta error that is true and useless.
 */
function unusableBecause(secret: string): string | null {
  if (secret.length === 0) return 'the decrypted secret is empty';
  if (/[\u0000-\u001F\u007F]/.test(secret)) return 'the decrypted secret contains control characters';
  if (secret !== secret.trim()) return 'the decrypted secret has leading or trailing whitespace';
  return null;
}

/**
 * Read and decrypt one credential. Never logs it, never caches it, never falls back.
 *
 * The filter uses `channel_key`, not `channel_id`: it is the generated column the primary
 * key is built on and it coalesces a null channel to the nil UUID, so platform-wide kinds
 * are addressable by the same query as channel-scoped ones.
 */
export async function loadTenantSecret(db: SupabaseClient, ref: SecretRef): Promise<SecretOutcome> {
  const { data, error } = await db
    .from('tenant_secrets')
    .select('ciphertext, wrapped_dek, kek_version, aad, status')
    .eq('tenant_id', ref.tenantId)
    .eq('channel_key', channelKeyOf(ref.channelId))
    .eq('kind', ref.kind)
    .maybeSingle();

  if (error) {
    // Transient by assumption, and the ONLY code that is. This is CLAUDE.md rule 2's
    // "a 503 costs a retry" case.
    return { ok: false, code: 'secret_unreadable', retryable: true, detail: `tenant_secrets unreadable: ${error.message}` };
  }
  if (data === null || data === undefined) {
    return {
      ok: false,
      code: 'token_missing',
      retryable: false,
      detail: `no ${ref.kind} for this tenant and channel: the binding is not provisioned`,
    };
  }

  const row = data as Record<string, unknown>;
  const status = String(row['status'] ?? '');
  if (status === 'revoked') {
    return {
      ok: false,
      code: 'token_revoked',
      retryable: false,
      detail: 'the credential is revoked; outbound on this binding stays halted until it is replaced',
    };
  }
  if (status !== 'active' && status !== 'rotating') {
    // The CHECK constraint permits three values. A fourth means the row is not what this
    // code believes it is, and a credential is not the place to assume the best.
    return { ok: false, code: 'secret_unreadable', retryable: false, detail: `unrecognised status ${JSON.stringify(status)}` };
  }

  const kekVersion = row['kek_version'];
  if (typeof kekVersion !== 'number' || !Number.isInteger(kekVersion)) {
    return { ok: false, code: 'secret_unreadable', retryable: false, detail: 'kek_version is not an integer' };
  }

  let ciphertext: Buffer;
  let wrappedDek: Buffer;
  try {
    ciphertext = decodeBytea(row['ciphertext'], 'ciphertext');
    wrappedDek = decodeBytea(row['wrapped_dek'], 'wrapped_dek');
  } catch (e) {
    return { ok: false, code: 'secret_unreadable', retryable: false, detail: (e as Error).message };
  }

  // Computed from the identity we asked about. See the module note: the row's own `aad`
  // column is never what decrypts it.
  const aad = aadFor({ tenantId: ref.tenantId, channelId: ref.channelId, kind: ref.kind });
  if (row['aad'] !== aad) {
    return {
      ok: false,
      code: 'secret_undecryptable',
      retryable: false,
      detail: 'the stored binding does not match this row identity',
    };
  }

  let kek: Buffer;
  try {
    kek = kekForVersion(kekVersion);
  } catch (e) {
    // Distinct from `secret_undecryptable` because the blast radius differs: this is every
    // tenant sealed under that version, and the fix is a deployment rather than a row. One
    // alert must not have to describe both.
    return { ok: false, code: 'kek_unavailable', retryable: false, detail: `kek v${kekVersion}: ${(e as Error).message}` };
  }

  let plaintext: Buffer;
  try {
    plaintext = openForRow({ ciphertext, wrappedDek, kek, aad });
  } catch (e) {
    return { ok: false, code: 'secret_undecryptable', retryable: false, detail: (e as Error).message };
  }

  const secret = plaintext.toString('utf8');
  plaintext.fill(0);
  const problem = unusableBecause(secret);
  if (problem !== null) return { ok: false, code: 'secret_malformed', retryable: false, detail: problem };

  return { ok: true, secret, kekVersion, status };
}

/**
 * Every column the writers below may touch.
 *
 * `0001` is the schema (docs/schema.md beats every section file's DDL), and it carries
 * neither `last_error_at` nor `expires_at` nor `refresh_after` — all three appear in
 * §3.4's draft DDL and none of them exists. A patch naming one would be accepted by every
 * stub in this suite and rejected by PostgREST at the first real send, which, with no
 * Supabase project to try it against, is a defect that could sit here for months.
 * `tenantSecret.test.ts` reads the migration and checks these names against it.
 */
export const WRITABLE_SECRET_COLUMNS = ['status', 'last_ok_at', 'last_error_code'] as const;

/** Stamp a successful use. Nothing about the credential itself is written. */
export async function recordSecretOk(db: SupabaseClient, ref: SecretRef, now: Date): Promise<{ ok: boolean; detail?: string }> {
  const { error } = await db
    .from('tenant_secrets')
    .update({ last_ok_at: now.toISOString(), last_error_code: null })
    .eq('tenant_id', ref.tenantId)
    .eq('channel_key', channelKeyOf(ref.channelId))
    .eq('kind', ref.kind);
  return error ? { ok: false, detail: error.message } : { ok: true };
}

/**
 * Record the provider's numeric error against the binding.
 *
 * **The column takes a number and nothing else.** The schema comment says "Meta's numeric
 * code. Never a token, never a body", and that is the whole design: the natural thing to
 * store on a failure is the provider's message, which for an auth failure is the single
 * string most likely to quote the credential back. The sibling repository still logs QPay
 * bank details on error; this is that bug's larger sibling, so the type forbids it.
 */
export async function recordSecretError(
  db: SupabaseClient,
  ref: SecretRef,
  errorCode: number | null,
): Promise<{ ok: boolean; detail?: string }> {
  const { error } = await db
    .from('tenant_secrets')
    .update({ last_error_code: errorCode })
    .eq('tenant_id', ref.tenantId)
    .eq('channel_key', channelKeyOf(ref.channelId))
    .eq('kind', ref.kind);
  return error ? { ok: false, detail: error.message } : { ok: true };
}

/**
 * Mark a binding revoked after a Graph `190`.
 *
 * Deliberately not "delete the row": the ciphertext is evidence, `last_error_code` is the
 * only record of why outbound stopped, and re-provisioning overwrites it anyway. §3.4.4
 * requires outbound to halt while inbound keeps being persisted — the second half belongs
 * to the caller, and this function does not imply it.
 */
export async function revokeSecret(
  db: SupabaseClient,
  ref: SecretRef,
  errorCode: number,
): Promise<{ ok: boolean; detail?: string }> {
  const { error } = await db
    .from('tenant_secrets')
    .update({ status: 'revoked', last_error_code: errorCode })
    .eq('tenant_id', ref.tenantId)
    .eq('channel_key', channelKeyOf(ref.channelId))
    .eq('kind', ref.kind);
  return error ? { ok: false, detail: error.message } : { ok: true };
}
