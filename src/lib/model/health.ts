/**
 * Model and cache health (§6.10.5).
 *
 * ## Both of these are bills, not errors
 *
 * That is the whole reason they need alarms. Nothing throws, no request fails, no status
 * code changes — the only symptom is the invoice, arriving a month later.
 *
 *  - **Caching silently stopping.** A prompt-assembly change that makes the prefix vary
 *    per request takes the hit rate to zero. At the design's P = 9,000 prompt tokens that
 *    is roughly a **2.5× bill**, with no error and no visible symptom.
 *  - **A model silently swapping.** If `response.model` is not the id we asked for, the
 *    Mongolian quality changes with nothing visible changing. §6.10.5 is explicit that a
 *    retired id must never fall back to another model, because a silent swap is worse
 *    than a refusal: a refusal is noticed.
 *
 * ## The window is read from the LEDGER, not from a counter
 *
 * `spend_ledger` already records `cache_read_tokens` on every call and is append-only,
 * enforced by `ENABLE ALWAYS` triggers that bind `service_role` too. So the rolling window
 * is a query over evidence that cannot have been rewritten, rather than a counter that
 * could drift — and it needs no new table.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { quietRoute, raiseAlert, resolveEpisodes, type AlertOutcome } from '../alerts/alert.ts';

/**
 * How many recent calls must ALL be cache-cold before this is a problem.
 *
 * One cold call is normal — the first request after a TTL expiry always writes rather
 * than reads. Three could be three genuine cold starts. Ten in a row is not a coincidence
 * at any realistic traffic level, and it is small enough that a broken deploy is caught
 * within minutes rather than at the end of the month.
 */
export const CACHE_WINDOW = 10;

export type CacheVerdict =
  /** Fewer than CACHE_WINDOW calls to judge on. Not a finding. */
  | { verdict: 'insufficient_data'; sample: number }
  /** Caching is deliberately off for this tenant. Silence is correct. */
  | { verdict: 'not_expected' }
  /** At least one recent call read from cache. */
  | { verdict: 'warm'; reads: number }
  /** Every call in the window was cold. This is the alarm. */
  | { verdict: 'cold_run'; sample: number }
  | { verdict: 'unavailable'; detail: string };

/**
 * Has this tenant's prompt cache stopped working?
 *
 * Returns `not_expected` when the tenant has caching off — a tenant paying full rate on
 * purpose must not generate an alert every ten messages, which would train the channel to
 * be ignored exactly when it matters.
 */
export async function checkCacheHealth(
  db: SupabaseClient,
  input: { tenantId: string; surface: string; cacheMode: 'off' | '5m' | '1h' },
): Promise<CacheVerdict> {
  if (input.cacheMode === 'off') return { verdict: 'not_expected' };

  const { data, error } = await db
    .from('spend_ledger')
    .select('cache_read_tokens')
    .eq('tenant_id', input.tenantId)
    .eq('surface', input.surface)
    .order('at', { ascending: false })
    .limit(CACHE_WINDOW);

  if (error) return { verdict: 'unavailable', detail: `spend_ledger unreadable: ${error.message}` };

  const rows = Array.isArray(data) ? data : [];
  if (rows.length < CACHE_WINDOW) return { verdict: 'insufficient_data', sample: rows.length };

  const reads = rows.filter((raw) => {
    const v = (raw as Record<string, unknown>)['cache_read_tokens'];
    return typeof v === 'number' && v > 0;
  }).length;

  return reads > 0 ? { verdict: 'warm', reads } : { verdict: 'cold_run', sample: rows.length };
}

/**
 * Raise the cache alarm, deduplicated per tenant per day.
 *
 * The **period is in the dedup key** on purpose. Without it the first alarm silences every
 * later one forever, so a cache that breaks again next month is invisible; with it, a
 * still-broken cache re-announces itself once a day, which is the right cadence for
 * something that is costing money continuously.
 */
