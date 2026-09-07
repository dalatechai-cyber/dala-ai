/**
 * Settle the actual against the reservation, and write the ledger row.
 *
 * The ledger is APPEND-ONLY, enforced by statement triggers created with `ENABLE ALWAYS`
 * so they bind `service_role` too — the one role that holds BYPASSRLS. That means this
 * code physically cannot rewrite history even with the most privileged key in the
 * system, which is the property that makes the ledger evidence rather than a log.
 *
 * `fx_mnt_per_usd` is snapshotted ONTO the row and never re-derived. A ₮ figure
 * recomputed later at today's rate would silently restate last month's margin, and the
 * whole point of D-004's formula is that the margin is checkable after the fact.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** `tenants.prompt_cache_mode`. `off` is a mode, not a missing one. */
export type CacheMode = 'off' | '5m' | '1h';
import { fromDb, toDb, type NanoUsd } from '../money.ts';
import { dayTargets, type Reservation, type Surface } from './reserve.ts';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { tenantClock } from '../time/clock.ts';

/** Exactly the `usage` block Anthropic returns. Nothing estimated. */
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type Priced = { cost: NanoUsd; modelId: string };

/**
 * Price a call from `model_prices`. An unknown price REFUSES rather than guessing —
 * `outbound_policies` takes the same posture with its nullable
 * `per_message_cost_nanousd`, and for the same reason: a spend we cannot price is a
 * spend we cannot cap.
 */
