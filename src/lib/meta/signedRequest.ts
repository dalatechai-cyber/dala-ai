/**
 * Meta's `signed_request`, as it arrives on the Data Deletion Request callback.
 *
 * A different envelope from `X-Hub-Signature-256`, on a different surface, with the same
 * app secret — and it must not be confused with it. The webhook signs the raw HTTP body
 * with a header; this signs ONE FORM FIELD with its own embedded signature, and the field
 * is what Meta posts when a person tells Facebook to delete their data.
 *
 * ## The shape
 *
 *   signed_request := base64url(HMAC-SHA256(app_secret, <encodedPayload>)) "." <encodedPayload>
 *   encodedPayload := base64url(JSON)
 *
 * Two details in there are the ones implementations get wrong:
 *
 *  1. **The HMAC is over the ENCODED payload string**, the base64url text itself — not
 *     over the decoded JSON. Decoding first and re-encoding to check produces a different
 *     string whenever Meta's encoder and yours disagree about padding, and the signature
 *     then never matches. So the encoded half is kept as received and hashed as ASCII.
 *  2. **`algorithm` is in the payload and must be checked.** It is attacker-adjacent data
 *     describing how the attacker's own message was signed. We verify with HMAC-SHA256
 *     unconditionally and then refuse a payload that claims anything else, rather than
 *     dispatching on it — dispatching on a self-declared algorithm is the JWT `alg: none`
 *     bug with a different spelling.
 *
 * ## Base64 does not fail. That is the trap this module inherits from `kek.ts`.
 *
 * `Buffer.from(s, 'base64url')` NEVER throws. Junk characters are dropped and you get a
 * shorter buffer, silently — so a malformed signature decodes to *something*, compares
 * unequal, and is reported as "wrong signature" when the truth is "not a signature". The
 * distinction matters on a callback whose failure mode is a privacy request we never
 * recorded, so both halves are re-encoded and compared before anything else happens.
 *
 * ## Every configured app secret is tried
 *
 * Same reason as `signature.ts`: rotation, staging, and the dala-legacy cutover app each
 * hold a different secret, and a request signed with any of them is genuine. The matched
 * slug is returned because it is the only evidence of WHICH app the person's id belongs
 * to — and an app-scoped id from one app means nothing in another.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requiredJsonMap } from '../env.ts';

export type SignedRequestRefusal =
  /** Not `<sig>.<payload>` — no dot, too many dots, or an empty half. */
  | 'malformed'
  /** A half is not base64url. Node would have decoded it to something shorter. */
  | 'not_base64url'
  /** The payload decoded, but is not a JSON object. */
  | 'payload_not_json'
  /** The payload declares an algorithm we did not verify with. */
  | 'algorithm_unexpected'
  /** No configured app secret produces this signature. */
  | 'signature_invalid'
  /** Verified, but carries no user id — there is nobody to erase. */
  | 'user_id_missing';

export type SignedRequestPayload = {
  /** The APP-SCOPED user id (ASID). Not a PSID. See `privacy/erasure.ts`. */
  userId: string;
  /** Meta's `issued_at`, UNIX **seconds**, or null when absent or unusable. */
  issuedAt: Date | null;
  /** Which configured app secret verified it — i.e. which app the ASID belongs to. */
  matchedAppSlug: string;
};

export type SignedRequestResult =
  | { ok: true; payload: SignedRequestPayload }
  | { ok: false; refusal: SignedRequestRefusal };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decode base64url, refusing anything that would have been silently repaired.
 *
 * Meta sends unpadded base64url. Padding is stripped before decoding, so a proxy that
 * pads the SIGNATURE half changes nothing — that half is only ever decoded. It does not
 * rescue a padded PAYLOAD half: the HMAC's input is the literal string as received, so a
 * padded payload is a different signed string and comes back `signature_invalid`. That is
 * the true statement; the alternative is accepting a payload nobody signed.
 */
function decodeStrict(part: string): Buffer | null {
  const trimmed = part.replace(/=+$/, '');
  if (trimmed === '' || !BASE64URL.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, 'base64url');
  if (bytes.length === 0) return null;
  return bytes.toString('base64url') === trimmed ? bytes : null;
}

/** Flatten {slug: secret | secret[]} to [slug, secret] pairs. Order is not significant. */
function appSecretPairs(): Array<[string, string]> {
  const map = requiredJsonMap('META_APP_SECRETS');
  const pairs: Array<[string, string]> = [];
  for (const [slug, value] of Object.entries(map)) {
    for (const secret of Array.isArray(value) ? value : [value]) {
      if (typeof secret === 'string' && secret !== '') pairs.push([slug, secret]);
    }
  }
  if (pairs.length === 0) {
    throw new Error('META_APP_SECRETS parsed to zero usable secrets. Refusing to accept anything.');
  }
  return pairs;
}

function equalBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * @param signedRequest the raw value of the `signed_request` form field
 * @throws if META_APP_SECRETS is absent or unusable — a configuration failure, never a
 *         refusal, because "we could not check" must not be logged as "they failed".
 */
export function verifySignedRequest(signedRequest: string): SignedRequestResult {
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return { ok: false, refusal: 'malformed' };
  const [encodedSig, encodedPayload] = parts as [string, string];

  const sig = decodeStrict(encodedSig);
  const payloadBytes = decodeStrict(encodedPayload);
  if (sig === null || payloadBytes === null) return { ok: false, refusal: 'not_base64url' };

  let matched: string | null = null;
  // Runs to completion rather than breaking, so the work done does not vary with which
  // secret matched — the same property `signature.ts` maintains for the same reason.
  for (const [slug, secret] of appSecretPairs()) {
    // The ENCODED payload, hashed as the ASCII it arrived as.
    const expected = createHmac('sha256', secret).update(encodedPayload, 'ascii').digest();
    if (equalBytes(expected, sig) && matched === null) matched = slug;
  }
  if (matched === null) return { ok: false, refusal: 'signature_invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { ok: false, refusal: 'payload_not_json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, refusal: 'payload_not_json' };
  }
  const obj = parsed as Record<string, unknown>;

  // Checked, never dispatched on. See the module note.
  if (obj['algorithm'] !== 'HMAC-SHA256') return { ok: false, refusal: 'algorithm_unexpected' };

  const userId = obj['user_id'];
  if (typeof userId !== 'string' || userId.trim() === '') return { ok: false, refusal: 'user_id_missing' };

  // UNIX seconds, like `created_time` on the feed webhook. Off by 1000 here is harmless —
  // it is recorded, never compared against a window — so an unusable value is null rather
  // than a refusal: a privacy request is not dropped over a timestamp.
  const issued = obj['issued_at'];
  const issuedAt =
    typeof issued === 'number' && Number.isFinite(issued) && issued > 0 ? new Date(issued * 1000) : null;

  return { ok: true, payload: { userId: userId.trim(), issuedAt, matchedAppSlug: matched } };
}
