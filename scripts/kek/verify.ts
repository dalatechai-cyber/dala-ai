/**
 * Open one sealed credential through the runtime's own loader, and say whether it worked.
 *
 *     NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_PUBLISH=… TENANT_KEK_V2=… \
 *       node scripts/kek/verify.ts --tenant matrix-eco-salon --channel 1520409424715591 --kind page_token
 *
 * ## Why this exists
 *
 * `seal.ts` proves the row it just built decrypts, and its own header is careful to say
 * that check is about the CRYPTO and says nothing about the database. `tenant_secrets`
 * stayed empty through two seals that both reported `verified` and exited 0. So between
 * "the seal verified" and "the worker can send" there was no command at all — the next
 * thing that would have opened Matrix's token was a live customer message, with the
 * ancestor already switched off. This is that missing command.
 *
 * It calls `loadTenantSecret`, the function the delivery path calls, rather than
 * reimplementing the read. A second copy would be the §6.2.6 duplication `seal.ts` refuses
 * for the same reason, and it is the copy that would disagree about which column decrypts.
 * In particular the loader re-derives the AAD from the identity it was ASKED about and
 * compares it against the row's stored `aad` — so pointing this at the wrong channel is
 * reported as `secret_undecryptable`, exactly as it would be at 3am.
 *
 * ## It never prints the secret, and it writes NOTHING
 *
 * Not the value, not a prefix. A length and a version, which is the shape rule
 * `scripts/preflight.ts` already works to.
 *
 * It deliberately does not stamp `last_ok_at`, although the delivery path does on every
 * successful open. That column currently means *the runtime opened this for a real
 * delivery*; a verify script writing it would make it mean *something opened this
 * somewhere*, and the two are worth telling apart on exactly the day somebody asks whether
 * a channel has ever really sent. A column whose meaning is widened by a diagnostic is
 * D-064 arriving from the tool built to check for it.
 *
 * ## What a PASS here does and does not establish
 *
 * It establishes that this row's ciphertext, its stored binding, and the KEK **in this
 * shell** agree — the whole chain the worker walks, minus two things it cannot see:
 *
 *  - **The KEK in the deployment.** This reads `TENANT_KEK_V<n>` from the environment it is
 *    run in. If Vercel holds a different 32-byte value under the same name, this passes and
 *    production still cannot open the row. Nothing here can tell them apart.
 *  - **Whether Meta accepts the token.** A truncated paste seals, self-checks and opens
 *    perfectly; it is a valid string that is not a valid credential. Only a Graph call
 *    settles that, and this script deliberately makes none: it would have to hold the
 *    plaintext to do it, and a diagnostic that can leak a credential is a worse trade than
 *    a second command. `GET /{page-id}?fields=name` is the cheapest one that settles it.
 */
import { channelKeyOf } from '../../src/lib/crypto/envelope.ts';
import { loadTenantSecret, SECRET_KINDS, type SecretKind } from '../../src/lib/secrets/tenantSecret.ts';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';

