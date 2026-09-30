/**
 * A public reply that timed out, matched to Meta's own notice that it was posted (D-166).
 *
 * ## The measurement this answers
 *
 * 2026-09-27..30: 9 of 13 public comment replies timed out at 10 s and were parked
 * `indeterminate` (correctly: a re-post would put two identical replies under a customer's
 * comment, permanently). Every one of the 9 had in fact posted exactly once. The proof was
 * already in `webhook_events`: the Page's `feed` subscription delivers the Page's OWN comments,
 * so each reply came back as an entry whose change has `item = 'comment'`, `verb = 'add'`,
 * `from.id` = the Page, `parent_id` = the customer comment the row answers (its `dedup_key`),
 * `comment_id` = the reply's id, and `message` byte-identical to the stored body. Meta created
 * the comment at once and answered our POST late. Nothing read that notice, so the rows sat
 * `indeterminate` and silent.
 *
 * ## What counts as a match, and nothing looser
 *
 * All of: the same tenant; the channel's Page (the entry's `id` AND the change's `from.id`
 * are the channel's `external_id`); an `add`; `parent_id` equal to the row's `dedup_key` (the
 * thread root, which is where Facebook files a reply to a reply as well); the same text,
 * compared NFC-normalised and trimmed (rule 6, `sameReplyText`); and a `created_time` no
 * earlier than a minute before the draft was written, so a line staff pasted by hand under the
 * same comment on an earlier day is not taken for ours. A notice that differs in any of these
 * leaves the row exactly as it was. The first matching notice in store order wins.
 *
 * Only `sending` and `indeterminate` rows move. `draft` and `failed` were never posted by
 * us, `sent` already has its id, and `refused` was decided against. The move is one UPDATE
 * whose WHERE clause carries the state, so it cannot interleave with the sender:
 *
 *  - **notice first, while the POST is still open** (possible now that the wait is 25 s):
 *    the row is `sending`; it becomes `sent` here. The sender's own `markSent` or
 *    `markIndeterminate` then matches nothing — both CAS on `state = 'sending'` — so a late
 *    timeout can never overwrite `sent`.
 *  - **park first, notice after**: the row is `indeterminate`; it becomes `sent` here.
 *
 * ## Two readers, and why both
 *
 * 1. **On arrival** (`reconcileFromEntry`, called by `worker/comments.ts` for every Page
 *    `feed` entry, before the entry's own comments are decided). This is the fast path: the
 *    notice's job runs seconds after the reply, and the Page's own comment was being skipped
 *    there as `comment_self` with nothing else looking at it. It catches both orderings above.
 * 2. **The hourly sweep** (`sweepParkedReplies`, from `worker/health.ts`) over the stored
 *    `webhook_events`, for every public reply still `indeterminate` since the start of
 *    yesterday (Ulaanbaatar). This is what makes the result independent of timing: a notice
 *    whose job ran while the row was in a state the fast path does not move, a notice job that
 *    failed or ran with comments switched off, or a write that failed on arrival, are all
 *    matched later from what was stored. Store order and row order stop mattering.
 *
 * A failure on arrival is logged and does NOT fail the comment job: nothing is lost by
 * leaving the row parked one more hour, and a 503 would re-run every customer comment in the
 * entry for a bookkeeping write. Nothing here posts anything, ever — "never retry" is untouched.
 *
 * ## Unconfirmed
 *
 * A public reply still `indeterminate`, with no matching notice, `UNCONFIRMED_AFTER_MS` after
 * its draft is **unconfirmed**: maybe posted, maybe not, and nobody can tell without looking.
 * The draft's `created_at` stands in for the send attempt (the schema records no attempt time,
 * and a reply is claimed within about a second of its draft; a reply the time budget deferred
 * is sent on the redelivery, so its count can come early — the wrong-way-safe direction for a
 * count that exists to make someone look). The daily report counts them per tenant, and the
 * hourly sweep pages when a tenant has more than two in one Ulaanbaatar day.
 *
 * ## Not covered, stated
 *
 * Instagram replies (D-145): the account's own comments do not come back as a notice this
 * platform receives, so an Instagram reply that times out cannot be matched and is counted as
 * unconfirmed after ten minutes, which is the truth. A notice whose `raw_payload` the purge has
 * nulled cannot be read either; the sweep's window (yesterday and today) is far inside every
 * tenant's retention.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { nfc } from '../mn/text.ts';
import { toDb } from '../money.ts';
import { MESSENGER_SEND_UNIT_COST, PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { localDayStart } from '../time/clock.ts';
import { ubDate, ubStamp } from '../time/ub.ts';
import { raiseAlert, type AlertOutcome } from '../alerts/alert.ts';

/** How long after its draft a parked public reply may wait for its notice before it is unconfirmed. */
export const UNCONFIRMED_AFTER_MS = 10 * 60_000;

