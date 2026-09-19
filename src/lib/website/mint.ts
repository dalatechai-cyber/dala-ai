/**
 * Deriving the tenant for the website channel.
 *
 * ## The rule this is built against, stated precisely
 *
 * Rule 1: the tenant is derived server-side from a registry with a unique key — never from
 * a request body, a header or an env var. It is easy to read that as a rule about WHERE in
 * the request the identifier sits, and that reading is wrong. Meta's Page id arrives in the
 * BODY, at `entry[].id`. What makes reading it legal is that
 * `src/app/api/webhooks/meta/[app]/route.ts` takes the raw bytes at step 1 and runs
 * `verifyMetaSignature` at step 2 — before `JSON.parse` at step 3 — against a secret only
 * Meta holds, and that `signature.ts` returns `matchedAppSlug`: the slug whose secret
 * ACTUALLY VERIFIED. The rule's operative content is *derive the tenant from an attested
 * signal*.
 *
 * A browser holds no secret by construction, so no field a widget sends can be attested:
 * not a site key, not the Origin header, not a path segment, not a cookie.
 * `Matrix-Chatbot/lib/cors.js` says the same thing about the control people reach for
 * first — *"CORS is a browser control... It is NOT an authorization gate and must never be
 * relied on as one."* A public site key is identification dressed as derivation: anyone who
 * reads the page source can mint as that tenant and spend that tenant's budget, which is
 * rule 2's harm — another tenant's money — arrived at through rule 1's hole.
 *
 * ## So the browser is never asked
 *
 * The tenant's own server signs a mint request with a per-tenant secret. The platform
 * derives the tenant from WHICH secret verified, mints an opaque token, and hands it back.
 * Every later message carries only that token, and the tenant comes from looking it up in
 * `web_sessions` — a registry, server-side, with a unique key, holding a value the platform
 * itself issued.
 *
 * ## Why a caller-supplied channel id is NOT a violation
 *
 * This is the distinction to keep, because on its face it looks like exactly what rule 1
 * forbids. The mint request carries `X-Dala-Channel`, and the channel id is not secret.
 *
 * It SELECTS A CANDIDATE. It does not determine the answer. A caller naming another
 * tenant's channel gets that tenant's secret loaded and tried, and the HMAC fails, and the
 * request is refused — so the id narrows which secret to attempt and the signature decides.
 * That is `verifyMetaSignature`'s `appSlug` parameter, which the `[app]` route segment also
 * supplies from the URL: it "selects which secret to try first" and a miss falls through to
 * a refusal. JWT's `kid` header is the same construction. The alternative — trying every
 * tenant's secret — is equally sound and O(tenants) decryptions per mint; this is O(1), and
 * both derive the tenant from the signature.
 *
 * What it must not do is LEAK. An unknown channel and a bad signature are reported to the
 * caller as one refusal, so this endpoint cannot be used to enumerate which channel ids
 * exist. The distinction is kept in the log, where it is a diagnosis rather than an oracle.
 */
import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

/** What a caller is told. Deliberately coarser than what is logged. */
export type MintRefusal =
  | 'mint_unsigned'      // no signature header, or malformed
  | 'mint_unauthorised'  // unknown channel, wrong secret, revoked secret — ONE answer
  | 'mint_stale'         // the signed timestamp is outside the replay window
  | 'mint_unavailable';  // we could not decide; fail closed (rule 2)

/** What is written to the log. Never returned over the wire. */
export type MintDiagnosis =
  | 'header_missing'
  | 'header_malformed'
  | 'channel_unknown'
  | 'channel_not_web'
  | 'channel_inactive'
  | 'secret_missing'
  | 'secret_revoked'
  | 'signature_mismatch'
  | 'timestamp_missing'
  | 'timestamp_malformed'
  | 'timestamp_outside_window'
  | 'secret_unreadable'
  // The channel exists and is healthy, but its `delivery_mode` is not `live`. Separate
  // from `channel_inactive`, which is about `status`: the two columns are orthogonal —
  // status is health, delivery_mode is where the channel sits in the cutover — and
  // collapsing them would send a reader to the wrong column.
  | 'channel_not_delivering'
  // Raised by `mintJob`, which is the only caller. They live in this union rather than as
  // loose strings because `refuse()` no longer accepts a bare string: a union with a
  // `| string` escape hatch beside it constrains nothing, and every one of these was
  // passing typecheck for that reason alone.
  | 'rate_limited'
  | 'rate_unavailable'
  | 'turnstile_unavailable'
  | 'turn_cap_missing'
  | 'session_insert_failed';

export type MintVerification =
  | { ok: true }
  | { ok: false; refusal: MintRefusal; diagnosis: MintDiagnosis };

