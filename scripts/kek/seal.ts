/**
 * Seal one credential into the SQL for a `tenant_secrets` row.
 *
 *     printf %s "$TOKEN" | node scripts/kek/seal.ts \
 *       --tenant <uuid> --channel <uuid|none> --kind page_token
 *
 * The secret is read from **stdin, never from an argument**. Command lines are visible in
 * `ps` to every process on the box, land in shell history, and are captured by most CI
 * log collectors. There is no `--secret` flag and there should never be one.
 *
 * ## Why this exists as a script rather than an admin route
 *
 * V1.md defers the probe-token onboarding flow to tenant #3 — the first two tenants are
 * bound by hand — and there is no Supabase project and no admin surface to host a route
 * on. What is actually needed to unblock a first send is the ability to turn a token into
 * a row, and that is one command and a paste into a SQL editor.
 *
 * It imports the same `envelope.ts` the runtime reads with. A second copy of the crypto
 * here — the obvious way to write a standalone script — is exactly the duplication §6.2.6
 * forbids, and would be the copy that silently disagrees about the AAD format.
 *
 * ## It verifies its own output before printing it
 *
 * After sealing, it decrypts the row it just built, through the same code path the worker
 * will use, and compares. So a KEK that is subtly wrong, or an AAD format that has drifted,
 * fails here rather than at the first customer message — where the symptom is a salon
 * going quiet with no error anybody can see.
 */
import { readFileSync } from 'node:fs';
import { aadFor, channelKeyOf, openForRow, sealForRow } from '../../src/lib/crypto/envelope.ts';
import { activeKek } from '../../src/lib/crypto/kek.ts';

const KINDS = ['page_token', 'ig_token', 'app_secret', 'sip_password', 'booking_webhook_secret'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function die(message: string): never {
  process.stderr.write(`seal: ${message}\n`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv.some((a) => a === '--secret' || a.startsWith('--secret='))) {
  die('the secret is read from stdin, never from an argument — it would be visible in ps and shell history');
}

const tenantId = (arg('tenant') ?? '').toLowerCase();
if (!UUID.test(tenantId)) die('--tenant must be a UUID');

const channelArg = arg('channel') ?? '';
if (channelArg === '') die("--channel must be a UUID, or 'none' for a platform-wide kind");
const channelId = channelArg.toLowerCase() === 'none' ? null : channelArg.toLowerCase();
if (channelId !== null && !UUID.test(channelId)) die("--channel must be a UUID or 'none'");

const kind = arg('kind') ?? '';
if (!(KINDS as readonly string[]).includes(kind)) die(`--kind must be one of: ${KINDS.join(', ')}`);

// fd 0, read whole. `printf %s` rather than `echo` at the call site, but a trailing
// newline from a heredoc is the likelier mistake, so it is trimmed and reported.
let secret: string;
try {
  secret = readFileSync(0, 'utf8');
} catch {
  die('no secret on stdin. Pipe it in: printf %s "$TOKEN" | node scripts/kek/seal.ts …');
}
const trimmed = secret.replace(/\r?\n$/, '');
if (trimmed !== secret) process.stderr.write('seal: note — a trailing newline was stripped from stdin.\n');
if (trimmed === '') die('the secret on stdin is empty');
if (trimmed !== trimmed.trim()) die('the secret has leading or trailing whitespace; refusing to seal it as-is');
if (/[\u0000-\u001F\u007F]/.test(trimmed)) die('the secret contains control characters and could not go in a header');

const { version, key } = activeKek();
const aad = aadFor({ tenantId, channelId, kind });
const sealed = sealForRow(Buffer.from(trimmed, 'utf8'), key, aad);

// The self-check: open what was just sealed, through the runtime's own path.
const reopened = openForRow({ ...sealed, kek: key, aad });
if (reopened.toString('utf8') !== trimmed) die('the sealed row did not decrypt back to the input — refusing to emit SQL');
reopened.fill(0);

const hex = (b: Buffer) => `'\\x${b.toString('hex')}'::bytea`;
const channelSql = channelId === null ? 'null' : `'${channelId}'::uuid`;

process.stdout.write(
  [
    `-- ${kind} for tenant ${tenantId}, channel ${channelKeyOf(channelId)}`,
    `-- Sealed under TENANT_KEK_V${version}. The secret itself appears nowhere below.`,
    'insert into tenant_secrets',
    '  (tenant_id, channel_id, kind, ciphertext, wrapped_dek, kek_version, aad, status)',
    'values',
    `  ('${tenantId}'::uuid, ${channelSql}, '${kind}',`,
    `   ${hex(sealed.ciphertext)},`,
    `   ${hex(sealed.wrappedDek)},`,
    `   ${version}, '${aad}', 'active')`,
    'on conflict (tenant_id, channel_key, kind) do update set',
    '  ciphertext = excluded.ciphertext,',
    '  wrapped_dek = excluded.wrapped_dek,',
    '  kek_version = excluded.kek_version,',
    '  aad = excluded.aad,',
    "  status = 'active',",
    '  last_error_code = null;',
    '',
  ].join('\n'),
);

if (process.stderr.isTTY) {
  process.stderr.write('\nseal: verified — this row decrypts back to the input under the active KEK.\n');
}