export async function priceCall(
  db: SupabaseClient,
  modelId: string,
  usage: Usage,
  cacheTtl: CacheMode,
  now: Date,
): Promise<{ ok: true; priced: Priced } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('model_prices')
    .select('input_nanousd_per_token, output_nanousd_per_token, cache_read_nanousd_per_token, cache_write_5m_nanousd_per_token, cache_write_1h_nanousd_per_token')
    .eq('model_id', modelId)
    .lte('effective_from', now.toISOString())
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { ok: false, detail: `model_prices unreadable: ${error.message}` };
  if (data === null) return { ok: false, detail: `no price for ${modelId}: refusing to guess` };

  const p = data as Record<string, unknown>;
  const written = BigInt(usage.cache_creation_input_tokens ?? 0);
  try {
    // The 1h write multiplier is 2x and the 5m is 1.25x. Picking the wrong one halves or
    // doubles the miss cost, which is most of the cost on a cold conversation — and until
    // 2026-09-07 `deps.ts` passed a hardcoded '1h' for every tenant, so a 5m tenant's
    // writes were billed at twice their rate in the one place the margin is checked.
    //
    // `off` is the third mode and it is not a rate. A tenant with caching off sends no
    // `cache_control`, so the API cannot return a write — and if it does, that is the
    // provider and our configuration disagreeing about what we asked for. Pricing it at a
    // rate we did not choose would put a number in the ledger that describes a request
    // nobody made, so it refuses, which is `priceCall`'s posture everywhere else.
    let writeRate: NanoUsd = 0n;
    if (cacheTtl === 'off') {
      if (written > 0n) {
        return { ok: false, detail:
          `${written} cache-write tokens with prompt_cache_mode 'off': refusing to price a write we did not ask for` };
      }
    } else {
      writeRate = fromDb(
        cacheTtl === '1h' ? p['cache_write_1h_nanousd_per_token'] : p['cache_write_5m_nanousd_per_token'],
        'cache_write_nanousd_per_token');
    }

    const cost =
      BigInt(usage.input_tokens) * fromDb(p['input_nanousd_per_token'], 'input') +
      BigInt(usage.output_tokens) * fromDb(p['output_nanousd_per_token'], 'output') +
      BigInt(usage.cache_read_input_tokens ?? 0) * fromDb(p['cache_read_nanousd_per_token'], 'cache_read') +
      written * writeRate;

    return { ok: true, priced: { cost, modelId } };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Today's ₮/$ rate, on the PLATFORM's calendar.
 *
 * `fx_rates.effective_from` is a bare `date` with no zone, and the rate it carries is a
 * Mongolian one — so the day it starts is a day in Ulaanbaatar, not in UTC. Asking for it
 * by `now.toISOString().slice(0, 10)` made a rate published for a given date arrive
 * **eight hours late**: from 00:00 to 08:00 local, the UTC date is still yesterday, so the
 * previous rate was snapshotted onto the ledger.
 *
 * The platform's calendar rather than the tenant's, unlike the counters in `periods.ts`: a
 * USD→MNT rate is one fact about one currency pair on one day, not something a tenant has
 * a version of. Two tenants settling the same second must snapshot the same number.
 *
 * This moves what a settle RECORDS, never what it may spend — the ceilings are nanoUSD and
 * never see this figure. It is `fx_mnt_per_usd` and `cost_mnt`, the columns D-004's margin
 * is checked against after the fact, which is exactly why being eight hours stale mattered.
 */
async function currentFx(db: SupabaseClient, now: Date): Promise<number | null> {
  const { data, error } = await db
    .from('fx_rates')
    .select('mnt_per_unit')
    .eq('currency', 'USD')
    .lte('effective_from', tenantClock(now, PLATFORM_TIMEZONE).date)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || data === null) return null;
  const raw = (data as Record<string, unknown>)['mnt_per_unit'];
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Record what was actually spent. Called AFTER the provider responds, with the real
 * `usage` block — never an estimate.
 *
 * Returns false only on a bookkeeping failure. The caller must NOT turn that into a
 * refusal of the customer's reply: the money is already spent and the customer is owed
 * the answer. It must alert instead, which is why `ledger_deadletter` exists.
 */
export async function settle(
  db: SupabaseClient,
  input: {
    reservation: Reservation;
    usage: Usage;
    modelId: string;
    /** The TENANT'S `prompt_cache_mode`, not a constant. See `priceCall`. */
    cacheTtl: CacheMode;
    conversationId?: string | null;
    requestId?: string | null;
    now: Date;
  },
): Promise<{ ok: true; cost: NanoUsd } | { ok: false; detail: string }> {
  const priced = await priceCall(db, input.modelId, input.usage, input.cacheTtl, input.now);
  if (!priced.ok) return { ok: false, detail: priced.detail };

  const fx = await currentFx(db, input.now);
  if (fx === null) return { ok: false, detail: 'no FX rate: cannot snapshot ₮ onto the ledger row' };

  const { cost } = priced.priced;
  const surface: Surface = input.reservation.surface;

  const { error: ledgerErr } = await db.from('spend_ledger').insert({
    tenant_id: input.reservation.tenantId,
    surface,
    // Reception/care/analytics/onboarding bill to themselves; quality is Dalatech's own
    // process and bills to platform_ops (reconciliation item 13).
    budget_bucket: surface === 'quality' ? 'platform_ops' : surface,
    reservation_id: input.reservation.id,
    provider: 'anthropic',
    model_id: input.modelId,
    input_tokens: input.usage.input_tokens,
    output_tokens: input.usage.output_tokens,
    cache_read_tokens: input.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: input.usage.cache_creation_input_tokens ?? 0,
    cost_nanousd: toDb(cost),
    fx_mnt_per_usd: fx,
    cost_mnt: Number((Number(cost) / 1e9 * fx).toFixed(2)),
    conversation_id: input.conversationId ?? null,
    request_id: input.requestId ?? null,
  });
  if (ledgerErr) return { ok: false, detail: `ledger insert failed: ${ledgerErr.message}` };

  // Both counters or neither, for the reason `reserve` has: a settlement that moved the
  // tenant row and not the platform row leaves the platform's day permanently short by one
  // reply's estimate, and no later run repairs it. `app.settle_spend_all` rolls back and
  // the caller retries.
  const { error } = await db.rpc('settle_spend_all', {
    p_targets: dayTargets(input.reservation.tenantId, input.now, input.reservation.timezone),
    p_surface: surface,
    p_reserved_nanousd: toDb(input.reservation.estimate),
    p_actual_nanousd: toDb(cost),
  });
  if (error) return { ok: false, detail: `settle_spend_all failed: ${error.message}` };

  await db.from('spend_reservations').update({ state: 'settled' }).eq('id', input.reservation.id);
  return { ok: true, cost };
}
