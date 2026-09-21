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
 * ## THIS SCRIPT WRITES NOTHING. It prints SQL you must then execute.
 *
 * There is no database client in this file and there is no network call. Read that again
 * before trusting any line it prints, because on 2026-09-20 two seals were run against
 * Matrix, both reported `verified`, both exited 0, and `tenant_secrets` stayed empty — and
 * the channel's `token_status` was then set to `active` by hand on the strength of it. A
 * column claiming a credential that does not exist is worse than an empty one: the
 * `live_requires_active_token` CHECK reads the column, so it would have waved the channel
 * into `live` with no token to send with.
 *
 * ## It verifies its own output before printing it — and ONLY that
 *
 * After sealing, it decrypts the row it just built, through the same code path the worker
 * will use, and compares. So a KEK that is subtly wrong, or an AAD format that has drifted,
 * fails here rather than at the first customer message — where the symptom is a salon
 * going quiet with no error anybody can see.
 *
 * **That check is about the CRYPTO and says nothing about the database.** It used to report
 * itself as `seal: verified`, on stderr, gated on `isTTY` — so in a terminal it landed after
 * the SQL had scrolled past, as the last line on screen, which is where a person reads the
 * outcome; and when piped to a file it vanished entirely, so the one context that could have
 * machine-checked it got nothing. The scope of a success message has to match the scope of
 * what was done, and where it is printed decides what it will be read to mean.
 */
import { readFileSync } from 'node:fs';
import { aadFor, channelKeyOf, openForRow, sealForRow } from '../../src/lib/crypto/envelope.ts';
import { activeKek } from '../../src/lib/crypto/kek.ts';
import { SECRET_KINDS } from '../../src/lib/secrets/tenantSecret.ts';

// Imported, never re-listed. A second copy of this list is how `web_mint_secret` came to
// be accepted by the database, named by the runtime and refused by this script.
const KINDS = SECRET_KINDS;
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

/**
 * When this credential dies, from `debug_token`. Optional, and NOT remembered across a
 * re-seal: a new token has new clocks, so carrying the previous row's dates forward would
 * attribute the OLD credential's expiry to the new one — a confident wrong date, which is
 * worse than the blank this platform already knows how to report as unknown.
 *
 * `--expires-at never` is Meta's `expires_at: 0` for a Page token minted from a long-lived
 * user token. It is stored as NULL, the same as unknown, because the checker warns on
 * neither and inventing a sentinel far-future date would be a value nobody could tell from
 * a real one.
 */
function expiryArg(name: string): string {
  const raw = arg(name);
  if (raw === undefined || raw === 'never') return 'null';
  // ISO 8601 ONLY, and the strictness is the point. `Date.parse` is lenient in a way that
  // is actively dangerous here: measured, `20 December` parses to 2001-12-20 and `Dec 20`
  // to the same, so an operator typing a date the way a person writes one would store a
  // timestamp twenty-five years in the past. The checker would then report that credential
  // as lapsed nine thousand days ago and page about it — a confidently wrong alert, which
  // is the exact failure this column was added to prevent. Refusing is the only safe
  // reading of an ambiguous date.
  // ascii-safe: an ISO timestamp, never customer text.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    die(`--${name} must be ISO 8601 (2026-12-20, or 2026-12-20T00:00:00Z), or 'never'. Got ${JSON.stringify(raw)}. `
      + 'Date.parse would accept "20 December" and store 2001-12-20, so this refuses rather than guesses.');
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) die(`--${name} is ISO-shaped but not a real date: ${JSON.stringify(raw)}`);
  return `'${new Date(ms).toISOString()}'::timestamptz`;
}

const expiresAtSql = expiryArg('expires-at');
const dataAccessSql = expiryArg('data-access-expires-at');

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
    // First line of the payload, so it survives being piped to a file and is the first
    // thing read when the SQL is pasted. The stderr notice below can be redirected away;
    // this cannot be separated from the statement it is warning about.
    '-- NOTHING HAS BEEN WRITTEN TO THE DATABASE. Execute the statement below, then',
    `-- confirm with:  select kind, kek_version from tenant_secrets where tenant_id = '${tenantId}';`,
    `-- ${kind} for tenant ${tenantId}, channel ${channelKeyOf(channelId)}`,
    `-- Sealed under TENANT_KEK_V${version}. The secret itself appears nowhere below.`,
    'insert into tenant_secrets',
    '  (tenant_id, channel_id, kind, ciphertext, wrapped_dek, kek_version, aad, status,',
    '   expires_at, data_access_expires_at)',
    'values',
    `  ('${tenantId}'::uuid, ${channelSql}, '${kind}',`,
    `   ${hex(sealed.ciphertext)},`,
    `   ${hex(sealed.wrappedDek)},`,
    `   ${version}, '${aad}', 'active',`,
    `   ${expiresAtSql}, ${dataAccessSql})`,
    'on conflict (tenant_id, channel_key, kind) do update set',
    '  ciphertext = excluded.ciphertext,',
    '  wrapped_dek = excluded.wrapped_dek,',
    '  kek_version = excluded.kek_version,',
    '  aad = excluded.aad,',
    "  status = 'active',",
    // Overwritten, never merged: see `expiryArg`. A re-seal that omits the flags stores
    // NULL, which reads as "not known" — correct for a token whose clocks nobody recorded,
    // and the one reading that cannot be mistaken for a promise.
    '  expires_at = excluded.expires_at,',
    '  data_access_expires_at = excluded.data_access_expires_at,',
    '  last_error_code = null;',
    '',
  ].join('\n'),
);

// Unconditional, and never gated on isTTY: the run that most needs this notice is the one
// piped into a file, where the old message was suppressed precisely when nobody was watching.
// It names what was checked (the crypto) and what was not (the write), in that order.
process.stderr.write(
  '\nseal: the ciphertext above decrypts back to the input under the active KEK.'
  + '\nseal: NOTHING WAS WRITTEN. This script has no database client — it printed SQL.'
  + `\nseal: run it, then confirm: select kind, kek_version from tenant_secrets where tenant_id = '${tenantId}';\n`,
);