/**
 * How far the signed timestamp may be from ours.
 *
 * A signature with no timestamp is valid for ever, so a mint request captured once — from a
 * proxy log, a crash dump, an error report — mints sessions indefinitely. The window is
 * symmetric because the tenant's server clock can be ahead of ours as easily as behind, and
 * a one-sided window turns a clock a minute fast into a channel that cannot mint at all.
 *
 * Five minutes rather than five seconds: this is a server-to-server call whose latency is
 * ordinary but whose clock skew is not ours to control, and the thing being bounded is a
 * replay window, not a race.
 */
export const MINT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const SIG_PREFIX = 'sha256=';

function digestsMatch(expectedHex: string, providedHex: string): boolean {
  // Copied rather than imported from meta/signature.ts: sharing it would couple the website
  // channel's refusals to Meta's, and the next person widening one for Meta's sake would
  // widen this. The five lines are not the valuable part; the property is.
  try {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(providedHex, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Does `header` verify `rawBody` under `secret`, and is the signed timestamp current?
 *
 * @param rawBody   exact bytes from `Buffer.from(await req.arrayBuffer())`. NOT `req.text()`
 *                  — that decodes to UTF-16 and re-encodes, and one malformed sequence
 *                  becomes U+FFFD and corrupts the signed bytes. The same reason
 *                  meta/signature.ts says so at length.
 * @param header    `X-Dala-Signature-256`, of the form `sha256=<hex>`
 * @param secret    the tenant's mint secret, already decrypted
 * @param signedAt  the `issued_at` INSIDE rawBody, so the timestamp is covered by the HMAC.
 *                  Passing a header value here would let an attacker replay an old body
 *                  with a fresh timestamp.
 * @param now       injected; a clock read inside a verifier cannot be tested
 */
export function verifyMintSignature(
  rawBody: Buffer,
  header: string | null,
  secret: string,
  signedAt: Date | null,
  now: Date,
): MintVerification {
  if (typeof header !== 'string' || header === '') {
    return { ok: false, refusal: 'mint_unsigned', diagnosis: 'header_missing' };
  }
  if (!header.startsWith(SIG_PREFIX)) {
    return { ok: false, refusal: 'mint_unsigned', diagnosis: 'header_malformed' };
  }
  const provided = header.slice(SIG_PREFIX.length).trim().toLowerCase();
  // ascii-safe: a hex digest is never Cyrillic, so rule 6 does not reach this one.
  if (!/^[0-9a-f]+$/.test(provided)) {
    return { ok: false, refusal: 'mint_unsigned', diagnosis: 'header_malformed' };
  }
  if (secret === '') {
    // "No fallback to a default credential" extends to "no fallback to no credential".
    return { ok: false, refusal: 'mint_unauthorised', diagnosis: 'secret_missing' };
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!digestsMatch(expected, provided)) {
    return { ok: false, refusal: 'mint_unauthorised', diagnosis: 'signature_mismatch' };
  }

  // The timestamp is checked AFTER the signature, on purpose. Checking it first would
  // answer "is this timestamp fresh?" for an unauthenticated caller, and the answer to an
  // unauthenticated caller is always the same answer.
  if (signedAt === null) {
    return { ok: false, refusal: 'mint_stale', diagnosis: 'timestamp_missing' };
  }
  const delta = signedAt.getTime();
  if (!Number.isFinite(delta)) {
    return { ok: false, refusal: 'mint_stale', diagnosis: 'timestamp_malformed' };
  }
  if (Math.abs(now.getTime() - delta) > MINT_CLOCK_SKEW_MS) {
    return { ok: false, refusal: 'mint_stale', diagnosis: 'timestamp_outside_window' };
  }

  return { ok: true };
}

/**
 * A fresh session token and the hash that is stored in its place.
 *
 * 256 bits from the CSPRNG, base64url so it survives a header and a JSON body unescaped.
 * Only the SHA-256 goes to the database: a read of `web_sessions` must not yield a usable
 * session, which is the reason a password column does not exist either. There is no
 * key-stretching here and none is wanted — a 256-bit random value has no structure to
 * attack, so the only thing a work factor would buy is latency on every message.
 */
export function newSessionToken(): { token: string; tokenSha256: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenSha256: sha256(token) };
}

/** The lookup key for a token presented on a later request. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Hash a client address for `web_sessions.client_ip_hash` and the rate-limit bucket.
 *
 * Salted with a platform secret, because an unsalted IP hash is reversible: the whole IPv4
 * space is 2^32 and a rainbow table for it is minutes of work. The salt is the KEK-adjacent
 * kind of value — platform-scoped, from the environment (rule 7) — and it is passed in
 * rather than read here so that this module has no environment dependency and stays
 * testable.
 *
 * Truncated to 16 bytes: it is a bucket key and a forensic breadcrumb, not a proof.
 */
export function hashClientIp(ip: string, salt: string): Buffer {
  return createHash('sha256').update(salt, 'utf8').update('\x00').update(ip, 'utf8').digest().subarray(0, 16);
}