/** "More than two in one Ulaanbaatar day" (founder, 2026-09-30): the third one pages. */
export const UNCONFIRMED_PAGE_AT = 3;

/** How far before the draft a notice may be stamped and still be ours (Meta's clock, second-resolution). */
export const NOTICE_CLOCK_SLACK_MS = 60_000;

/** The alert kind for the page. */
export const UNCONFIRMED_ALERT_KIND = 'comment_reply.unconfirmed';

/** At most this many rows are read per sweep; more is reported, never silently dropped. */
export const PARKED_SCAN_LIMIT = 500;

/** One of the Page's own new comments, as a stored `feed` entry carried it. */
export type OwnReplyNotice = {
  commentId: string;
  /** The comment it was posted under: the thread root. */
  parentId: string;
  /** NFC. */
  text: string;
  /** Meta's `created_time`; null when absent or unreadable. */
  createdAt: Date | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The Page's own `add` comments in one stored entry, in order. Anything else — another
 * author, an edit, a removal, a post, an entry for a different Page — is not a notice.
 */
export function ownRepliesIn(entry: unknown, pageId: string): OwnReplyNotice[] {
  const e = asRecord(entry);
  if (e === null || pageId === '' || String(e['id'] ?? '') !== pageId) return [];
  const changes = e['changes'];
  if (!Array.isArray(changes)) return [];
  const out: OwnReplyNotice[] = [];
  for (const raw of changes) {
    const change = asRecord(raw);
    if (change === null || change['field'] !== 'feed') continue;
    const value = asRecord(change['value']);
    if (value === null || value['item'] !== 'comment' || value['verb'] !== 'add') continue;
    const from = asRecord(value['from']);
    if (from === null || String(from['id'] ?? '') !== pageId) continue;
    const commentId = typeof value['comment_id'] === 'string' ? value['comment_id'] : '';
    const parentId = typeof value['parent_id'] === 'string' ? value['parent_id'] : '';
    if (commentId === '' || parentId === '' || typeof value['message'] !== 'string') continue;
    const t = value['created_time'];
    out.push({
      commentId,
      parentId,
      text: nfc(value['message']),
      createdAt: typeof t === 'number' && Number.isFinite(t) ? new Date(t * 1000) : null,
    });
  }
  return out;
}

/** The same reply text: NFC on both sides, surrounding whitespace ignored, nothing else. */
export function sameReplyText(a: string, b: string): boolean {
  return nfc(a).trim() === nfc(b).trim();
}

/** The notice that proves this row was posted, or null. The first match in the order given wins. */
export function matchNotice(
  row: { dedupKey: string; body: string; createdAt: Date },
  notices: readonly OwnReplyNotice[],
): OwnReplyNotice | null {
  for (const n of notices) {
    if (n.parentId !== row.dedupKey) continue;
    if (!sameReplyText(n.text, row.body)) continue;
    if (n.createdAt !== null && n.createdAt.getTime() < row.createdAt.getTime() - NOTICE_CLOCK_SLACK_MS) continue;
    return n;
  }
  return null;
}

type ParkedRow = {
  id: string; tenantId: string; channelId: string | null; dedupKey: string;
  body: string; state: string; refusedReason: string | null; createdAt: Date;
};

function parkedRow(r: Record<string, unknown>): ParkedRow {
  return {
    id: String(r['id']),
    tenantId: String(r['tenant_id']),
    channelId: r['channel_id'] === null || r['channel_id'] === undefined ? null : String(r['channel_id']),
    dedupKey: String(r['dedup_key'] ?? ''),
    body: String(r['body'] ?? ''),
    state: String(r['state'] ?? ''),
    refusedReason: typeof r['refused_reason'] === 'string' ? r['refused_reason'] : null,
    createdAt: new Date(String(r['created_at'])),
  };
}

/**
 * Move one row to `sent` on the strength of a notice. The WHERE clause carries the state, so
 * a row the sender has meanwhile marked, or another reconciler already moved, is untouched.
 * Returns whether THIS call moved it.
 */
async function markReconciled(
  db: SupabaseClient, row: ParkedRow, notice: OwnReplyNotice, now: Date,
): Promise<{ ok: true; moved: boolean } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('outbound_messages')
    .update({
      state: 'sent',
      provider_message_id: notice.commentId,
      // The same unit cost `markSent` writes for a comment reply (`sent_has_a_cost`).
      unit_cost_nanousd: toDb(MESSENGER_SEND_UNIT_COST),
      // When Meta created it, which is when it became public; not when we noticed.
      sent_at: (notice.createdAt ?? now).toISOString(),
      lease_until: null,
      // Kept, not cleared: why it was parked is the evidence a person may still want.
      refused_reason: `reconciled from Meta's feed notice ${notice.commentId} (was ${row.state}${row.refusedReason === null ? '' : `: ${row.refusedReason}`})`,
    })
    .eq('id', row.id)
    .eq('tenant_id', row.tenantId)
    .eq('kind', 'comment_reply')
    .in('state', ['sending', 'indeterminate'])
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, detail: `outbound_messages reconcile failed: ${error.message}` };
  return { ok: true, moved: data !== null };
}

