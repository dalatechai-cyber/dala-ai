/**
 * The ONE place `cache: 'no-store'` is set. Guarded in both directions by
 * scripts/guards/check-supabase-nostore.mjs.
 *
 * ## Why this file exists
 *
 * A Next.js route handler that exports only GET caches every Supabase read for a YEAR,
 * and `export const dynamic = 'force-dynamic'` does NOT stop it. Only `cache: 'no-store'`
 * does. From Next 14.2's own source: `hasNonStaticMethods` is true only for
 * POST/DELETE/PATCH/OPTIONS, so a GET-only route never sets
 * `staticGenerationStore.revalidate = 0`; and in `patch-fetch.js`, `autoNoCache` requires
 * `(uncacheable header || uncacheable method) && revalidate === 0`. Note the `&&`:
 * **carrying an Authorization header is not on its own enough**, and every Supabase
 * request carries one.
 *
 * Next door this cost $12.43 — three quiz-bank cron runs read `active: 0` against a
 * populated table, with HTTP 200 and `error: null`, and generated the maximum each time.
 * A cached read does not look like a failure. It looks like an answer.
 *
 * ## Next 16 (D-018)
 *
 * The mechanism above was read out of Next 14.2's source and this platform builds on
 * Next 16, so the exact internals may differ. That is precisely why the behaviour is
 * pinned here and asserted by a guard rather than assumed from a version: `no-store` is
 * correct on every version, and the guard fails if it is ever removed.
 */
export const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: 'no-store' });