export async function alertCacheCold(
  db: SupabaseClient,
  input: { tenantId: string; surface: string; dayKey: string; sample: number },
): Promise<AlertOutcome> {
  return raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'warn',
    kind: 'model.cache_cold_run',
    dedupKey: `cache_cold:${input.tenantId}:${input.surface}:${input.dayKey}`,
    // A bill, not an outage, and it trips on a quiet tenant with nothing broken (the
    // 2026-09-25 inventory, B5): the daily report under DAILY_REPORT_V2, `now` otherwise.
    route: quietRoute(),
    body:
      `The last ${input.sample} ${input.surface} calls all read ZERO cached tokens. ` +
      `Prompt caching appears to have stopped. This is not an error and nothing will fail — ` +
      `it is a bill, roughly 2.5x at the design's prompt size. Most likely cause: something ` +
      `now varies per request inside the cached prefix.`,
  });
}

export type ServedVerdict =
  | { verdict: 'as_requested' }
  /** The API did not tell us which model served the turn. Not a finding on its own. */
  | { verdict: 'unreported' }
  | { verdict: 'swapped'; requested: string; served: string };

/**
 * Did the model we asked for actually serve the turn?
 *
 * A bare string comparison, deliberately: no normalising, no prefix matching, no "close
 * enough". The whole value of this check is that it notices a difference we did not
 * intend, and any leniency here is a rule about which differences do not matter — which
 * is precisely the judgement that should be made by a person reading an alert.
 */
export function checkServedModel(requested: string, served: string): ServedVerdict {
  if (served === '') return { verdict: 'unreported' };
  return served === requested ? { verdict: 'as_requested' } : { verdict: 'swapped', requested, served };
}

/** Raise the model-swap alarm. Deduplicated on the PAIR, so each new swap is announced. */
export async function alertModelSwapped(
  db: SupabaseClient,
  input: { tenantId: string; requested: string; served: string; dayKey: string },
): Promise<AlertOutcome> {
  return raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'warn',
    kind: 'model.served_differs',
    dedupKey: `model_swap:${input.requested}:${input.served}:${input.dayKey}`,
    // Worth investigating, not worth waking for: every reply still went out.
    route: quietRoute(),
    body:
      `Requested ${input.requested}, served ${input.served}. A silent model swap changes ` +
      `the Mongolian quality with nothing visible changing, which is why this is an alert ` +
      `rather than a log line.`,
  });
}

/** The retired-model episode's key. One builder, so the raise and the resolve cannot drift. */
export function modelNotFoundKey(modelId: string): string {
  return `model_not_found:${modelId}`;
}

/**
 * Raise the retired-model alarm. **Critical**: every tenant on this model is now answering
 * with the pinned handoff line, and no amount of retrying will change it.
 *
 * The dedup key carries no period: repeating it every day would add noise to an outage
 * rather than information. But it is an EPISODE (`on_change`), not a once-ever event — it
 * was `daily` under a dateless key until 2026-09-25, which made it fire once in the life of
 * the project, so a model id that returned, was fixed, and returned again a month later
 * would have been silent the second time (the 2026-09-25 inventory, B4). A call on the same
 * id that succeeds closes it (`resolveModelRetired`), and the next 404 pages again.
 */
export async function alertModelRetired(
  db: SupabaseClient,
  input: { modelId: string; detail: string },
): Promise<AlertOutcome> {
  return raiseAlert(db, {
    tenantId: null,
    severity: 'critical',
    kind: 'model.not_found',
    dedupKey: modelNotFoundKey(input.modelId),
    route: 'now',
    repeat: 'on_change',
    body:
      `${input.modelId} returned 404. EVERY tenant on this model is now answering with the ` +
      `pinned handoff line. Never fall back to another model — a silent swap changes the ` +
      `Mongolian quality invisibly. Update config/models.json. Detail: ${input.detail}`,
  });
}

/**
 * A call on `modelId` succeeded, so a retired-model episode for it is over.
 *
 * Runs on every successful reply, which is why it is `resolveEpisodes` — one conditional
 * UPDATE over the partial open-key index, zero rows on every ordinary day — and not a read
 * followed by a write, nor a module-scope flag remembering that nothing was open.
 */
export async function resolveModelRetired(
  db: SupabaseClient,
  input: { modelId: string; now: Date },
): Promise<{ ok: true; resolved: number } | { ok: false; detail: string }> {
  return resolveEpisodes(db, { dedupKeys: [modelNotFoundKey(input.modelId)], now: input.now });
}