export type ReconcileOutcome =
  | { ok: true; reconciled: number; mismatched: number }
  | { ok: false; detail: string };

/**
 * The fast path: the Page's own comments in the entry being processed, matched to this
 * channel's public replies that are `sending` or `indeterminate`. One read when the entry
 * carries a Page comment with a parent; none otherwise.
 */
export async function reconcileFromEntry(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; pageId: string; rawPayload: unknown; now: Date },
): Promise<ReconcileOutcome> {
  const notices = ownRepliesIn(input.rawPayload, input.pageId);
  if (notices.length === 0) return { ok: true, reconciled: 0, mismatched: 0 };
  const { data, error } = await db
    .from('outbound_messages')
    .select('id, tenant_id, channel_id, dedup_key, body, state, refused_reason, created_at')
    .eq('tenant_id', input.tenantId)
    .eq('channel_id', input.channelId)
    .eq('kind', 'comment_reply')
    .in('dedup_key', [...new Set(notices.map((n) => n.parentId))])
    .in('state', ['sending', 'indeterminate']);
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  let reconciled = 0;
  let mismatched = 0;
  for (const raw of Array.isArray(data) ? data : []) {
    const row = parkedRow(raw as Record<string, unknown>);
    // Re-checked here rather than trusted from the filter: a row this function did not ask
    // for must not be moved because a stub or a transport returned it.
    if (row.tenantId !== input.tenantId || (row.state !== 'sending' && row.state !== 'indeterminate')) continue;
    const notice = matchNotice(row, notices);
    if (notice === null) {
      if (notices.some((n) => n.parentId === row.dedupKey)) mismatched += 1;
      continue;
    }
    const moved = await markReconciled(db, row, notice, input.now);
    if (!moved.ok) return { ok: false, detail: moved.detail };
    if (moved.moved) reconciled += 1;
  }
  return { ok: true, reconciled, mismatched };
}

