/**
 * The page when the emergency brake stops replies, and the close when it lets go.
 *
 * Rulebook §3.1 (v0.3): only the emergency brake may stop a live customer's reply, and
 * "it alerts the founder immediately". Until 2026-09-30 it did not. A refused reservation
 * marked the event `shed`, answered QStash 200 so nothing retried, and the Messenger
 * customer got no reply at all — while the founder heard nothing, because the exhausted
 * alert only fires when QStash's retries run out, and a 200 has none to run out.
 *
 * ## What this must never do
 *
 * **Stop, delay or double-charge a reply.** It runs only on a refusal that has already
 * happened, and it reads and writes `alerts`, `tenants` and `spend_counters` rows only — it
 * never reserves, releases or settles. Every failure is returned as a label for the caller
 * to log; nothing throws. The whole thing is bounded by `ALERT_TIMEOUT_MS`: a Telegram call
 * with no timeout of its own must not hold a worker until its 60-second limit, because a
 * worker killed there answers QStash with an error and the event is delivered again.
 *
 * ## One page per brake, not one per message (D-128)
 *
 * Every message after the first hits the same brake. The key carries no period and the
 * row is an `on_change` EPISODE: while it is open, later refusals are suppressed by the
 * `alerts` read. What closes it is the thing that ends the condition — the tenant's day
 * (and the platform's) rolling over, which resets both daily counters. The hourly health
 * run closes it then (`closeStaleCeilingEpisodes`), off the reply path, so a reply that
 * succeeds pays nothing for this. A brake that trips again on the new day pages again.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { raiseAlert } from '../alerts/alert.ts';
import { fromDb, type NanoUsd } from '../money.ts';
import { tenantClock } from '../time/clock.ts';
import { dayKey } from './periods.ts';
import type { Surface } from './reserve.ts';

export const CEILING_KIND = 'spend.ceiling_reached';

/** Bounds the whole alert, reads and Telegram together. */
export const ALERT_TIMEOUT_MS = 5_000;

/** No period in it: an `on_change` key (D-063, D-128). */
export function ceilingEpisodeKey(tenantId: string, surface: Surface): string {
  return `${CEILING_KIND}:${tenantId}:${surface}`;
}

export type CeilingAlertInput = {
  tenantId: string;
  surface: Surface;
  /** `tenants.timezone` — the calendar the tenant's counter rolls on. */
  timezone: string;
  now: Date;
  /** Where the refusal happened, e.g. `messenger` or `web`. Said in the page. */
  channel: string;
  /** The reservation that was refused. */
  estimate: NanoUsd;
};

/**
 * A counter as read: its figures, `'absent'` when there is no row for the day, or null when
 * the read failed. Absent and unreadable are different facts: `reserve.ts` refuses a surface
 * whose budget is zero BEFORE it seeds a counter, so a missing row is how that case looks.
 */
type CounterRead = { used: NanoUsd; ceiling: NanoUsd | null } | 'absent' | null;

/** «$1.98», from nano-USD, without floating point on the way to the cents. */
function usd(n: NanoUsd): string {
  const cents = (n + 5_000_000n) / 10_000_000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `$${whole}.${frac}`;
}

async function readCounter(
  db: SupabaseClient, scope: 'tenant' | 'platform', scopeKey: string, surface: Surface, periodKey: string,
): Promise<CounterRead> {
  const { data, error } = await db
    .from('spend_counters')
    .select('ceiling_nanousd, reserved_nanousd, settled_nanousd')
    .eq('scope', scope)
    .eq('scope_key', scopeKey)
    .eq('surface', surface)
    .eq('period_kind', 'day')
    .eq('period_key', periodKey)
    .maybeSingle();
  if (error) return null;
  if (data === null) return 'absent';
  const r = data as Record<string, unknown>;
  try {
    const used = fromDb(r['reserved_nanousd'], 'reserved_nanousd') + fromDb(r['settled_nanousd'], 'settled_nanousd');
    const ceiling = r['ceiling_nanousd'] === null ? null : fromDb(r['ceiling_nanousd'], 'ceiling_nanousd');
    return { used, ceiling };
  } catch {
    return null;
  }
}

function counterLine(label: string, c: CounterRead): string {
  if (c === null) return `${label}: UNREADABLE`;
  if (c === 'absent') return `${label}: no counter yet today`;
  return `${label}: ${usd(c.used)} of ${c.ceiling === null ? 'no ceiling' : usd(c.ceiling)}`;
}

