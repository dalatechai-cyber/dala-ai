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
 * no issuer and no recovery path, so it is worth a password manager entry the moment it is
 * first used in anger — which is not today, because nothing is deployed.
 */
import { randomBytes } from 'node:crypto';
import { KEY_BYTES } from '../../src/lib/crypto/envelope.ts';

const key = randomBytes(KEY_BYTES).toString('base64');
process.stdout.write(`${key}\n`);

if (process.stderr.isTTY) {
  process.stderr.write(
    [
      '',
      'That is one KEK. Put it in the platform environment as TENANT_KEK_V1 and set',
      'TENANT_KEK_ACTIVE_VERSION=v1. Nothing else reads it, and no row can be decrypted',
      'without it.',
      '',
      'It is not needed until a real credential exists to seal, and generating one today',
      'unblocks nothing on its own.',
      '',
    ].join('\n'),
  );
}
