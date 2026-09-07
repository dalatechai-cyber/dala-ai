/**
 * Reserve BEFORE the call, settle after. (CLAUDE.md rule 3.)
 *
 * ## Why the order is the whole design
 *
 * A ceiling checked *after* the provider call is not a ceiling — it is a report. By the
 * time it fails, the money is spent and the only thing it can do is tell you so. Every
 * function here is arranged so that the refusal happens while it is still free:
 * `reserve()` returns before an Anthropic client is ever constructed.
 *
 * ## Why the effective ceiling is a MINIMUM
 *
 * `config/platform.ts` is compiled and commit-gated. `tenant_budgets` is a database row.
 * A row must never be able to RAISE a compiled cap — otherwise the review process is
 * decorative and one UPDATE re-opens the hole. So the counter's ceiling is
 * `min(compiled, tenant)`, always, and a tenant row can only ever tighten it.
 *
 * ## Fail closed, everywhere
 *
 * Every error path here refuses. Never `try { check() } catch { continue }` — that exact
 * pattern was the HIGH finding next door. A refusal costs a retry; failing open costs
 * money, and here it is another tenant's money.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { CAPS, PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { fromDb, toDb, type NanoUsd } from '../money.ts';
import { dayKey, monthKey } from './periods.ts';

export type Surface = 'reception' | 'care' | 'analytics' | 'onboarding' | 'quality' | 'platform_ops';

export type Reservation = {
  id: string;
  tenantId: string;
  surface: Surface;
  estimate: NanoUsd;
  /**
   * The tenant's IANA zone, carried on the reservation rather than looked up again.
   *
   * `reserve`, `release` and `settle` must address the same counters or the ledger
   * drifts, and the counter's identity includes its period key — so the calendar is part
   * of the address, not a detail of the caller. Carrying it here means a release cannot
   * refund a different day's row than the one the hold was taken from, which a second
   * lookup (or a caller passing its own idea of the zone) makes possible.
   */
  timezone: string;
};

export type ReserveOutcome =
  /** Proceed. The provider call may now be made, and MUST be settled afterwards. */
  | { outcome: 'reserved'; reservation: Reservation }
  /** At or over a ceiling. Degrade per §5.7 — do NOT call the provider. */
  | { outcome: 'refused'; reason: 'ceiling_reached' }
  /** Anything we could not determine. Refuse and let the caller 503. */
  | { outcome: 'unavailable'; detail: string };

/**
 * The effective daily ceiling: the compiled cap, lowered by the tenant's own row if it
 * is tighter. A tenant with NO budget row gets the compiled cap and nothing more
 * permissive — and if even that cannot be read, the caller refuses.
 */
export async function effectiveDailyCeiling(
  db: SupabaseClient,
  tenantId: string,
  surface: Surface,
): Promise<{ ok: true; ceiling: NanoUsd } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('tenant_budgets')
    .select('daily_ceiling_nanousd, surface_fractions')
    .eq('tenant_id', tenantId)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { ok: false, detail: `tenant_budgets unreadable: ${error.message}` };

  const compiled = CAPS.perTenantPerSurfacePerDay;
  if (data === null) return { ok: true, ceiling: compiled };

  const row = data as Record<string, unknown>;
  let tenantCeiling: NanoUsd;
  try {
    tenantCeiling = fromDb(row['daily_ceiling_nanousd'], 'daily_ceiling_nanousd');
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  // The surface's share of the tenant's daily budget. Absent or malformed -> the
  // surface gets nothing rather than everything.
  const fractions = row['surface_fractions'];
  let fraction = 0;
  if (fractions !== null && typeof fractions === 'object') {
    const raw = (fractions as Record<string, unknown>)[surface];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) fraction = raw;
  }
  const tenantSurfaceCeiling = (tenantCeiling * BigInt(Math.round(fraction * 10_000))) / 10_000n;

  // MINIMUM. A row may lower the compiled cap; it may never raise it.
  return { ok: true, ceiling: tenantSurfaceCeiling < compiled ? tenantSurfaceCeiling : compiled };
}

/** Seed or tighten the counter row so `app.reserve_spend` has a ceiling to check. */
async function ensureCounter(
  db: SupabaseClient,
  scope: 'tenant' | 'platform',
  scopeKey: string,
  surface: Surface,
  periodKind: 'day' | 'month',
  periodKey: string,
  ceiling: NanoUsd,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { error } = await db.from('spend_counters').upsert(
    {
      scope, scope_key: scopeKey, surface,
      period_kind: periodKind, period_key: periodKey,
      ceiling_nanousd: toDb(ceiling),
    },
    { onConflict: 'scope,scope_key,surface,period_kind,period_key', ignoreDuplicates: true },
  );
  return error ? { ok: false, detail: `spend_counters upsert failed: ${error.message}` } : { ok: true };
}

/** One counter the ledger must move: a row in `spend_counters`, addressed by its key. */
export type SpendTarget = {
  scope: 'tenant' | 'platform';
  scope_key: string;
  period_kind: 'day' | 'month';
  period_key: string;
};

/**
 * Every counter one reservation touches, in ONE definition.
 *
 * `reserve`, `release` and `settle` must address the same set or the ledger drifts —
 * reserving against two counters and refunding one is the leak `0016` exists to close, and
 * two lists spelled separately is how that comes back. Adding the monthly ceiling is
 * therefore a change HERE and nowhere else: append the month entries and every operation
 * covers them, because the all-or-nothing property is per call, not per period.
 */
export function dayTargets(tenantId: string, now: Date, timezone: string): SpendTarget[] {
  return [
    { scope: 'tenant', scope_key: tenantId, period_kind: 'day', period_key: dayKey(now, timezone) },
    // NOT `timezone`. The platform's day is the platform's, or two tenants in different
    // zones open two platform rows for one platform day and the platform cap doubles.
    { scope: 'platform', scope_key: 'platform', period_kind: 'day', period_key: dayKey(now, PLATFORM_TIMEZONE) },
  ];
}