/** Which ceiling refused, from what the counters say now. Null when neither read says. */
export function whichCeiling(tenant: CounterRead, platform: CounterRead, estimate: NanoUsd): string {
  const over = (c: CounterRead): boolean =>
    c !== null && c !== 'absent' && c.ceiling !== null && c.used + estimate > c.ceiling;
  // No tenant counter while the platform's is readable and under its cap: the reservation was
  // refused before any counter was seeded, which `reserve.ts` does only for a zero budget.
  if (tenant === 'absent' && platform !== null && !over(platform)) {
    return 'this tenant\'s budget gives this surface nothing (tenant_budgets surface fraction is 0)';
  }
  if (over(tenant) && over(platform)) return 'both the tenant\'s and the platform\'s daily cap';
  if (over(tenant)) return 'the tenant\'s daily cap';
  if (over(platform)) return 'the platform\'s daily cap (all tenants together)';
  return 'a daily cap (the counters no longer show which — another reply may have settled below it)';
}

export function ceilingBody(input: {
  name: string; channel: string; surface: Surface; timezone: string; now: Date;
  which: string; tenant: CounterRead; platform: CounterRead;
}): string {
  const today = tenantClock(input.now, input.timezone);
  return `Daily spend cap reached — ${input.name} (${input.surface}, ${input.channel}). `
    + `Refused by ${input.which}. Until midnight ${input.timezone}, Messenger customers get NO reply and `
    + `website visitors get the handoff line; nothing more is spent. `
    + `${counterLine(`Tenant ${today.date}`, input.tenant)}. ${counterLine('Platform today', input.platform)}. `
    + `The cap is unchanged; raising it is your decision.`;
}

async function raiseOnce(db: SupabaseClient, input: CeilingAlertInput): Promise<string> {
  const tenantDay = dayKey(input.now, input.timezone);
  const platformDay = dayKey(input.now, PLATFORM_TIMEZONE);
  const [tenantRow, tenantCounter, platformCounter] = await Promise.all([
    db.from('tenants').select('display_name').eq('id', input.tenantId).maybeSingle(),
    readCounter(db, 'tenant', input.tenantId, input.surface, tenantDay),
    readCounter(db, 'platform', 'platform', input.surface, platformDay),
  ]);
  const rawName = tenantRow.error || tenantRow.data === null
    ? null
    : (tenantRow.data as Record<string, unknown>)['display_name'];
  const name = typeof rawName === 'string' && rawName !== '' ? rawName : input.tenantId;

  const res = await raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'critical',
    kind: CEILING_KIND,
    dedupKey: ceilingEpisodeKey(input.tenantId, input.surface),
    route: 'now',
    repeat: 'on_change',
    body: ceilingBody({
      name, channel: input.channel, surface: input.surface, timezone: input.timezone, now: input.now,
      which: whichCeiling(tenantCounter, platformCounter, input.estimate),
      tenant: tenantCounter, platform: platformCounter,
    }),
  });
  return res.outcome === 'recorded_undelivered' || res.outcome === 'failed'
    ? `${res.outcome}: ${res.detail}`
    : res.outcome;
}

/**
 * Page the founder that a cap refused a reply. Returns what happened, for the log. Never
 * throws, never waits longer than `timeoutMs`.
 */
