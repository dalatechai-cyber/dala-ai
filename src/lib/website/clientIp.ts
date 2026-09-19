/**
 * The caller's address, from the proxy headers Vercel sets.
 *
 * This is its own module rather than three lines in a route handler because it makes
 * decisions, and `api/workers/reception/route.ts` states the rule this repository follows:
 * a condition inside a route is a condition no test can reach. The decisions here are
 * small and all of them have a wrong answer that is silent.
 *
 * ## `x-forwarded-for` is a LIST, and only one end of it is trustworthy
 *
 * A client may send its own `X-Forwarded-For`, and each proxy appends. So the header that
 * arrives reads `<client-supplied junk>, <real client>, <proxy>, …` and the entry an
 * attacker controls is the FIRST one. Vercel appends the connecting address, so the
 * rightmost entry is the one its edge observed.
 *
 * Taking `[0]` — the reflex, and what most snippets do — hands an attacker control of the
 * rate-limit bucket key: they vary the first entry per request and every request lands in
 * a fresh window, so the limiter counts to one for ever while looking like it works. That
 * is the shape this repository keeps cataloguing, a check that cannot fail.
 *
 * `x-real-ip` is preferred where present because Vercel sets it to the observed address
 * and it is not a list, so there is nothing to mis-index.
 *
 * ## An unreadable address is a value, not an absence
 *
 * Returning `''` would make every unidentifiable caller share one rate-limit bucket with
 * every other — which is either far too strict (they throttle each other) or far too loose,
 * depending on the limit, and is impossible to reason about. `UNKNOWN_CLIENT_IP` is a real,
 * stable bucket key that says what it is, so a flood of unattributable traffic is bounded
 * together and is visible as itself in the logs.
 */

/** The bucket every caller whose address we cannot read shares. Deliberately nameable. */
export const UNKNOWN_CLIENT_IP = 'unknown';

export function clientIpOf(headers: Headers): string {
  const real = headers.get('x-real-ip');
  if (typeof real === 'string' && real.trim() !== '') return real.trim();

  const forwarded = headers.get('x-forwarded-for');
  if (typeof forwarded === 'string' && forwarded.trim() !== '') {
    const parts = forwarded.split(',').map((p) => p.trim()).filter((p) => p !== '');
    // The RIGHTMOST entry: the address the nearest proxy observed, which is the only one no
    // client could have written. See the header note above.
    const last = parts[parts.length - 1];
    if (last !== undefined) return last;
  }

  return UNKNOWN_CLIENT_IP;
}
