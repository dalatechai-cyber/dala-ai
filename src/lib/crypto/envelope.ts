/**
 * Envelope encryption for per-tenant credentials (§2.4-A, §3.4.1).
 *
 * A Page access token is per-tenant **data**, not platform configuration, so CLAUDE.md
 * rule 7's "secrets from the environment only" does not survive contact with N tenants.
 * What survives is the shape underneath it: the *capability to decrypt* stays in the
 * environment while the ciphertext lives in the database.
 *
 * ```
 *   DEK   = 32 random bytes, fresh per row
 *   row.ciphertext  = seal(secret, DEK,      aad)
 *   row.wrapped_dek = seal(DEK,    KEK[ver], aad)
 *   KEK   = TENANT_KEK_V{ver} in the platform environment. Never in the database.
 * ```
 *
 * The KEK is in Vercel's environment and the ciphertext is in Supabase, so an attacker
 * needs **both vendors** rather than either. That is the whole argument against Supabase
 * Vault, whose `decrypted_secrets` view decrypts on read for the same `service_role`
 * credential that already has full data access: one leaked `sb_secret_…` key would yield
 * every tenant's token in plaintext. For a solo founder on a public repository, a leaked
 * service key is the likelier incident than a stolen database backup, and these two
 * designs are equivalent only against the second.
 *
 * ## The AAD is what makes a row's ciphertext useless in another row
 *
 * GCM authenticates additional data without encrypting it. Passing the row's own identity
 * — tenant, channel, kind — means a `service_role` key that can UPDATE `tenant_secrets`
 * still cannot move tenant A's working token onto tenant B's row: the tag check fails and
 * `open` throws, rather than decrypting into a credential that posts as the wrong salon.
 * Without it, copying one column is a complete cross-tenant credential transfer.
 *
 * ## What this module deliberately does not do
 *
 * No environment access, no database, no logging. It takes keys as arguments and returns
 * bytes, so every test here is exact and offline. `kek.ts` holds the environment half and
 * `../secrets/tenantSecret.ts` holds the row half — and neither of those can be tested
 * without stubbing, which is precisely why the arithmetic lives where it can be.
 *
 * **Nothing here ever puts plaintext, key material or a token prefix into an error
 * message.** Error text is the most commonly logged string in any codebase.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256. Any other length is a different algorithm, not a shorter key. */
export const KEY_BYTES = 32;

/**
 * 96-bit IV, GCM's native size — the one length that needs no internal derivation step.
 *
 * It is random per seal, not a counter. A counter would be stronger in the abstract and
 * unimplementable here: there is no single writer to own it, and a resumed rotation job
 * that re-used one would be catastrophic in a way a random IV cannot be. With random
 * 96-bit IVs the birthday bound under ONE key is ~2^32 seals for a 2^-32 collision
 * probability; the KEK is the only reused key and it wraps one DEK per tenant per kind.
 */
const IV_BYTES = 12;

/** GCM's full tag. Truncating it is a security parameter, so it is not a parameter. */
const TAG_BYTES = 16;

/** Postgres's `channel_key` generated column coalesces a null `channel_id` to this. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const OVERHEAD = IV_BYTES + TAG_BYTES;

export type EnvelopeErrorCode =
  /** A key that is not exactly 32 bytes. */
  | 'bad_key_length'
  /** Too short to contain an IV and a tag, i.e. not something this module produced. */
  | 'bad_ciphertext_shape'
  /** The tag did not verify: wrong key, wrong AAD, or altered bytes. Indistinguishable. */
  | 'auth_failed'
  /** Refusing to seal nothing, or to seal without a binding. */
  | 'refused';

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    // Length only. Never the key, never a prefix of it.
    throw new EnvelopeError(
      'bad_key_length',
      `Key must be exactly ${KEY_BYTES} bytes for AES-256-GCM; got ${key.length}.`,
    );
  }
}

/**
 * The canonical binding string for one `tenant_secrets` row.
 *
 * `02-schema-rls.md` writes this as `tenant_id||channel_id||kind` in SQL's concatenation
 * notation, which says *what* is bound rather than how it is spelled. This function is the
 * spelling, and it is the only one: the `aad` column stores what this returned, and
 * changing the format silently makes every existing row undecryptable.
 *
 * Two details that are not cosmetic:
 *
 *  - **A null `channel_id` becomes the nil UUID**, exactly as the `channel_key` generated
 *    column does. Otherwise the platform-wide kinds (`app_secret`) would have an AAD that
 *    disagrees with the primary key they are stored under, and "which row is this" would
 *    have two answers.
 *  - **The separator is explicit.** UUIDs are fixed-width so plain concatenation happens
 *    to be unambiguous here, but that is a property of today's column types rather than of
 *    the format, and a canonicalisation ambiguity is not a bug anybody finds by reading.
 */
