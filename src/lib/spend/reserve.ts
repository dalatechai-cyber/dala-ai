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
import { CAPS } from '../../config/platform.ts';
import { fromDb, toDb, type NanoUsd } from '../money.ts';
import { dayKey, monthKey } from './periods.ts';

export type Surface = 'reception' | 'care' | 'analytics' | 'onboarding' | 'quality' | 'platform_ops';

export type Reservation = {
  id: string;
  tenantId: string;
  surface: Surface;
  estimate: NanoUsd;
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

export async function reserve(
  db: SupabaseClient,
  input: {
    tenantId: string;
    surface: Surface;
    estimate: NanoUsd;
    conversationId?: string | null;
    webhookEventId?: number | null;
    now: Date;
  },
): Promise<ReserveOutcome> {
  if (input.estimate < 0n) return { outcome: 'unavailable', detail: 'negative estimate' };

  const ceiling = await effectiveDailyCeiling(db, input.tenantId, input.surface);
  if (!ceiling.ok) return { outcome: 'unavailable', detail: ceiling.detail };

  // A surface budgeted at zero refuses here, before anything else happens. Analytics and
  // Quality are deliberately zero (config/platform.ts) and must refuse without depending
  // on any read succeeding.
  if (ceiling.ceiling === 0n) return { outcome: 'refused', reason: 'ceiling_reached' };

  const dKey = dayKey(input.now);
  const seeded = await ensureCounter(db, 'tenant', input.tenantId, input.surface, 'day', dKey, ceiling.ceiling);
  if (!seeded.ok) return { outcome: 'unavailable', detail: seeded.detail };

  const platformSeeded = await ensureCounter(
    db, 'platform', 'platform', input.surface, 'day', dKey, CAPS.platformPerDay);
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

  // BOTH ceilings, tenant then platform. app.reserve_spend is a single conditional
  // UPDATE, so the check and the increment cannot interleave — the CAS is in its WHERE
  // clause, not in application code.
  for (const [scope, scopeKey] of [['tenant', input.tenantId], ['platform', 'platform']] as const) {
    const { data: granted, error } = await db.rpc('reserve_spend', {
      p_scope: scope, p_scope_key: scopeKey, p_surface: input.surface,
      p_period_kind: 'day', p_period_key: dKey,
      p_amount_nanousd: toDb(input.estimate),
    });
    if (error) {
      await release(db, reservationId);
      return { outcome: 'unavailable', detail: `reserve_spend failed: ${error.message}` };
    }
    if (granted !== true) {
      await release(db, reservationId);
      return { outcome: 'refused', reason: 'ceiling_reached' };
    }
  }

  return {
    outcome: 'reserved',
    reservation: { id: reservationId, tenantId: input.tenantId, surface: input.surface, estimate: input.estimate },
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
export async function release(db: SupabaseClient, reservationId: string): Promise<void> {
  await db.from('spend_reservations').update({ state: 'released' }).eq('id', reservationId);
}