/** PostgreSQL's `check_violation`. `0016` raises it, and ONLY it, for a ceiling. */
const CEILING_REACHED = '23514';

export async function reserve(
  db: SupabaseClient,
  input: {
    tenantId: string;
    surface: Surface;
    estimate: NanoUsd;
    conversationId?: string | null;
    webhookEventId?: number | null;
    now: Date;
    /** `tenants.timezone`. The day this reservation counts against is the tenant's. */
    timezone: string;
  },
): Promise<ReserveOutcome> {
  if (input.estimate < 0n) return { outcome: 'unavailable', detail: 'negative estimate' };

  const ceiling = await effectiveDailyCeiling(db, input.tenantId, input.surface);
  if (!ceiling.ok) return { outcome: 'unavailable', detail: ceiling.detail };

  // A surface budgeted at zero refuses here, before anything else happens. Analytics and
  // Quality are deliberately zero (config/platform.ts) and must refuse without depending
  // on any read succeeding.
  if (ceiling.ceiling === 0n) return { outcome: 'refused', reason: 'ceiling_reached' };

  const tenantDay = dayKey(input.now, input.timezone);
  const seeded = await ensureCounter(db, 'tenant', input.tenantId, input.surface, 'day', tenantDay, ceiling.ceiling);
  if (!seeded.ok) return { outcome: 'unavailable', detail: seeded.detail };

  // The platform's own day, for the reason `dayTargets` gives: a shared cap cannot have a
  // per-tenant period or it is not shared.
  const platformDay = dayKey(input.now, PLATFORM_TIMEZONE);
  const platformSeeded = await ensureCounter(
    db, 'platform', 'platform', input.surface, 'day', platformDay, CAPS.platformPerDay);
  if (!platformSeeded.ok) return { outcome: 'unavailable', detail: platformSeeded.detail };

  // The reservation row first, so there is evidence even if the counter update fails.
  const { data: held, error: holdErr } = await db
    .from('spend_reservations')
    .insert({
      tenant_id: input.tenantId,
      surface: input.surface,
      conversation_id: input.conversationId ?? null,
      webhook_event_id: input.webhookEventId ?? null,
      estimate_nanousd: toDb(input.estimate),
      state: 'held',
      expires_at: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (holdErr) return { outcome: 'unavailable', detail: `reservation insert failed: ${holdErr.message}` };
  if (held === null) return { outcome: 'unavailable', detail: 'reservation insert returned no row' };
  const reservationId = String((held as Record<string, unknown>)['id']);

  // EVERY ceiling, in one statement. `app.reserve_spend_all` moves all of its targets or
  // raises and rolls back — so there is no partial reservation to compensate for, and no
  // compensating write that has to succeed at the exact moment something else just failed.
  //
  // It used to be a loop, tenant then platform, and it leaked: the tenant counter was
  // incremented, the platform one refused, and `release()` set a state without touching a
  // counter. The tenant's day was charged for a reply that never happened, until midnight.
  const targets = dayTargets(input.tenantId, input.now, input.timezone);
  const { error } = await db.rpc('reserve_spend_all', {
    p_targets: targets,
    p_surface: input.surface,
    p_amount_nanousd: toDb(input.estimate),
  });
  if (error) {
    // 23514 is the ceiling refusing — the one case that degrades rather than retries.
    // Every other code means we could not determine, and a 503 costs a redelivery.
    await release(db, {
      id: reservationId, tenantId: input.tenantId, surface: input.surface,
      estimate: input.estimate, timezone: input.timezone,
    }, input.now);
    return error.code === CEILING_REACHED
      ? { outcome: 'refused', reason: 'ceiling_reached' }
      : { outcome: 'unavailable', detail: `reserve_spend_all failed: ${error.message}` };
  }

  return {
    outcome: 'reserved',
    reservation: {
      id: reservationId, tenantId: input.tenantId, surface: input.surface,
      estimate: input.estimate, timezone: input.timezone,
    },
  };
}

/**
 * Mark the reservation as CALLED. This must happen immediately before the provider call
 * and is the point of no return: the schema's `called_records_when` CHECK requires
 * `provider_call_started_at` for state 'called', so a reservation cannot claim to have
 * been called without recording when. On a redelivery, a reservation already in 'called'
 * tells you the provider may have been reached even if we never saw the response.
 */
export async function markCalled(
  db: SupabaseClient, reservationId: string, now: Date,
): Promise<boolean> {
  const { error } = await db
    .from('spend_reservations')
    .update({ state: 'called', provider_call_started_at: now.toISOString() })
    .eq('id', reservationId)
    .eq('state', 'held');   // CAS: only a held reservation may become called.
  return !error;
}

/** Give back an unused hold. Best-effort; the expiry sweeps whatever this misses. */
export async function release(
  db: SupabaseClient,
  reservation: Reservation,
  now: Date,
): Promise<void> {
  // Was a state label and nothing else until 2026-09-06: it marked the row `released` and
  // left `reserved_nanousd` where it was, so every 503 after a successful reserve consumed
  // the estimate permanently — once per QStash retry. `app.release_spend` gives the budget
  // back, and CASes on `held` so a reservation already `called` (where the provider may
  // have been reached, and the money with it) is never refunded by a late release.
  await db.rpc('release_spend', {
    p_reservation_id: reservation.id,
    p_targets: dayTargets(reservation.tenantId, now, reservation.timezone),
    p_surface: reservation.surface,
    p_amount_nanousd: toDb(reservation.estimate),
  });
}
