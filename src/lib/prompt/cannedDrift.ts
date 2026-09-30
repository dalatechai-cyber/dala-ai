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
import { kindsReferencedBy } from '../gate/match.ts';

export const CANNED_STALE_KIND = 'config.canned_stale';

/** Bounds the whole alert, reads and Telegram together (as `spend/ceilingAlert.ts`). */
export const CANNED_ALERT_TIMEOUT_MS = 5_000;

/** No period: an `on_change` episode, closed by the hourly check when the hashes agree (D-063, D-128). */
export function cannedStaleKey(tenantId: string): string {
  return `${CANNED_STALE_KIND}:${tenantId}`;
}

/**
 * Is this `retry` detail a refusal caused by the approved lines themselves? Three codes stop
 * EVERY reply until an operator fixes the rows: `canned_stale` (rows differ from the published
 * hash), `canned_response_unreviewed` (any row in the default locale is unsigned, model-invisible
 * kinds included) and `canned_response_missing` (a line the prefix or a rule requires has no
 * row). All three page and serve the published hand-off line (founder, 2026-09-30).
 */
export function isApprovedLinesRefusal(detail: string | null | undefined): boolean {
  return typeof detail === 'string' && (detail.startsWith('canned_stale')
    || detail.startsWith('canned_response_unreviewed') || detail.startsWith('canned_response_missing'));
}

export function cannedStaleBody(input: {
  name: string; source: 'reply' | 'hourly check'; channels: readonly string[];
  /** What is wrong, when the hourly check knows more than "the hash moved". */
  unsigned?: readonly string[]; missing?: readonly string[];
}): string {
  const where = input.channels.length === 0 ? '' : ` (${input.channels.join(', ')})`;
  const unsigned = (input.unsigned ?? []).length > 0 ? ` Unsigned: ${input.unsigned!.join(', ')} — sign it.` : '';
  const missing = (input.missing ?? []).length > 0 ? ` No row for: ${input.missing!.join(', ')} — add and sign it.` : '';
  return `Approved lines changed, unsigned or missing — ${input.name}${where}. `
    + `Found by the ${input.source}.${unsigned}${missing} Every reply is refused until it is fixed (and republished if a `
    + 'body or kind changed): customers get the published hand-off line (Messenger and Instagram once per conversation a day), and otherwise nothing. '
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
      const [snaps, rows, disclosure, outOfScope] = await Promise.all([
        db.from('config_snapshots').select('channel, canned_hash, prompt_stable')
          .eq('tenant_id', tenantId).eq('revision_id', String(t['live_revision_id'])),
        db.from('canned_responses').select('kind, body, reviewed_at')
          .eq('tenant_id', tenantId).eq('locale', String(t['default_locale'] ?? 'mn-MN')),
        db.from('disclosure_rules').select('response_kind').eq('tenant_id', tenantId),
        db.from('out_of_scope_topics').select('response_kind').eq('tenant_id', tenantId),
      ]);
      // An unreadable table is a counted failure and the episode is left as it is: "in step"
      // on a guess would close a stall the reply path is still in.
      if (snaps.error || rows.error || disclosure.error || outOfScope.error) { out.failures += 1; continue; }
      const cannedRows = (rows.data ?? []) as Record<string, unknown>[];
      const current = cannedHashOf(cannedRows.map((r) => ({ kind: String(r['kind']), body: String(r['body']) })));
      const hashed = ((snaps.data ?? []) as Record<string, unknown>[]).filter((s) => typeof s['canned_hash'] === 'string');
      const stale = hashed.filter((s) => s['canned_hash'] !== current).map((s) => String(s['channel']));
      // The two other total stops `renderCannedSection` refuses on, read the way `handle.ts`
      // reads them: any unsigned row, and any kind the prefix or the tenant's rules require
      // with no row. On EVERY live revision, section or not, because the reply path refuses
      // on both regardless; otherwise this would close an episode the reply path reopens.
      const unsigned = cannedRows.filter((r) => r['reviewed_at'] === null).map((r) => String(r['kind'])).sort();
      const present = new Set(cannedRows.map((r) => String(r['kind'])));
      const ruleKinds = [...(disclosure.data ?? []), ...(outOfScope.data ?? [])]
        .map((r) => String((r as Record<string, unknown>)['response_kind'] ?? '')).filter((k) => k !== '');
      const prefixes = ((snaps.data ?? []) as Record<string, unknown>[]).map((s) => s['prompt_stable'])
        .filter((p): p is string => typeof p === 'string');
      const missing = [...new Set([...kindsReferencedBy(prefixes), ...ruleKinds])].filter((k) => !present.has(k)).sort();
      out.checked += 1;
      if (stale.length > 0 || unsigned.length > 0 || missing.length > 0) {
        out.drifted += 1;
        const name = typeof t['display_name'] === 'string' && t['display_name'] !== '' ? String(t['display_name']) : tenantId;
        const res = await raiseAlert(db, {
          tenantId, severity: 'critical', kind: CANNED_STALE_KIND, dedupKey: cannedStaleKey(tenantId),
          route: 'now', repeat: 'on_change', body: cannedStaleBody({ name, source: 'hourly check', channels: stale, unsigned, missing }),
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