function die(msg: string): never {
  process.stderr.write(`verify: ${msg}\n`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// The tenant is an ARGUMENT. A client is rows, never a code path, and a script that hard
// codes one is the same violation one directory over.
const tenantArg = arg('tenant');
const channelArg = arg('channel');
const kindArg = arg('kind') ?? 'page_token';
if (tenantArg === undefined || channelArg === undefined) {
  die('usage: --tenant <slug|uuid> --channel <external_id|uuid|none> [--kind page_token]');
}
// Checked against the runtime's own list rather than cast into it. A typo here would
// otherwise reach the loader, find no row, and report `token_missing` — which reads as
// "the credential was never sealed" and sends the operator to re-run seal.ts.
if (!(SECRET_KINDS as readonly string[]).includes(kindArg)) {
  die(`unknown --kind ${JSON.stringify(kindArg)}; expected one of ${SECRET_KINDS.join(', ')}`);
}
const kind = kindArg as SecretKind;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // ascii-safe: a UUID

const db = supabasePublish();

const tenantFilter = UUID.test(tenantArg) ? 'id' : 'slug';
const { data: tenantRow, error: tenantErr } = await db
  .from('tenants').select('id, slug').eq(tenantFilter, tenantArg).maybeSingle();
if (tenantErr !== null) die(`tenants unreadable: ${tenantErr.message}`);
if (tenantRow === null) die(`no tenant matching ${tenantFilter} = ${tenantArg}`);
const tenant = tenantRow as { id: string; slug: string };

// `none` is the platform-wide binding — the nil channel key, which is how `app_secret`
// and friends are addressed. Spelled out rather than defaulted, because a channel this
// script GUESSED would be reported as a decryption failure and read as a broken token.
let channelId: string | null = null;
let channelLabel = 'none (platform-wide)';
if (channelArg !== 'none') {
  const channelFilter = UUID.test(channelArg) ? 'id' : 'external_id';
  const { data: chRow, error: chErr } = await db
    .from('tenant_channels').select('id, external_id, delivery_mode, token_status')
    .eq('tenant_id', tenant.id).eq(channelFilter, channelArg).maybeSingle();
  if (chErr !== null) die(`tenant_channels unreadable: ${chErr.message}`);
  if (chRow === null) die(`no channel matching ${channelFilter} = ${channelArg} for tenant ${tenant.slug}`);
  const ch = chRow as { id: string; external_id: string; delivery_mode: string; token_status: string };
  channelId = ch.id;
  channelLabel = `${ch.external_id} (${ch.id}) — delivery_mode ${ch.delivery_mode}, token_status ${ch.token_status}`;
}

process.stdout.write(`verify: tenant ${tenant.slug} (${tenant.id})\n`);
process.stdout.write(`verify: channel ${channelLabel}\n`);
process.stdout.write(`verify: binding ${tenant.id}|${channelKeyOf(channelId)}|${kind}\n\n`);

const outcome = await loadTenantSecret(db, { tenantId: tenant.id, channelId, kind });

if (!outcome.ok) {
  process.stdout.write(`FAILED  ${outcome.code}${outcome.retryable ? ' (retryable)' : ''}\n`);
  process.stdout.write(`        ${outcome.detail}\n\n`);
  // Named here rather than left to the reader, because each of these sends you to a
  // different place and the codes are not self-explanatory at the moment you need them.
  const WHERE: Record<string, string> = {
    token_missing: 'no row for this exact (tenant, channel, kind). seal.ts prints SQL; check it was actually RUN',
    token_revoked: 'the row is revoked: outbound stays halted until a new credential replaces it',
    kek_unavailable: 'this shell holds no key for the version the ROW names. Every tenant sealed under it is affected, and the fix is an environment, not a row',
    secret_undecryptable: 'the row exists and does not open under this key with this binding — a wrong --channel, or a KEK that is not the one it was sealed under',
    secret_malformed: 'it decrypted, and what came out cannot be sent in a header',
    secret_unreadable: 'the read itself failed; this is the only code that is transient',
  };
  const where = WHERE[outcome.code];
  if (where !== undefined) process.stdout.write(`        ${where}\n`);
  process.exit(1);
}

process.stdout.write(`OPENED  kek v${outcome.kekVersion}, status ${outcome.status}, ${outcome.secret.length} characters\n\n`);
process.stdout.write('Nothing was written — last_ok_at is still whatever it was, on purpose (see the header).\n');
process.stdout.write('This proves the ciphertext, the binding and the KEK IN THIS SHELL agree. It does NOT prove\n');
process.stdout.write('the deployment holds the same key, and it does NOT prove Meta accepts the token: a truncated\n');
process.stdout.write('paste opens perfectly. Compare the character count against a token you know is whole, and\n');
process.stdout.write('settle the rest with a Graph call.\n');