export async function alertCeilingReached(
  db: SupabaseClient, input: CeilingAlertInput, timeoutMs: number = ALERT_TIMEOUT_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`timed_out after ${timeoutMs}ms`), timeoutMs);
  });
  try {
    return await Promise.race([
      raiseOnce(db, input).catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Close the ceiling episodes whose day has ended — the hourly health run's job.
 *
 * An episode is closed only when BOTH the tenant's calendar day and the platform's have
 * moved on since it opened: those are the two counters that can refuse, and each resets
 * only at its own midnight. A tenant whose budget gives the surface nothing is refused
 * again on the new day, and that reopens the episode and pages once more, which is right:
 * replies are still stopped.
 *
 * Returns counts, never throws; a failed read or write is reported and changes nothing.
 */
export async function closeStaleCeilingEpisodes(
  db: SupabaseClient, now: Date,
): Promise<{ ok: true; closed: number } | { ok: false; detail: string }> {
  try {
    const { data, error } = await db
      .from('alerts')
      .select('id, tenant_id, dedup_key, at')
      .eq('kind', CEILING_KIND)
      .eq('repeat_policy', 'on_change')
      .is('resolved_at', null);
    if (error) return { ok: false, detail: `alerts unreadable: ${error.message}` };
    const open = (Array.isArray(data) ? data : []).map((r) => r as Record<string, unknown>);
    if (open.length === 0) return { ok: true, closed: 0 };

    const tenantIds = [...new Set(open.flatMap((r) => (r['tenant_id'] === null || r['tenant_id'] === undefined ? [] : [String(r['tenant_id'])])))];
    const { data: tenants, error: tErr } = tenantIds.length === 0
      ? { data: [], error: null }
      : await db.from('tenants').select('id, timezone').in('id', tenantIds);
    if (tErr) return { ok: false, detail: `tenants unreadable: ${tErr.message}` };
    const zones = new Map<string, string>();
    for (const t of Array.isArray(tenants) ? tenants : []) {
      const r = t as Record<string, unknown>;
      if (typeof r['timezone'] === 'string' && r['timezone'] !== '') zones.set(String(r['id']), r['timezone']);
    }

    const stale: number[] = [];
    for (const r of open) {
      const at = new Date(String(r['at']));
      if (Number.isNaN(at.getTime())) continue;
      // `alerts.tenant_id` is `on delete set null`: a deleted tenant has no counter left to
      // brake, so only the platform's day decides.
      const deleted = r['tenant_id'] === null || r['tenant_id'] === undefined;
      const zone = deleted ? PLATFORM_TIMEZONE : zones.get(String(r['tenant_id']));
      // A tenant whose zone cannot be read is left open: closing on a guess would hide a
      // brake that may still be on.
      if (zone === undefined) continue;
      const tenantRolled = dayKey(at, zone) !== dayKey(now, zone);
      const platformRolled = dayKey(at, PLATFORM_TIMEZONE) !== dayKey(now, PLATFORM_TIMEZONE);
      if (tenantRolled && platformRolled) stale.push(Number(r['id']));
    }
    if (stale.length === 0) return { ok: true, closed: 0 };

    const { data: closed, error: uErr } = await db
      .from('alerts')
      .update({ resolved_at: now.toISOString() })
      .in('id', stale)
      .is('resolved_at', null)
      .select('id');
    if (uErr) return { ok: false, detail: `alerts not resolvable: ${uErr.message}` };
    return { ok: true, closed: Array.isArray(closed) ? closed.length : 0 };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The cap pages raised over a day, whether or not their episode has since closed. */
export type CeilingPagesSummary =
  | { ok: true; pages: { tenant: string; delivered: boolean }[] }
  | { ok: false };

/**
 * Read the day's cap pages for the daily report.
 *
 * The report lists open episodes, and the health run closes these after midnight, so without
 * this a page that fired yesterday could be gone from the report by the time it runs. It also
 * catches the page that never arrived: the row is written before Telegram is called, so a
 * failed or abandoned send leaves `delivered = false` and suppresses every later page that
 * day. That row is printed here as NOT DELIVERED.
 */
export async function readCeilingPages(db: SupabaseClient, since: string, until: string): Promise<CeilingPagesSummary> {
  try {
    const { data, error } = await db
      .from('alerts')
      .select('tenant_id, delivered')
      .eq('kind', CEILING_KIND)
      .gte('at', since)
      .lt('at', until);
    if (error) return { ok: false };
    const rows = (Array.isArray(data) ? data : []).map((r) => r as Record<string, unknown>);
    if (rows.length === 0) return { ok: true, pages: [] };
    const ids = [...new Set(rows.flatMap((r) => (r['tenant_id'] === null || r['tenant_id'] === undefined ? [] : [String(r['tenant_id'])])))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { data: tenants, error: tErr } = await db.from('tenants').select('id, display_name').in('id', ids);
      if (tErr) return { ok: false };
      for (const t of Array.isArray(tenants) ? tenants : []) {
        const r = t as Record<string, unknown>;
        if (typeof r['display_name'] === 'string' && r['display_name'] !== '') names.set(String(r['id']), r['display_name']);
      }
    }
    return {
      ok: true,
      pages: rows.map((r) => ({
        tenant: r['tenant_id'] === null || r['tenant_id'] === undefined
          ? 'deleted tenant'
          : names.get(String(r['tenant_id'])) ?? String(r['tenant_id']),
        delivered: r['delivered'] === true,
      })),
    };
  } catch {
    return { ok: false };
  }
}

/** Always printed; UNREADABLE is never folded into «none». */
export function ceilingPagesLine(s: CeilingPagesSummary): string {
  if (!s.ok) return 'Daily-cap pages (yesterday): UNREADABLE';
  if (s.pages.length === 0) return 'No daily-cap pages (yesterday)';
  const parts = [...s.pages]
    .sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0))
    .map((p) => `${p.tenant} (${p.delivered ? 'delivered' : 'NOT DELIVERED — later refusals that day were silent'})`);
  return `🔴 Daily-cap pages (yesterday): ${parts.join(', ')}`;
}
