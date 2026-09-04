/**
 * The key-encryption keys, from the environment (§3.4.6, §9's canonical env list).
 *
 * `TENANT_KEK_V1`, `TENANT_KEK_V2`, … are 32 random bytes each, base64, held in the
 * platform environment and nowhere else. `TENANT_KEK_ACTIVE_VERSION` (`v1`, `v2`, …) says
 * which one NEW rows are sealed under. Existing rows carry their own `kek_version`, and
 * that column — not this variable — chooses the key for a read.
 *
 * ## Why a read never consults the active version
 *
 * Rotation is: add V2 alongside V1, re-wrap every row, then remove V1. Both keys are live
 * in the middle of that, so "which key opens this row" is a property of the row. Reading
 * under the active version would break exactly the rows a resumed rotation has not reached
 * yet, which is the one moment the mechanism exists to survive.
 *
 * ## And a failed unwrap never tries another version
 *
 * There is no loop over available KEKs. Trying V1 after V2 fails would turn a tamper
 * signal into a success, and would make the `kek_version` column — which nothing
 * authenticates — a lever rather than a hint. When the named version does not open the
 * row, that is the answer.
 *
 * The version column being unauthenticated is safe for the same reason: pointing a row at
 * the wrong key produces a GCM failure, not a different plaintext. It selects which key is
 * tried; it cannot make a wrong key work.
 */
import { KEY_BYTES } from './envelope.ts';
import { required } from '../env.ts';

export class KekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KekError';
  }
}

/**
 * Decode 32 bytes of base64 key material, refusing anything else.
 *
 * **`Buffer.from(s, 'base64')` never throws.** It silently drops every character outside
 * the base64 alphabet and returns whatever the survivors decode to — so a truncated paste,
 * a value with a stray quote, or an entirely wrong string all become *some* buffer. A
 * length check catches most of those and a re-encode comparison catches the rest, because
 * the one thing that must not happen is a mistyped key being accepted as a different,
 * working key: every row sealed under it would be unrecoverable, and nothing would say so
 * until the first send.
 *
 * Surrounding whitespace is tolerated (a shell here-doc or a copy-paste adds a newline,
 * and refusing that teaches nothing). Node already accepts the URL-safe alphabet, so a key
 * written with `-`/`_` decodes to the same bytes and is deliberately allowed.
 */
export function decodeKeyMaterial(raw: string, name: string): Buffer {
  const trimmed = raw.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new KekError(
      `${name} must decode to exactly ${KEY_BYTES} bytes of base64; it decoded to ${key.length}. ` +
        `A 32-character key is not a 32-byte key. Generate one with: node scripts/kek/generate.ts`,
    );
  }
  // Normalise the URL-safe alphabet and padding on both sides, then compare. A mismatch
  // means characters were dropped, i.e. the value is not the key somebody thinks it is.
  const canonical = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (canonical(key.toString('base64')) !== canonical(trimmed)) {
    throw new KekError(
      `${name} contains characters that are not base64. Node drops them silently rather than ` +
        `failing, so this would otherwise have been accepted as a DIFFERENT key.`,
    );
  }
  return key;
}

/** `v3` → `3`. The environment writes `v`-prefixed; the database column is an integer. */
export function parseKekVersion(raw: string, name: string): number {
  const m = /^v([1-9][0-9]*)$/.exec(raw.trim());
  if (!m) {
    throw new KekError(`${name} must look like v1, v2, … (a positive version); got ${JSON.stringify(raw)}.`);
  }
  return Number(m[1]);
}

/** Which KEK new rows are sealed under. Reads never use this — see the module note. */
export function activeKekVersion(): number {
  return parseKekVersion(required('TENANT_KEK_ACTIVE_VERSION'), 'TENANT_KEK_ACTIVE_VERSION');
}

/**
 * The KEK a row's `kek_version` names.
 *
 * Absent → throws. There is no fallback to the active version and no default: CLAUDE.md
 * rule 7 forbids a fallback to a default credential, and here the fallback would not even
 * be a working one — it would be a wrong key producing an authentication failure one layer
 * deeper, where the cause is no longer visible.
 */
export function kekForVersion(version: number): Buffer {
  if (!Number.isInteger(version) || version < 1) {
    throw new KekError(`kek_version must be a positive integer; got ${JSON.stringify(version)}.`);
  }
  // The name is COMPUTED, so `scripts/guards/check-env-example.mjs` cannot see it as a
  // literal. It matches this family by the static prefix instead, and prints the prefix
  // in its summary line — see the note there before renaming these variables.
  const name = `TENANT_KEK_V${version}`;
  return decodeKeyMaterial(required(name), name);
}

/**
 * The active KEK and its version, for sealing.
 *
 * Returned together so a caller cannot seal under V1 and then write `kek_version = 2` by
 * reading the two separately.
 */
export function activeKek(): { version: number; key: Buffer } {
  const version = activeKekVersion();
  return { version, key: kekForVersion(version) };
}
