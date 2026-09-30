/**
 * Each client's model spend for the month so far, and the rulebook's 70% alert.
 *
 * Rulebook §3.1 (v0.3): 20,000 ₮ a month per client is the NORMAL limit and the alert
 * threshold; at 70% of it the founder is alerted; the normal limit never stops a reply.
 * Until 2026-09-30 nothing read a month at all (`monthly_ceiling_nanousd` has no reader,
 * D-051/D-072), so the first sign of a costly client was the daily brake refusing replies.
 *
 * ## Where it runs, and why there
 *
 * In the daily report (00:05 Ulaanbaatar), and nowhere on the reply path. Rulebook §4 puts
 * everything that is not a payment, a bot down, an unanswered customer or a credential in
 * the daily brief, and the digest is that brief until Nexus's exists. Reading it here also
 * means no failure of this code can delay, stop or charge a reply: it reads rows, and the
 * report is the only thing it changes.
 *
 * ## What it reads
 *
 * `spend_ledger`, the append-only record of what was actually spent, summed over
 * `cost_mnt` — the tögrög figure snapshotted onto each row at settle time and never
 * re-derived, which is the currency the rule is written in. `platform_ops` rows are
 * Dalatech's own quality work and are not the client's. Spend that reached the provider
 * but not the ledger is in `ledger_deadletter` and is NOT in this figure.
 *
 * The month is the tenant's calendar month containing the day the report covers, from its
 * first midnight to the end of that day, so a report delivered late still reports the
 * same figure and a report at 00:05 on the 1st reports the month that just ended.
 *
 * ## Unreadable is not zero
 *
 * A read that fails, a page loop that cannot finish, or a row that cannot be parsed makes
 * that tenant's figure UNREADABLE (`mnt: null`). A zero that means "could not look" is the
 * defect `countDropped` exists to avoid, and a spend line is the worst place to rebuild it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CLIENT_MONTHLY_ALERT_FRACTION, CLIENT_MONTHLY_NORMAL_LIMIT_MNT, PLATFORM_TIMEZONE,
} from '../../config/platform.ts';
import { localDayStart, tenantClock } from '../time/clock.ts';
import { fromDb, type NanoUsd } from '../money.ts';

/** How many ledger rows one request asks for. The loop does not trust it as the page size. */
const PAGE = 1000;
/** A month past this many pages is not finished; the figure is UNREADABLE, not a guess. */
const MAX_PAGES = 30;

export type TenantMonthSpend = {
  tenant: string;
  /** e.g. «2026-09» on the tenant's calendar. */
  month: string;
  /** Spend in whole tögrög-cents (₮ × 100); null when UNREADABLE. */
  mntCents: number | null;
  usd: NanoUsd | null;
  /** Days of the month covered, and the month's length, for the pace figure. */
  daysCovered: number;
  daysInMonth: number;
  detail?: string;
};

export type MonthlySpendSummary =
  | { ok: true; tenants: TenantMonthSpend[] }
  | { ok: false; detail: string };

/** Digits grouped by comma, without the runtime's locale (D-026). */
export function groupDigits(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}

function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one. UTC, so no zone moves it.
  return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
}

/** «2026-09-30» → «2026-10-01». UTC arithmetic on a bare date, so no zone can move it. */
function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10); // a bare date's own arithmetic, not a day taken from a timestamp (D-151)
}

/** «₮12,922» from cents. */
function mnt(cents: number): string {
  return `₮${groupDigits(cents / 100)}`;
}

