/**
 * How each tenant's prompt cache is doing, for the daily report (D-161).
 *
 * Tara Яармаг's cache moved from 1h to 5m on 2026-09-30 (founder), and the founder asked for
 * the effect in the daily report for two weeks. Three figures say it without a model call:
 *
 * - **cold share**: calls that wrote the prefix (`cache_write_tokens > 0`) over all calls. A
 *   shorter TTL can only raise it; if it rises a lot, conversations are pausing past 5 minutes.
 * - **₮ per cold call**: what a miss costs. The TTL's write rate is most of it, so this is the
 *   figure the 1h -> 5m change moves directly (2x -> 1.25x the input rate).
 * - **₮ per call**: the two together, which is what the tenant costs.
 *
 * Each is printed for the reported day and for the last 14 days against the 14 before. Tara
 * switched at 12:35 on 30 Sep, a mixed day: the report for 14 Oct (sent 00:05 on 15 Oct) is the
 * first whose last 14 days are all after the switch, and its 14 before still hold 30 Sep. Read
 * from `spend_ledger` (settled truth, `cost_mnt` snapshotted), `platform_ops` excluded, on the
 * platform's calendar. Reads only; an unreadable tenant prints UNREADABLE, never zero.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { localDayStart } from '../time/clock.ts';
import { cents, groupDigits } from './monthly.ts';

const PAGE = 1000;
const MAX_PAGES = 30;
const WINDOW_DAYS = 14;

export type CacheWindow = { calls: number; cold: number; mntCents: number; coldMntCents: number };

export type TenantCache = {
  tenant: string;
  mode: string;
  yesterday: CacheWindow;
  last: CacheWindow;
  before: CacheWindow;
} | { tenant: string; mode: string; unreadable: string };

export type CacheSummary = { ok: true; tenants: TenantCache[] } | { ok: false; detail: string };

const empty = (): CacheWindow => ({ calls: 0, cold: 0, mntCents: 0, coldMntCents: 0 });

/** «2026-09-30» minus n days, on the bare date. */
function minusDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - n)).toISOString().slice(0, 10); // a bare date's own arithmetic, not a day taken from a timestamp (D-151)
}

/**
 * `reportDate` is the reported Ulaanbaatar day (`reportWindow(now).date`). Windows:
 * yesterday = that day; last = the 14 days ending with it; before = the 14 days before those.
 */
export async function readCacheStats(db: SupabaseClient, reportDate: string): Promise<CacheSummary> {
  try {
    const { data, error } = await db.from('tenants').select('id, display_name, prompt_cache_mode');
    if (error) return { ok: false, detail: `tenants unreadable: ${error.message}` };
    if (!Array.isArray(data)) return { ok: false, detail: 'tenants read returned no list' };
    const end = localDayStart(minusDays(reportDate, -1), PLATFORM_TIMEZONE).getTime();
    const dayStart = localDayStart(reportDate, PLATFORM_TIMEZONE).getTime();
    const lastStart = localDayStart(minusDays(reportDate, WINDOW_DAYS - 1), PLATFORM_TIMEZONE).getTime();
    const beforeStart = localDayStart(minusDays(reportDate, 2 * WINDOW_DAYS - 1), PLATFORM_TIMEZONE).getTime();

    const out: TenantCache[] = [];
    for (const row of data) {
      const r = row as Record<string, unknown>;
      const id = String(r['id']);
      const tenant = typeof r['display_name'] === 'string' && r['display_name'] !== '' ? r['display_name'] : id;
      const mode = typeof r['prompt_cache_mode'] === 'string' ? r['prompt_cache_mode'] : '?';
      const w = { yesterday: empty(), last: empty(), before: empty() };
      let offset = 0;
      let failed: string | null = null;
      let finished = false;
      for (let page = 0; page < MAX_PAGES && failed === null && !finished; page++) {
        const { data: rows, error: lErr } = await db
          .from('spend_ledger')
          .select('id, at, cost_mnt, cache_write_tokens')
          .eq('tenant_id', id)
          .neq('budget_bucket', 'platform_ops')
          .gte('at', new Date(beforeStart).toISOString())
          .lt('at', new Date(end).toISOString())
          .order('id', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (lErr) { failed = `spend_ledger unreadable: ${lErr.message}`; break; }
        if (!Array.isArray(rows)) { failed = 'spend_ledger read returned no list'; break; }
        const list = rows;
        // Stop on an EMPTY page, never a short one (`monthly.ts`, same reason).
        if (list.length === 0) { finished = true; break; }
        for (const x of list) {
          const l = x as Record<string, unknown>;
          const at = new Date(String(l['at'])).getTime();
          // Only a number or a numeric string counts (`cents`); a missing write count is not
          // «warm», it is unreadable.
          const c = cents(l['cost_mnt']);
          const writes = l['cache_write_tokens'];
          if (Number.isNaN(at) || c === null || typeof writes !== 'number' || !Number.isFinite(writes)) {
            failed = `spend_ledger row ${String(l['id'])} unreadable`;
            break;
          }
          const cold = writes > 0;
          const add = (win: CacheWindow): void => {
            win.calls += 1; win.mntCents += c;
            if (cold) { win.cold += 1; win.coldMntCents += c; }
          };
          if (at >= lastStart) add(w.last); else add(w.before);
          if (at >= dayStart) add(w.yesterday);
        }
        offset += list.length;
      }
      if (failed === null && !finished) failed = `more than ${MAX_PAGES} pages of ledger rows: not summed`;
      if (failed !== null) { out.push({ tenant, mode, unreadable: failed }); continue; }
      // A tenant with no model call in 28 days has nothing to say about its cache.
      if (w.last.calls + w.before.calls === 0) continue;
      out.push({ tenant, mode, ...w });
    }
    return { ok: true, tenants: out };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function per(total: number, n: number): string {
  return n === 0 ? '—' : `₮${groupDigits(total / 100 / n)}`;
}

function windowText(w: CacheWindow): string {
  if (w.calls === 0) return 'no calls';
  return `${per(w.mntCents, w.calls)}/call, ${Math.round((w.cold * 100) / w.calls)}% cold, ${per(w.coldMntCents, w.cold)}/cold call`;
}

export function cacheLine(t: TenantCache): string {
  if ('unreadable' in t) return `${t.tenant} [${t.mode}]: UNREADABLE — ${t.unreadable}`;
  // With caching off nothing is ever written, so «0% cold» would read as a perfect cache.
  if (t.mode === 'off') {
    return `${t.tenant} [off]: cache off · yesterday ${t.yesterday.calls} call${t.yesterday.calls === 1 ? '' : 's'} · `
      + `last ${WINDOW_DAYS}d ${per(t.last.mntCents, t.last.calls)}/call · the ${WINDOW_DAYS}d before ${per(t.before.mntCents, t.before.calls)}/call`;
  }
  return `${t.tenant} [${t.mode}]: yesterday ${t.yesterday.calls} call${t.yesterday.calls === 1 ? '' : 's'}, `
    + `${t.yesterday.cold} cold · last ${WINDOW_DAYS}d ${windowText(t.last)} · the ${WINDOW_DAYS}d before ${windowText(t.before)}`;
}

export function cacheBlock(s: CacheSummary): string {
  const head = 'Prompt cache (model calls; cold = the prompt was written to the cache):';
  if (!s.ok) return `${head}\nUNREADABLE — ${s.detail}`;
  if (s.tenants.length === 0) return `${head}\nno model calls in ${2 * WINDOW_DAYS} days`;
  const sorted = [...s.tenants].sort((a, b) => (a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0));
  return `${head}\n${sorted.map(cacheLine).join('\n')}`;
}
