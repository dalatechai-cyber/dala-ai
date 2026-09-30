/**
 * A tenant's approved lines changed without a republish: every reply stops (founder,
 * 2026-09-30, D-163).
 *
 * ## What was wrong
 *
 * The reply path compares the published snapshot's `canned_hash` with the hash of the live
 * `canned_responses` rows (D-058, `reception/handle.ts`). A direct edit to a row without a
 * republish makes them differ, and from then on EVERY reply returns `canned_stale`, including
 * ones that need no model. On 21–24 Sep that ran for two and a half days (D-113); the only
 * signal was a `webhook.delivery_exhausted` page per message, some 3 minutes late, which does
 * not say "republish" (docs/reports/2026-09-30-tara-23-24-sep.md).
 *
 * ## What this adds
 *
 * - `alertCannedStale`: the reply that first meets `canned_stale` pages at once. One
 *   `on_change` episode per tenant: later refusals are suppressed while it is open.
 * - `checkCannedDrift`: the hourly health run compares each live snapshot's `canned_hash`
 *   with the same `cannedHashOf` of the current rows the reply path uses. A mismatch opens
 *   the same episode (so drift is seen before a customer writes); a match closes it.
 * - `publishedLine`: whether a row's bytes are the ones the live prefix carries, so the
 *   worker can serve the hand-off line during the stall without ever sending an edited,
 *   unpublished sentence.
 *
 * It reads and writes `alerts` only. It never changes a reply.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, resolveEpisodes } from '../alerts/alert.ts';
import { cannedHashOf } from './sections.ts';

export const CANNED_STALE_KIND = 'config.canned_stale';

/** Bounds the whole alert, reads and Telegram together (as `spend/ceilingAlert.ts`). */
export const CANNED_ALERT_TIMEOUT_MS = 5_000;

/** No period: an `on_change` episode, closed by the hourly check when the hashes agree (D-063, D-128). */
export function cannedStaleKey(tenantId: string): string {
  return `${CANNED_STALE_KIND}:${tenantId}`;
}

export function cannedStaleBody(input: { name: string; source: 'reply' | 'hourly check'; channels: readonly string[] }): string {
  const where = input.channels.length === 0 ? '' : ` (${input.channels.join(', ')})`;
  return `Approved lines changed without a republish — ${input.name}${where}. `
    + `Found by the ${input.source}. Every reply is refused (canned_stale) until the tenant is republished: `
    + 'customers get the published hand-off line once per conversation a day, and otherwise nothing. '
    + 'Republish now (scripts/publish/tenant.ts), or undo the edit.';
}

async function tenantName(db: SupabaseClient, tenantId: string): Promise<string> {
  const { data, error } = await db.from('tenants').select('display_name').eq('id', tenantId).maybeSingle();
  const raw = error || data === null ? null : (data as Record<string, unknown>)['display_name'];
  return typeof raw === 'string' && raw !== '' ? raw : tenantId;
}

/**
 * Page that a reply was refused for `canned_stale`. Returns what happened, for the log.
 * Never throws, never waits longer than `timeoutMs`.
 */
export async function alertCannedStale(
  db: SupabaseClient,
  input: { tenantId: string; channel: string },
  timeoutMs: number = CANNED_ALERT_TIMEOUT_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`timed_out after ${timeoutMs}ms`), timeoutMs);
  });
  const raise = (async () => {
    const name = await tenantName(db, input.tenantId);
    const res = await raiseAlert(db, {
      tenantId: input.tenantId, severity: 'critical', kind: CANNED_STALE_KIND,
      dedupKey: cannedStaleKey(input.tenantId), route: 'now', repeat: 'on_change',
      body: cannedStaleBody({ name, source: 'reply', channels: [input.channel] }),
    });
    return res.outcome === 'recorded_undelivered' || res.outcome === 'failed' ? `${res.outcome}: ${res.detail}` : res.outcome;
  })().catch((e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`);
  try {
    return await Promise.race([raise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Is `body` the exact line the published prefix carries for `kind`? `cannedSectionBody`
 * renders each row as `"kind": body.trim()` on its own line, so the line is looked for
 * whole, between newlines. An edited row is not in the prefix and answers false.
 */
export function publishedLine(promptStable: string, kind: string, body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === '') return false;
  return `\n${promptStable}\n`.includes(`\n"${kind}": ${trimmed}\n`);
}

export type DriftResult = { ok: true; checked: number; drifted: number; raised: number; closed: number; failures: number }
  | { ok: false; detail: string };

/**
 * The hourly check. For every tenant with a live revision, every snapshot of that revision
 * that carries a `canned_hash` is compared with `cannedHashOf` of the tenant's current rows
 * in its default locale, the rows `reception/load.ts` reads. Returns counts; never throws.
 */
export async function checkCannedDrift(db: SupabaseClient, now: Date): Promise<DriftResult> {
  try {
    const { data: tenants, error } = await db.from('tenants')
      .select('id, display_name, live_revision_id, default_locale')
      .not('live_revision_id', 'is', null);
    if (error) return { ok: false, detail: `tenants unreadable: ${error.message}` };
    const out = { checked: 0, drifted: 0, raised: 0, closed: 0, failures: 0 };
    for (const t of (Array.isArray(tenants) ? tenants : []) as Record<string, unknown>[]) {
      const tenantId = String(t['id']);
      const [snaps, rows] = await Promise.all([
        db.from('config_snapshots').select('channel, canned_hash')
          .eq('tenant_id', tenantId).eq('revision_id', String(t['live_revision_id'])),
        db.from('canned_responses').select('kind, body')
          .eq('tenant_id', tenantId).eq('locale', String(t['default_locale'] ?? 'mn-MN')),
      ]);
      if (snaps.error || rows.error) { out.failures += 1; continue; }
      const current = cannedHashOf(((rows.data ?? []) as Record<string, unknown>[])
        .map((r) => ({ kind: String(r['kind']), body: String(r['body']) })));
      const stale = ((snaps.data ?? []) as Record<string, unknown>[])
        .filter((s) => typeof s['canned_hash'] === 'string')
        .filter((s) => s['canned_hash'] !== current)
        .map((s) => String(s['channel']));
      out.checked += 1;
      if (stale.length > 0) {
        out.drifted += 1;
        const name = typeof t['display_name'] === 'string' && t['display_name'] !== '' ? String(t['display_name']) : tenantId;
        const res = await raiseAlert(db, {
          tenantId, severity: 'critical', kind: CANNED_STALE_KIND, dedupKey: cannedStaleKey(tenantId),
          route: 'now', repeat: 'on_change', body: cannedStaleBody({ name, source: 'hourly check', channels: stale }),
        });
        if (res.outcome === 'sent' || res.outcome === 'recorded_undelivered') out.raised += 1;
        if (res.outcome === 'failed') out.failures += 1;
      } else {
        const closed = await resolveEpisodes(db, { dedupKeys: [cannedStaleKey(tenantId)], now });
        if (closed.ok) out.closed += closed.resolved; else out.failures += 1;
      }
    }
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
