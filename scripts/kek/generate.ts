/**
 * Generate a key-encryption key.
 *
 *     node scripts/kek/generate.ts
 *
 * Prints one 32-byte key, base64, to stdout and nothing else — so it can be piped, and so
 * a terminal scrollback is the only copy this script creates. It writes no file, touches
 * no environment, and contacts nothing.
 *
 * ## What this key is, concretely
 *
 * It is not a Meta credential and it is not issued by anyone. It is 32 random bytes that
 * this platform generates, holds in its own environment, and uses to wrap the per-row data
 * keys that encrypt tenant credentials. Nothing outside this repository knows it exists.
 *
 * ## Losing it is unrecoverable, and that is the whole operational point
 *
 * `tenant_secrets.wrapped_dek` is the only copy of each data key, and the KEK is the only
 * thing that opens it. Lose the KEK and every tenant's stored token is permanently
 * undecryptable — not lost data, but every tenant's ability to *send*, recoverable only by
 * re-running the Business-Settings token dance with every client.
 *
 * D-017 accepted single-owner risk and deferred escrow. That decision was about the
 * *provider accounts*, whose recovery emails and codes are a real mitigation. This key has
 * no issuer and no recovery path.
 *
 * ## Store it BEFORE you paste it anywhere (D-107)
 *
 * This line used to end "worth a password manager entry the moment it is first used in
 * anger — which is not today, because nothing is deployed." Both halves expired on
 * 2026-09-06: `TENANT_KEK_V1` seals tenant #0's live Page token and the runtime has opened
 * it. On 2026-09-21 the founder went looking for that value and could not get it back —
 * Vercel redacts a secret on `env pull` and the dashboard will not reveal it. **A key that
 * is working in production is not a key you can read.** The scrollback this script creates
 * is the only copy there will ever be, so it goes in the password manager first.
 */
import { randomBytes } from 'node:crypto';
import { KEY_BYTES } from '../../src/lib/crypto/envelope.ts';

const key = randomBytes(KEY_BYTES).toString('base64');
process.stdout.write(`${key}\n`);

if (process.stderr.isTTY) {
  process.stderr.write(
    [
      '',
      'That is one KEK. Save it somewhere durable NOW, before it goes anywhere else:',
      'once it is set in Vercel it cannot be read back out, and this scrollback is the',
      'only other copy.',
      '',
      'Put it in the platform environment under the next UNUSED version — TENANT_KEK_V3',
      'if V1 and V2 are taken — and then set TENANT_KEK_ACTIVE_VERSION to match.',
      '',
      'NEVER write it over an existing TENANT_KEK_Vn. Each sealed row names the version it',
      'was sealed under and is opened with THAT key, so overwriting one orphans every row',
      'that points at it, permanently, and nothing says so until the next send fails.',
      'Retiring a version as ACTIVE does not retire its key: leave every old value in',
      'place for as long as any row still names it.',
      '',
    ].join('\n'),
  );
}
