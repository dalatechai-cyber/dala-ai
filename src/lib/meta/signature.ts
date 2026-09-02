/**
 * X-Hub-Signature-256 verification for Meta webhooks.
 *
 * Four things here are load-bearing, each with a specific failure mode:
 *
 *  1. **RAW BYTES, not a string.** The HMAC is over the exact bytes Meta sent. This takes
 *     a Buffer from `Buffer.from(await req.arrayBuffer())` rather than `await req.text()`:
 *     `text()` decodes to UTF-16 and re-encodes, which is byte-identical only for
 *     well-formed UTF-8 — a needless assumption on a signature path, and this platform's
 *     bodies are Mongolian Cyrillic multibyte UTF-8, where one malformed sequence silently
 *     becomes U+FFFD and corrupts the signed bytes. `JSON.parse` happens only AFTER this
 *     returns ok.
 *
 *  2. **Timing-safe comparison.** `===` on a digest leaks, byte by byte, how much of a
 *     forged signature was right — which is enough to construct a valid one.
 *     `timingSafeEqual` THROWS on unequal-length buffers, so length is checked first and
 *     the call is wrapped: an uncaught throw here would 500 on a hostile request.
 *
 *  3. **A SET of secrets, not one.** META_APP_SECRETS maps app_slug to secret. Rotation,
 *     staging, and the dala-legacy cutover app each hold a different secret, and a request
 *     signed with any of them is genuine. The `[app]` route slug says which to expect
 *     first; on a miss we try every configured secret, and the caller records which one
 *     matched so §3.3's app-vs-identity cross-check can run.
 *
 *  4. **A missing secret returns false, never true.** "No fallback to a default credential"
 *     extends to "no fallback to no credential". There is no environment in which
 *     signature verification is off.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requiredJsonMap } from '../env.ts';

export type SignatureResult =
  | { ok: true; matchedAppSlug: string }
  | { ok: false; reason: 'sig_missing' | 'sig_invalid' };

/** Flatten {slug: secret | secret[]} to [slug, secret] pairs, preferring `preferSlug`. */
function candidatePairs(preferSlug: string | undefined): Array<[string, string]> {
  const map = requiredJsonMap('META_APP_SECRETS');
  const pairs: Array<[string, string]> = [];
  for (const [slug, value] of Object.entries(map)) {
    const secrets = Array.isArray(value) ? value : [value];
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret !== '') pairs.push([slug, secret]);
    }
  }
  if (pairs.length === 0) {
    throw new Error('META_APP_SECRETS parsed to zero usable secrets. Refusing to accept anything.');
  }
  if (preferSlug === undefined) return pairs;
  return [...pairs.filter(([s]) => s === preferSlug), ...pairs.filter(([s]) => s !== preferSlug)];
}

function digestsMatch(expectedHex: string, providedHex: string): boolean {
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
 * @param rawBody   exact bytes from `Buffer.from(await req.arrayBuffer())`
 * @param header    the `X-Hub-Signature-256` header, of the form `sha256=<hex>`
 * @param appSlug   the `[app]` route segment; selects which secret to try first
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | null,
  appSlug?: string,
): SignatureResult {
  const prefix = 'sha256=';
  if (!header || typeof header !== 'string' || !header.startsWith(prefix)) {
    return { ok: false, reason: 'sig_missing' };
  }
  const provided = header.slice(prefix.length).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return { ok: false, reason: 'sig_invalid' }; // ascii-safe: hex digest

  let matched: string | null = null;
  // Runs to completion rather than breaking, so the work done does not vary with which
  // secret matched.
  for (const [slug, secret] of candidatePairs(appSlug)) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (digestsMatch(expected, provided) && matched === null) matched = slug;
  }

  return matched === null ? { ok: false, reason: 'sig_invalid' } : { ok: true, matchedAppSlug: matched };
}

/** GET verify handshake. META_VERIFY_TOKENS is a map {app_slug: token | token[]}. */
export function verifyHandshakeToken(appSlug: string, token: string | null): boolean {
  if (!token) return false;
  const map = requiredJsonMap('META_VERIFY_TOKENS');
  const configured = map[appSlug];
  if (configured === undefined) return false;
  const tokens = Array.isArray(configured) ? configured : [configured];
  // Compare every candidate in constant time; never short-circuit on the first mismatch.
  let ok = false;
  for (const candidate of tokens) {
    if (typeof candidate !== 'string' || candidate.length !== token.length) continue;
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) ok = true;
  }
  return ok;
}