export function aadFor(input: { tenantId: string; channelId: string | null; kind: string }): string {
  const channelKey = channelKeyOf(input.channelId);
  if (input.tenantId === '' || input.kind === '') {
    throw new EnvelopeError('refused', 'A binding needs both a tenant and a kind; refusing to bind to nothing.');
  }
  return `${input.tenantId}|${channelKey}|${input.kind}`;
}

/** The value Postgres stores in `tenant_secrets.channel_key` for this `channel_id`. */
export function channelKeyOf(channelId: string | null | undefined): string {
  return channelId == null || channelId === '' ? NIL_UUID : channelId;
}

/** A fresh data key. One per row, so the IV space of a DEK is never meaningfully reused. */
export function newDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypt under `key`, bound to `aad`. Layout is `iv || tag || ciphertext`.
 *
 * The tag precedes the ciphertext rather than trailing it (OpenSSL's own convention) so
 * that parsing needs no length arithmetic from the end — a slice with a sign error then
 * produces a short read that fails loudly rather than an off-by-one that decrypts.
 */
export function seal(plaintext: Buffer, key: Buffer, aad: string): Buffer {
  assertKey(key);
  if (plaintext.length === 0) {
    // An empty credential would later become `Authorization: Bearer ` and a Meta error
    // that says nothing about the cause. Refuse where the cause is still visible.
    throw new EnvelopeError('refused', 'Refusing to seal an empty value.');
  }
  if (aad === '') throw new EnvelopeError('refused', 'Refusing to seal without a binding.');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/**
 * Decrypt and verify. Throws `EnvelopeError('auth_failed')` on wrong key, wrong AAD or
 * altered bytes — one code for all three on purpose.
 *
 * Distinguishing them would be a decryption oracle for anyone who can submit rows, and
 * there is no operator question the distinction answers: all three mean *do not use this
 * value*, and the next step is the same in each case.
 */
export function open(sealed: Buffer, key: Buffer, aad: string): Buffer {
  assertKey(key);
  if (sealed.length <= OVERHEAD) {
    throw new EnvelopeError(
      'bad_ciphertext_shape',
      `Sealed value must exceed ${OVERHEAD} bytes of IV and tag; got ${sealed.length}.`,
    );
  }
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, OVERHEAD);
  const ct = sealed.subarray(OVERHEAD);

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  // setAAD must precede update(); OpenSSL rejects it afterwards.
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // The thrown OpenSSL error carries nothing sensitive today, but it is not ours and
    // it is not stable. Replace it rather than re-wrap it.
    throw new EnvelopeError('auth_failed', 'Sealed value did not authenticate under this key and binding.');
  }
}

/**
 * Seal a secret for one row: a fresh DEK, the secret under it, the DEK under the KEK.
 *
 * The DEK is overwritten before returning. That is best-effort in a garbage-collected
 * runtime — `Buffer.concat` and `randomBytes` may both have left copies the language will
 * not let us reach — so it is a habit rather than a control, and nothing above it is
 * allowed to depend on it.
 */
export function sealForRow(secret: Buffer, kek: Buffer, aad: string): { ciphertext: Buffer; wrappedDek: Buffer } {
  assertKey(kek);
  const dek = newDek();
  try {
    return { ciphertext: seal(secret, dek, aad), wrappedDek: seal(dek, kek, aad) };
  } finally {
    dek.fill(0);
  }
}

/**
 * Unwrap the DEK and decrypt the secret. The inverse of `sealForRow`.
 *
 * Both halves carry the SAME binding, so a row assembled from two different rows' columns
 * fails on whichever half is checked first — there is no combination that half-works.
 */
export function openForRow(input: { ciphertext: Buffer; wrappedDek: Buffer; kek: Buffer; aad: string }): Buffer {
  const dek = open(input.wrappedDek, input.kek, input.aad);
  try {
    assertKey(dek);
    return open(input.ciphertext, dek, input.aad);
  } finally {
    dek.fill(0);
  }
}