export type UnconfirmedReply = { rowId: string; tenantId: string; dedupKey: string; createdAt: Date };

export type ParkedScan =
  | {
      ok: true;
      /** Rows moved to `sent` by this call (always 0 when `write` is false). */
      reconciled: number;
      /** Rows a notice proves were posted, left as they are because `write` is false. */
      provable: number;
      /** Parked, no notice, and older than `UNCONFIRMED_AFTER_MS`. */
      unconfirmed: UnconfirmedReply[];
      /** Parked, no notice yet, and still inside the ten minutes. */
      young: number;
      /** The row read hit `PARKED_SCAN_LIMIT`: counts are lower bounds. */
      capped: boolean;
    }
  | { ok: false; detail: string };

/**
 * Every public reply still `indeterminate` and drafted in `[since, until)`, each matched
 * against the stored notices of its channel's Page. With `write`, a match is reconciled;
 * without it (the daily report), a match is only counted, so the report never writes.
 *
 * Any read that fails fails the whole scan: a count built from the rows that happened to be
 * readable would print a smaller number than the truth, which is the quiet-alarm failure.
 */
export async function scanParkedReplies(
  db: SupabaseClient,
  input: { since: Date; until: Date; now: Date; write: boolean },
): Promise<ParkedScan> {
  const { data, error } = await db
    .from('outbound_messages')
    .select('id, tenant_id, channel_id, dedup_key, body, state, refused_reason, created_at')
    .eq('kind', 'comment_reply')
    .eq('state', 'indeterminate')
    .gte('created_at', input.since.toISOString())
    .lt('created_at', input.until.toISOString())
    .order('created_at', { ascending: true })
    .limit(PARKED_SCAN_LIMIT);
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const rows = (Array.isArray(data) ? data : []).map((r) => parkedRow(r as Record<string, unknown>));
  const out = { reconciled: 0, provable: 0, unconfirmed: [] as UnconfirmedReply[], young: 0, capped: rows.length >= PARKED_SCAN_LIMIT };
  if (rows.length === 0) return { ok: true, ...out };

  const channelIds = [...new Set(rows.flatMap((r) => (r.channelId === null ? [] : [r.channelId])))];
  const pages = new Map<string, { tenantId: string; provider: string; externalId: string }>();
  if (channelIds.length > 0) {
    const { data: chans, error: chErr } = await db
      .from('tenant_channels')
      .select('id, tenant_id, provider, external_id')
      .in('id', channelIds);
    if (chErr) return { ok: false, detail: `tenant_channels unreadable: ${chErr.message}` };
    for (const c of Array.isArray(chans) ? chans : []) {
      const r = c as Record<string, unknown>;
      pages.set(String(r['id']), { tenantId: String(r['tenant_id']), provider: String(r['provider'] ?? ''), externalId: String(r['external_id'] ?? '') });
    }
  }

  for (const row of rows) {
    const page = row.channelId === null ? undefined : pages.get(row.channelId);
    let notice: OwnReplyNotice | null = null;
    // Only a Page's replies come back as a notice; see the module note on Instagram.
    if (page !== undefined && page.tenantId === row.tenantId && page.provider === 'facebook_page'
        && page.externalId !== '' && row.dedupKey !== '') {
      const { data: events, error: evErr } = await db
        .from('webhook_events')
        .select('raw_payload')
        .eq('tenant_id', row.tenantId)
        .not('raw_payload', 'is', null)
        .contains('raw_payload', {
          id: page.externalId,
          changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', parent_id: row.dedupKey, from: { id: page.externalId } } }],
        })
        .order('id', { ascending: true });
      if (evErr) return { ok: false, detail: `webhook_events unreadable: ${evErr.message}` };
      const notices = (Array.isArray(events) ? events : [])
        .flatMap((e) => ownRepliesIn((e as Record<string, unknown>)['raw_payload'], page.externalId));
      notice = matchNotice(row, notices);
    }
    if (notice !== null) {
      if (!input.write) { out.provable += 1; continue; }
      const moved = await markReconciled(db, row, notice, input.now);
      if (!moved.ok) return { ok: false, detail: moved.detail };
      if (moved.moved) out.reconciled += 1;
      continue;
    }
    if (input.now.getTime() - row.createdAt.getTime() >= UNCONFIRMED_AFTER_MS) {
      out.unconfirmed.push({ rowId: row.id, tenantId: row.tenantId, dedupKey: row.dedupKey, createdAt: row.createdAt });
    } else {
      out.young += 1;
    }
  }
  return { ok: true, ...out };
}