function usdText(n: NanoUsd): string {
  const cents = (n + 5_000_000n) / 10_000_000n;
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Tögrög-cents from a `numeric(14,2)` as PostgREST sends it. Null when it is not a number. */
function cents(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** One tenant's month, paged until a page comes back empty. */
async function sumTenantMonth(
  db: SupabaseClient, tenantId: string, since: string, until: string,
): Promise<{ ok: true; mntCents: number; usd: NanoUsd } | { ok: false; detail: string }> {
  let total = 0;
  let usd = 0n;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db
      .from('spend_ledger')
      .select('id, cost_mnt, cost_nanousd')
      .eq('tenant_id', tenantId)
      .neq('budget_bucket', 'platform_ops')
      .gte('at', since)
      .lt('at', until)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { ok: false, detail: `spend_ledger unreadable: ${error.message}` };
    const rows = Array.isArray(data) ? data : [];
    // Stop on an EMPTY page, never on a short one: a server row cap below PAGE would make a
    // short page look like the last one and quietly drop the rest of the month.
    if (rows.length === 0) return { ok: true, mntCents: total, usd };
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const c = cents(r['cost_mnt']);
      if (c === null) return { ok: false, detail: `spend_ledger row ${String(r['id'])}: cost_mnt unreadable` };
      total += c;
      try {
        usd += fromDb(r['cost_nanousd'], 'cost_nanousd');
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }
    offset += rows.length;
  }
  return { ok: false, detail: `more than ${MAX_PAGES} pages of ledger rows: not summed` };
}

/**
 * Every tenant's month so far. `reportUntil` is the end of the day the report covers
 * (`reportWindow(now).until`).
 */
export async function readMonthlySpend(db: SupabaseClient, reportUntil: string): Promise<MonthlySpendSummary> {
  try {
    const { data, error } = await db.from('tenants').select('id, display_name, timezone');
    if (error) return { ok: false, detail: `tenants unreadable: ${error.message}` };
    const until = new Date(reportUntil);
    if (Number.isNaN(until.getTime())) return { ok: false, detail: 'report window unreadable' };
    // The last instant of the reported day: its month is the month being reported.
    const anchor = new Date(until.getTime() - 1);

    const out: TenantMonthSpend[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      const r = row as Record<string, unknown>;
      const id = String(r['id']);
      const name = typeof r['display_name'] === 'string' && r['display_name'] !== '' ? r['display_name'] : id;
      const zone = typeof r['timezone'] === 'string' && r['timezone'] !== '' ? r['timezone'] : PLATFORM_TIMEZONE;
      const day = tenantClock(anchor, zone).date;
      const month = day.slice(0, 7);
      const since = localDayStart(`${month}-01`, zone).toISOString();
      // The END of that day on the tenant's own calendar, so a tenant outside Ulaanbaatar
      // gets whole days of their own and not a platform-day edge.
      const end = localDayStart(nextDate(day), zone).toISOString();
      const summed = await sumTenantMonth(db, id, since, end);
      out.push({
        tenant: name, month,
        mntCents: summed.ok ? summed.mntCents : null,
        usd: summed.ok ? summed.usd : null,
        daysCovered: Number(day.slice(8, 10)),
        daysInMonth: daysIn(month),
        ...(summed.ok ? {} : { detail: summed.detail }),
      });
    }
    return { ok: true, tenants: out };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The rulebook's thresholds, in tögrög-cents. */
const LIMIT_CENTS = CLIENT_MONTHLY_NORMAL_LIMIT_MNT * 100;
const ALERT_CENTS = Math.round(LIMIT_CENTS * CLIENT_MONTHLY_ALERT_FRACTION);

export type SpendLevel = 'unreadable' | 'ok' | 'alert' | 'over';

export function spendLevel(t: TenantMonthSpend): SpendLevel {
  if (t.mntCents === null) return 'unreadable';
  if (t.mntCents >= LIMIT_CENTS) return 'over';
  if (t.mntCents >= ALERT_CENTS) return 'alert';
  return 'ok';
}

/** One tenant's line. Pure, so the tests pin every wording. */
export function tenantSpendLine(t: TenantMonthSpend): string {
  const level = spendLevel(t);
  if (level === 'unreadable' || t.mntCents === null) {
    return `🟠 ${t.tenant} (${t.month}): UNREADABLE — ${t.detail ?? 'no figure'}`;
  }
  const pct = Math.floor((t.mntCents * 100) / LIMIT_CENTS);
  const pace = t.daysCovered > 0 && t.daysCovered < t.daysInMonth
    ? ` · on pace for ${mnt((t.mntCents / t.daysCovered) * t.daysInMonth)} by month end`
    : '';
  const usd = t.usd === null ? '' : ` · ${usdText(t.usd)}`;
  const base = `${t.tenant} (${t.month}, ${t.daysCovered} of ${t.daysInMonth} days): ${mnt(t.mntCents)} = ${pct}%${usd}${pace}`;
  if (level === 'over') return `🔴 ${base} — OVER the normal limit. Replies continue; your call.`;
  if (level === 'alert') return `🟠 ${base} — 70% ALERT.`;
  return base;
}

/**
 * The report's spend block. Present every day, clean or not: a view that disappears on a
 * quiet day looks the same as one that stopped working.
 */
export function monthlySpendBlock(s: MonthlySpendSummary): string {
  const head = `Model spend this month (normal limit ${mnt(LIMIT_CENTS)} per client, alert at `
    + `${Math.round(CLIENT_MONTHLY_ALERT_FRACTION * 100)}%; alerts only, never stops replies):`;
  if (!s.ok) return `${head}\nUNREADABLE — ${s.detail}`;
  if (s.tenants.length === 0) return `${head}\nno tenants`;
  const rank: Record<SpendLevel, number> = { unreadable: 0, over: 1, alert: 2, ok: 3 };
  const sorted = [...s.tenants].sort((a, b) =>
    (rank[spendLevel(a)] - rank[spendLevel(b)])
    || ((b.mntCents ?? 0) - (a.mntCents ?? 0))
    // Code point, never locale (D-026).
    || (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
  return `${head}\n${sorted.map(tenantSpendLine).join('\n')}`;
}

/** Messenger events a daily cap refused, per tenant, over the reported day. */
export type ShedSummary =
  | { ok: true; byTenant: { tenant: string; count: number }[]; capped: boolean }
  | { ok: false };

export async function countShed(db: SupabaseClient, since: string, until: string): Promise<ShedSummary> {
  try {
    const { data, error } = await db
      .from('webhook_events')
      .select('tenant_id')
      .eq('state', 'shed')
      .gte('received_at', since)
      .lt('received_at', until);
    if (error) return { ok: false };
    const rows = Array.isArray(data) ? data : [];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const id = String((row as Record<string, unknown>)['tenant_id']);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (counts.size === 0) return { ok: true, byTenant: [], capped: false };
    const { data: tenants, error: tErr } = await db.from('tenants').select('id, display_name').in('id', [...counts.keys()]);
    if (tErr) return { ok: false };
    const names = new Map<string, string>();
    for (const t of Array.isArray(tenants) ? tenants : []) {
      const r = t as Record<string, unknown>;
      if (typeof r['display_name'] === 'string' && r['display_name'] !== '') names.set(String(r['id']), r['display_name']);
    }
    return {
      ok: true,
      capped: rows.length >= PAGE,
      byTenant: [...counts].map(([id, count]) => ({ tenant: names.get(id) ?? id, count })),
    };
  } catch {
    return { ok: false };
  }
}

/** Always printed: «none» is a statement, UNREADABLE is never folded into it. */
export function shedLine(s: ShedSummary): string {
  if (!s.ok) return 'Messenger messages refused by a daily cap (yesterday): UNREADABLE';
  if (s.byTenant.length === 0) return 'No Messenger messages refused by a daily cap (yesterday)';
  const mark = s.capped ? '≥' : '';
  const parts = [...s.byTenant]
    .sort((a, b) => (b.count - a.count) || (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0))
    .map((t) => `${t.tenant} ×${mark}${t.count}`);
  return `🔴 Messenger messages refused by a daily cap, customer got no reply (yesterday): ${parts.join(', ')}`;
}
