/**
 * Cloudflare Turnstile verification, for the session mint.
 *
 * ## It gates the MINT, not every message
 *
 * A challenge per message would be both worse for the customer and weaker: the thing worth
 * bounding is how many conversations an automated caller can START, and once a session
 * exists its cost is already bounded by `turn_cap` and by the rate limiter. One human check
 * per session is where the check does the most work for the least friction.
 *
 * ## What it is worth, stated honestly
 *
 * Turnstile says "a browser that passed a challenge", not "a person", and solving services
 * exist. It is a cost multiplier on automation, not a gate — and on this surface it sits
 * BEHIND the tenant-server HMAC, which is the actual authorization. If the ordering is ever
 * inverted so that Turnstile is what admits a caller, this comment is the one to re-read:
 * `Matrix-Chatbot/lib/cors.js` documents the same mistake made with CORS.
 *
 * ## Fail closed, and no environment where it is off
 *
 * A missing secret refuses. Rule 7's "no fallback to a default credential" extends to "no
 * fallback to no credential" — which `meta/signature.ts` says in as many words, and which is
 * the difference between a check and a decoration. There is deliberately no
 * `TURNSTILE_DISABLED` and no development bypass: a bypass flag is one dashboard edit away
 * from being live, and the failure is silent.
 *
 * ## Unverified against Cloudflare
 *
 * `challenges.cloudflare.com` is not reachable from this environment — the egress proxy
 * 403s arbitrary hosts, `api.github.com/zen` included — so the request shape here is written
 * from Cloudflare's documented contract and has NOT been exercised against the real
 * endpoint. The response parsing is deliberately narrow about what counts as success
 * (`success === true`, nothing else), so an unexpected body shape refuses rather than
 * passing. `docs/website-channel.md` carries this in its blockers table.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; reason: 'turnstile_missing' | 'turnstile_failed' | 'turnstile_unavailable'; detail?: string };

/** How long to wait on Cloudflare before refusing. A mint that hangs is a mint that failed. */
export const TURNSTILE_TIMEOUT_MS = 5_000;

/**
 * @param token   the `cf-turnstile-response` the widget produced
 * @param secret  from the platform environment (rule 7). Never a per-tenant value: the
 *                Turnstile site is the platform's, and a tenant cannot be trusted with a
 *                secret whose job is to vouch for traffic to us.
 * @param remoteIp optional; Cloudflare uses it to sharpen its own scoring
 * @param fetchImpl injected so the contract is testable without reaching the network
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  secret: string | undefined,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileOutcome> {
  if (secret === undefined || secret === '') {
    // NOT 'turnstile_failed': the caller did nothing wrong and a retry will not help. This
    // is our misconfiguration, and it must read as one in the logs.
    return { ok: false, reason: 'turnstile_unavailable', detail: 'TURNSTILE_SECRET_KEY is unset' };
  }
  if (typeof token !== 'string' || token === '') {
    return { ok: false, reason: 'turnstile_missing' };
  }

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp !== undefined && remoteIp !== '') form.set('remoteip', remoteIp);

  let res: Response;
  try {
    res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      // Rule 8. Not a Supabase read, but the same trap: a fetch Next.js decides to cache is
      // a verification answered from a previous visitor's result.
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, reason: 'turnstile_unavailable', detail: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return { ok: false, reason: 'turnstile_unavailable', detail: `siteverify HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, reason: 'turnstile_unavailable', detail: err instanceof Error ? err.message : String(err) };
  }

  // Narrow on purpose: `success === true` and nothing else. A truthy check would pass on
  // the string "false", and a body we do not recognise is a reason to refuse rather than a
  // reason to guess — D-057's rule that a parser which cannot complete must say so.
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'turnstile_unavailable', detail: 'siteverify body was not an object' };
  }
  const success = (body as Record<string, unknown>)['success'];
  if (success === true) return { ok: true };
  if (success === false) {
    const codes = (body as Record<string, unknown>)['error-codes'];
    // `exactOptionalPropertyTypes` is on, so an absent detail is an ABSENT KEY rather than
    // an explicit undefined — which is also the honest encoding: "Cloudflare sent no codes"
    // and "detail: undefined" are the same fact only by accident.
    return Array.isArray(codes)
      ? { ok: false, reason: 'turnstile_failed', detail: codes.map(String).join(',') }
      : { ok: false, reason: 'turnstile_failed' };
  }
  return { ok: false, reason: 'turnstile_unavailable', detail: `success was ${JSON.stringify(success)}` };
}