/** Unconfirmed replies grouped by tenant and Ulaanbaatar day (of the draft). */
export function unconfirmedByTenantDay(rows: readonly UnconfirmedReply[]): Map<string, UnconfirmedReply[]> {
  const groups = new Map<string, UnconfirmedReply[]>();
  for (const r of rows) {
    const key = `${r.tenantId}:${ubDate(r.createdAt)}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return groups;
}

/**
 * The page's dedup key: one per tenant per Ulaanbaatar day.
 *
 * `daily`, with the day IN the key, and deliberately not `on_change` (D-063, D-128): this is
 * an EVENT about a day ("three replies on the 30th could not be confirmed"), not a standing
 * condition. Nothing observes it ending — a parked reply is never retried, so it never
 * becomes confirmed by itself — and an `on_change` episode with no closer would page once and
 * then be silent for good. A new day is a new question; the same day asked again hourly is
 * the same question, and the key suppresses it.
 */
export function unconfirmedDedupKey(tenantId: string, ubDay: string): string {
  return `comment_reply_unconfirmed:${tenantId}:${ubDay}`;
}

/** The page's text. Ulaanbaatar time throughout (D-151); ids, never the customer's words. */
export function unconfirmedAlertBody(input: { tenantName: string; day: string; rows: readonly UnconfirmedReply[] }): string {
  const listed = input.rows.slice(0, 5).map((r) => `• ${ubStamp(r.createdAt)}, under comment ${r.dedupKey}`);
  const more = input.rows.length > listed.length ? [`…and ${input.rows.length - listed.length} more`] : [];
  return [
    `${input.tenantName}: ${input.rows.length} public comment replies on ${input.day} (Ulaanbaatar) are UNCONFIRMED.`,
    'Meta did not answer the post in time and no notice of the reply arrived within 10 minutes, so it may or may not be on the wall. They are never re-posted automatically: please check these threads by hand.',
    ...listed,
    ...more,
  ].join('\n');
}

export type SweepParkedResult =
  | { ok: true; reconciled: number; unconfirmed: number; paged: number; pageFailures: number; capped: boolean }
  | { ok: false; detail: string };

/**
 * The hourly half (`worker/health.ts`): reconcile what the stored notices prove, then page
 * once per tenant per Ulaanbaatar day that has `UNCONFIRMED_PAGE_AT` or more unconfirmed.
 *
 * The window starts at 00:00 YESTERDAY in Ulaanbaatar, so a reply drafted at 23:55 becomes
 * unconfirmed at 00:05 and is still counted against its own day by the next run.
 *
 * Never throws. The page goes through `raiseAlert` (Telegram, 5 s timeout); a throw from it is
 * caught and counted, because a health run must not die on its own alarm.
 */
export async function sweepParkedReplies(db: SupabaseClient, input: { now: Date }): Promise<SweepParkedResult> {
  try {
    const todayStart = localDayStart(ubDate(input.now), PLATFORM_TIMEZONE);
    const since = localDayStart(ubDate(new Date(todayStart.getTime() - 1)), PLATFORM_TIMEZONE);
    const scan = await scanParkedReplies(db, { since, until: input.now, now: input.now, write: true });
    if (!scan.ok) return scan;
    const groups = [...unconfirmedByTenantDay(scan.unconfirmed)].filter(([, rows]) => rows.length >= UNCONFIRMED_PAGE_AT);
    let paged = 0;
    let pageFailures = 0;
    if (groups.length > 0) {
      const names = await tenantNames(db, [...new Set(groups.map(([, rows]) => rows[0]!.tenantId))]);
      for (const [, rows] of groups) {
        const tenantId = rows[0]!.tenantId;
        const day = ubDate(rows[0]!.createdAt);
        let outcome: AlertOutcome;
        try {
          outcome = await raiseAlert(db, {
            tenantId,
            severity: 'warn',
            kind: UNCONFIRMED_ALERT_KIND,
            dedupKey: unconfirmedDedupKey(tenantId, day),
            body: unconfirmedAlertBody({ tenantName: names.get(tenantId) ?? tenantId, day, rows }),
            // A person's cue to look at the wall, so it is sent at once whatever DAILY_REPORT_V2 says.
            route: 'now',
            repeat: 'daily',
          });
        } catch (e) {
          outcome = { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
        if (outcome.outcome === 'sent') paged += 1;
        if (outcome.outcome === 'failed' || outcome.outcome === 'recorded_undelivered') pageFailures += 1;
      }
    }
    return { ok: true, reconciled: scan.reconciled, unconfirmed: scan.unconfirmed.length, paged, pageFailures, capped: scan.capped };
  } catch (e) {
    return { ok: false, detail: `parked reply sweep threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Display names for a page or a report line. A read that fails leaves the ids, never blocks the page. */
async function tenantNames(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await db.from('tenants').select('id, display_name').in('id', [...ids]);
  if (error) return names;
  for (const t of Array.isArray(data) ? data : []) {
    const r = t as Record<string, unknown>;
    if (typeof r['display_name'] === 'string' && r['display_name'] !== '') names.set(String(r['id']), r['display_name']);
  }
  return names;
}

/** The daily report's count, per tenant (display name), for one reported day. */
export type UnconfirmedSummary =
  | { ok: true; byTenant: readonly { tenant: string; count: number }[]; capped: boolean }
  | { ok: false; detail: string };

/**
 * Count the reported day's unconfirmed public replies, per tenant. READ-ONLY: a reply a stored
 * notice proves was posted is not unconfirmed, even if the hourly sweep has not yet moved it.
 */
export async function countUnconfirmed(
  db: SupabaseClient, input: { since: Date; until: Date; now: Date },
): Promise<UnconfirmedSummary> {
  try {
    const scan = await scanParkedReplies(db, { ...input, write: false });
    if (!scan.ok) return scan;
    const counts = new Map<string, number>();
    for (const r of scan.unconfirmed) counts.set(r.tenantId, (counts.get(r.tenantId) ?? 0) + 1);
    const names = await tenantNames(db, [...counts.keys()]);
    return {
      ok: true, capped: scan.capped,
      byTenant: [...counts].map(([id, count]) => ({ tenant: names.get(id) ?? id, count })),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The report line. Printed on a clean day too («none»), so a quiet day and a dead count do not
 * look the same; an unreadable count prints UNREADABLE, never zero.
 */
export function unconfirmedLine(u: UnconfirmedSummary): string {
  if (!u.ok) return 'Public comment replies unconfirmed (yesterday): UNREADABLE — outbound_messages or webhook_events could not be read';
  const rows = u.byTenant.filter((r) => r.count > 0);
  if (rows.length === 0) return 'Public comment replies unconfirmed (yesterday): none';
  const at = u.capped ? '≥' : '';
  // By count, then by name in code-point order (D-026): never locale collation.
  const ordered = [...rows].sort((x, y) => y.count - x.count || (x.tenant < y.tenant ? -1 : x.tenant > y.tenant ? 1 : 0));
  return `Public comment replies unconfirmed (yesterday): ${ordered.map((r) => `${r.tenant} ${at}${r.count}`).join(', ')} — check these threads by hand`;
}
