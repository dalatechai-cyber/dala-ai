/**
 * Taking a chat back when staff took it and then went quiet (founder, 2026-09-30,
 * superseding D-162).
 *
 * > "If staff have taken over a chat and nobody has replied within 2 hours during the
 * > salon's opening hours, Дали sends one approved line and resumes."
 *
 * ## What was wrong
 *
 * A staff reply typed in the Page inbox (an echo, `record.ts`) or a Meta handover event
 * makes a thread `human`, and the reception worker then holds every customer message for the
 * tenant's takeover cooldown (`humanHoldsThread`, check 4). A held message is never looked
 * at again: nothing re-drives it once the cooldown has run. Measured on Tara's Page: a
 * customer who wrote two seconds after a staff reply waited ~33 hours for the next staff
 * answer, and another ~24.5 hours. The bot was allowed to speak after thirty minutes; no
 * message arrived to let it.
 *
 * ## The design: the hourly health run finds them, the reception worker sends
 *
 * `reclaimHeldConversations` runs inside the hourly health job (`worker/health.ts`). It
 * reads, decides with the pure `decideReclaim`, and for each conversation that qualifies
 * re-enqueues the held message's OWN stored webhook event to the reception worker with
 * `reclaimMid` — the shape `channel/catchup.ts` already uses with `catchUpMid`. The worker
 * (`worker/reclaim.ts`) then serves the tenant's reviewed `handover_reclaim` row bytes
 * through the one send path every reply uses: the channel's token and Page, `draftOnce`,
 * `claim`'s CAS, `deliver`, and the person-replied re-check before the send. There is no
 * second sender, and nothing here calls a model or spends.
 *
 * Why the hourly run and not a delayed QStash message at hold time: "two OPENING hours" is
 * not a wall-clock delay, so a message held at 19:30 by a salon closing at 20:00 would need
 * rescheduling across the night; and the health run is already signed, scheduled and
 * retried. The cost is latency: the send happens at the first hourly run after 120 open
 * minutes have passed, so up to about **three hours** after the customer wrote on an open
 * afternoon. The cadence lives in the QStash console, not this repository.
 *
 * ## Which threads, and why only `echo`
 *
 * - **`echo`**: staff typed in the Page inbox. Meta moved nothing; this platform inferred a
 *   person. After the cooldown the ordinary path already answers such threads without any
 *   Graph call, so a send here is the proven path. These are reclaimed.
 * - **`handover`**: Meta named another app as the owner (or the bot's own media hand-off
 *   wrote it). If Meta really holds the thread elsewhere, reclaiming needs
 *   `take_thread_control` (`graph.ts`) first, a live mutation of the salon's inbox that has
 *   never been exercised and whose effect on a Page Inbox that is the primary receiver is not
 *   known here. So these are NOT sent to, and NOT paged: they are counted
 *   (`meta_holds_thread`) at the moment a send would have happened. Not paged because the
 *   bot's own media hand-off (`media.ts`) also writes `handover`, so a page saying "staff took
 *   the chat through Meta's inbox" would be false for every photo, and it would re-create the
 *   hand-off page the founder switched off for Tara (D-153).
 * - **`passed`**: this platform's own Graph pass. Nothing writes it today (D-162 left the
 *   pass unwired). It is a Meta ownership change like `handover`, so it is treated like one.
 *   The old 15-minute reclaim of `passed` threads (D-091) is retired with the sweeper that
 *   implemented it; the Graph take stays in `graph.ts`, wired to nothing.
 *
 * ## The decision is pure, and the SQL filter is not it
 *
 * The query narrows; `decideReclaim` decides, and it is what the tests assert. D-064 found a
 * filter that could not exclude a row because nothing wrote the column.
 *
 * ## Inert until the founder approves the wording
 *
 * A tenant with no REVIEWED `handover_reclaim` row gets nothing: no send, no flip. Every
 * conversation that WOULD have been sent to is counted `no_reviewed_line`, so a switched-off
 * feature never reads as a clean zero.
 *
 * ## The sweep pages nobody
 *
 * The only page on this path is the worker's `reclaim_sent`, raised after a line went out
 * and the thread was flipped. The sweep itself only counts, in the health run's receipt:
 * - `window_missed`: the message aged past the send limit before a send happened. Not paged,
 *   because the sweep cannot tell a customer it failed from one it never could have served
 *   (a message that aged out before the reviewed line existed, before the first sweep after
 *   deploy, or in a closure that ate the two open hours), and switching the feature on would
 *   otherwise page every 23 to 48 hour old held message at once.
 * - `meta_holds_thread`: see above.
 * - `reclaim_refused`: the worker refused this message for good (a person had replied, or
 *   the send failed in a way no retry fixes). Its row is `refused`, so it is never retried.
 *
 * ## Crash order
 *
 * Send first, flip after (the worker). A crash after the send leaves the thread `human` with
 * the reclaim row `sent`; the next sweep sees that row and re-enqueues, and the worker's
 * claim answers `already_sent` and only flips. The row's dedup key is Meta's own `mid`
 * (`reclaim:<mid>`), so no sweep, retry or redelivery can send the line twice for one held
 * message.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ControlSource } from './record.ts';
import type { ThreadControl } from './control.ts';
import type { OutboundState } from '../outbound/claim.ts';
import type { EnqueueResult } from '../queue/qstash.ts';
import { openAt, openMinutesSince } from '../health/silence.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';
import { tenantClock } from '../time/clock.ts';
import { readCannedLine } from './media.ts';

/** The canned row the customer is sent. Served whole, no model. Model-invisible (`gate/match.ts`). */
export const RECLAIM_KIND = 'handover_reclaim';

/** Founder, 2026-09-30: two hours, counted only while the salon is open. */
export const RECLAIM_AFTER_OPEN_MINUTES = 120;

/**
 * The oldest held message a reclaim is sent for. Meta's standard messaging window is 24
 * hours from the customer's message; this stops an hour short because the job is enqueued,
 * then delivered, and QStash's last redelivery was measured about 33 minutes after the first
 * (`RECEPTION_MAX_DELIVERIES`). The worker re-checks the same limit against Meta's own
 * timestamp before it sends.
 */
export const RECLAIM_MAX_AGE_MINUTES = 23 * 60;

/**
 * How far back the sweep looks. Past the send window, so a line sent just inside it whose
 * flip was lost is still finished, and a message that aged out while unanswered is counted
 * (`window_missed`); bounded, so it is not counted every hour for ever.
 */
export const RECLAIM_LOOKBACK_MINUTES = 48 * 60;

/** `reclaim:<mid>`: Meta's own message id, so one held message gets one line (D-039). */
export function reclaimDedupKey(mid: string): string {
  return `reclaim:${mid}`;
}

/** One conversation, as the sweep reads it. */
export type ReclaimFacts = {
  readonly control: ThreadControl;
  /** Null for every conversation that predates `0027`. */
  readonly source: ControlSource | null;
  /** The last staff activity: when control moved, or the last staff echo refreshed it. */
  readonly controlAt: Date | null;
  /** The customer's latest stored message (`messages.at`, our clock, as `controlAt` is). */
  readonly latest: { readonly externalId: string; readonly at: Date } | null;
  /** The state of this message's own reclaim row, null when there is none. */
  readonly reclaimRow: OutboundState | null;
  /** A reply of ours, other than the reclaim row, drafted at or after the message and sent or sending. */
  readonly botReplied: boolean;
  readonly now: Date;
  readonly schedule: { readonly timezone: string; readonly hours: readonly BusinessHours[]; readonly closures: readonly Closure[] };
};

export type ReclaimSkip =
  /** Control is `bot` or `unknown`: nothing is held. */
  | 'not_human'
  /** `human` with no timestamp: read as current, as check 4 reads it. */
  | 'no_timestamp'
  | 'no_customer_message'
  /** Staff acted after the customer's latest message: nobody is waiting on the bot. */
  | 'staff_replied_after'
  | 'bot_replied'
  /**
   * The worker refused this message for good and marked its row `refused`: a person had
   * replied, or the send failed in a way no retry fixes. Terminal.
   */
  | 'reclaim_refused'
  /** Parked by `deliver` and already alerted: no automatic retry may touch it. */
  | 'reclaim_indeterminate'
  | 'reclaim_in_flight'
  /** `human` from a source this rule does not cover (null: predates `0027`). */
  | 'unknown_source'
  /** Past the send limit before a send happened. Counted, never paged (module docstring). */
  | 'window_missed'
  /** `handover`/`passed`: Meta may hold the thread elsewhere. Counted, never sent to or paged. */
  | 'meta_holds_thread'
  /** Fewer than two opening hours have passed. */
  | 'waiting'
  | 'closed_now'
  /** No usable `business_hours` row on a day the walk crossed: cannot count, so does not act. */
  | 'hours_not_configured';

export type ReclaimVerdict =
  /**
   * Send the reviewed line and hand the thread back to the bot. `openMinutesAtLeast` is a
   * FLOOR: the walk stops once it has counted past the threshold, as the silence watch does.
   */
  | { readonly action: 'send'; readonly openMinutesAtLeast: number }
  /** The line was sent and the thread not flipped (a crash between the two): flip only. */
  | { readonly action: 'finish' }
  | { readonly action: 'skip'; readonly reason: ReclaimSkip };

/**
 * May this conversation be taken back now?
 *
 * Pure. Ordered so each refusal names the narrowest true reason, and so every question that
 * can be answered without the schedule is answered before the walk.
 */
export function decideReclaim(f: ReclaimFacts): ReclaimVerdict {
  const skip = (reason: ReclaimSkip): ReclaimVerdict => ({ action: 'skip', reason });
  if (f.control !== 'human') return skip('not_human');
  if (f.controlAt === null) return skip('no_timestamp');
  if (f.latest === null) return skip('no_customer_message');
  // Strictly after. A staff echo stored at the same instant as the message is staff acting.
  if (f.latest.at.getTime() <= f.controlAt.getTime()) return skip('staff_replied_after');

  switch (f.reclaimRow) {
    case 'sent': return { action: 'finish' };
    case 'refused': return skip('reclaim_refused');
    case 'indeterminate': return skip('reclaim_indeterminate');
    case 'sending': case 'claiming': return skip('reclaim_in_flight');
    default: break; // none, draft or failed: still to be sent
  }
  if (f.botReplied) return skip('bot_replied');
  if (f.source !== 'echo' && f.source !== 'handover' && f.source !== 'passed') return skip('unknown_source');

  const ageMinutes = (f.now.getTime() - f.latest.at.getTime()) / 60_000;
  if (ageMinutes >= RECLAIM_MAX_AGE_MINUTES) return skip('window_missed');

  const walked = openMinutesSince(
    { ...f.schedule, now: f.now, thresholdOpenMinutes: RECLAIM_AFTER_OPEN_MINUTES },
    f.latest.at,
  );
  if ('notConfigured' in walked) return skip('hours_not_configured');
  if (walked.minutes < RECLAIM_AFTER_OPEN_MINUTES) return skip('waiting');

  const openNow = openAt(f.schedule, f.now);
  if (openNow === null) return skip('hours_not_configured');
  if (!openNow) return skip('closed_now');

  if (f.source !== 'echo') return skip('meta_holds_thread');
  return { action: 'send', openMinutesAtLeast: Math.floor(walked.minutes) };
}

/* ------------------------------------------------------------------------- *
 * The sweep
 * ------------------------------------------------------------------------- */

export type ReclaimJob = {
  provider: string; dedupKey: string; eventId: number; tenantId: string; channelId: string; reclaimMid: string;
};

export type ReclaimSweepInput = {
  now: Date;
  enqueue: (job: ReclaimJob) => Promise<EnqueueResult>;
};

export type ReclaimSweepOutcome =
  | { ok: true; channels: number; counts: Record<string, number> }
  | { ok: false; detail: string };

/** Bound on each list read. */
const LIMIT = 500;

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

export type OpenScheduleRead =
  | { ok: true; schedule: ReclaimFacts['schedule'] }
  | { ok: false; detail: string };

/**
 * A tenant's week and the closures that could touch a walk back to `oldest`. Shared by the
 * sweep and the worker's own "open now" re-check, so the two read the same calendar.
 */
export async function readOpenSchedule(
  db: SupabaseClient,
  input: { tenantId: string; timezone: string; oldest: Date },
): Promise<OpenScheduleRead> {
  const { tenantId, timezone } = input;
  // No default zone: a wrong calendar would count the wrong hours as open.
  if (timezone === '') return { ok: false, detail: 'tenant timezone missing' };
  // The date is on the tenant's own calendar, with a day of slack so a read filter can never
  // exclude a closure the walk reaches.
  const oldestDate = tenantClock(new Date(input.oldest.getTime() - 24 * 60 * 60_000), timezone).date;
  const [hoursRes, closuresRes] = await Promise.all([
    db.from('business_hours').select('weekday, opens, closes, closed').eq('tenant_id', tenantId).order('weekday'),
    db.from('tenant_closures').select('starts_on, ends_on, title, message').eq('tenant_id', tenantId).gte('ends_on', oldestDate),
  ]);
  if (hoursRes.error) return { ok: false, detail: `business_hours: ${hoursRes.error.message}` };
  if (closuresRes.error) return { ok: false, detail: `tenant_closures: ${closuresRes.error.message}` };
  const hours: BusinessHours[] = rows(hoursRes.data).map((r) => ({
    weekday: Number(r['weekday']),
    opens: r['opens'] === null ? null : str(r['opens']),
    closes: r['closes'] === null ? null : str(r['closes']),
    closed: r['closed'] === true,
  }));
  const closures: Closure[] = rows(closuresRes.data).map((r) => ({
    startsOn: str(r['starts_on']), endsOn: str(r['ends_on']), title: str(r['title']), message: str(r['message']),
  }));
  return { ok: true, schedule: { timezone, hours, closures } };
}

type TenantView =
  | { ok: true; schedule: ReclaimFacts['schedule']; line: 'reviewed' | 'none' | 'unreadable' }
  | { ok: false; detail: string };

/** A tenant's clock, week, closures and whether it has a reviewed line. Read once per run. */
async function readTenant(db: SupabaseClient, tenantId: string, now: Date): Promise<TenantView> {
  const tenant = await db.from('tenants').select('timezone, default_locale').eq('id', tenantId).maybeSingle();
  if (tenant.error || tenant.data === null) return { ok: false, detail: `tenants: ${tenant.error?.message ?? 'no row'}` };
  const t = tenant.data as Record<string, unknown>;
  const timezone = str(t['timezone']);
  const locale = str(t['default_locale']) || 'mn-MN';
  const [schedule, line] = await Promise.all([
    readOpenSchedule(db, { tenantId, timezone, oldest: new Date(now.getTime() - RECLAIM_LOOKBACK_MINUTES * 60_000) }),
    readCannedLine(db, { tenantId, locale, kind: RECLAIM_KIND }),
  ]);
  if (!schedule.ok) return schedule;
  return {
    ok: true,
    schedule: schedule.schedule,
    line: !line.ok ? 'unreadable'
      : line.line !== null && line.line.reviewed && line.line.body.trim() !== '' ? 'reviewed' : 'none',
  };
}

/**
 * Find every chat staff took and left, and act on each: enqueue the reclaim, or finish one a
 * crash interrupted. Everything else is counted, never paged. Refuses the run (`ok: false`)
 * only when the channel or conversation lists are unreadable; any narrower read failure
 * skips that tenant or conversation this run, counted `unreadable`, and sends nothing for it.
 */
export async function reclaimHeldConversations(db: SupabaseClient, input: ReclaimSweepInput): Promise<ReclaimSweepOutcome> {
  const counts: Record<string, number> = {};

  // Live, delivering Messenger and Instagram channels only. `shadow` never reaches here.
  const channels = await db
    .from('tenant_channels')
    .select('id, tenant_id, provider')
    .in('provider', ['facebook_page', 'instagram'])
    .eq('delivery_mode', 'live')
    .eq('token_status', 'active');
  if (channels.error) return { ok: false, detail: `tenant_channels unreadable: ${channels.error.message}` };
  const live = new Map(rows(channels.data).map((c) => [str(c['id']), c]));
  if (live.size === 0) return { ok: true, channels: 0, counts };

  const since = new Date(input.now.getTime() - RECLAIM_LOOKBACK_MINUTES * 60_000);
  const convRes = await db
    .from('conversations')
    .select('id, tenant_id, channel_id, thread_control, thread_control_source, thread_control_at')
    .in('channel_id', [...live.keys()])
    .eq('thread_control', 'human')
    .gte('last_message_at', since.toISOString())
    .order('last_message_at', { ascending: true })
    .limit(LIMIT);
  if (convRes.error) return { ok: false, detail: `conversations unreadable: ${convRes.error.message}` };

  const tenants = new Map<string, TenantView>();
  for (const conv of rows(convRes.data)) {
    const tenantId = str(conv['tenant_id']);
    const channelId = str(conv['channel_id']);
    const conversationId = str(conv['id']);
    const channel = live.get(channelId);
    // The composite key keeps a channel inside its tenant; a mismatch is not ours to act on.
    if (channel === undefined || str(channel['tenant_id']) !== tenantId) { bump(counts, 'channel_mismatch'); continue; }

    let view = tenants.get(tenantId);
    if (view === undefined) {
      view = await readTenant(db, tenantId, input.now).catch((e: unknown) =>
        ({ ok: false as const, detail: e instanceof Error ? e.message : String(e) }));
      tenants.set(tenantId, view);
      if (!view.ok) console.error('[reclaim] tenant_unreadable', { tenantId, detail: view.detail });
    }
    if (!view.ok) { bump(counts, 'unreadable'); continue; }

    const facts = await readFacts(db, { tenantId, conversationId, conv, now: input.now, schedule: view.schedule });
    if (facts === 'unreadable') { bump(counts, 'unreadable'); continue; }
    const verdict = decideReclaim(facts);
    if (verdict.action === 'skip') { bump(counts, verdict.reason); continue; }

    // Inert without the founder's approved line. `finish` is exempt: the line was already
    // sent under an earlier approval, and leaving the thread `human` would only keep the
    // customer's next message waiting.
    if (verdict.action === 'send') {
      if (view.line === 'unreadable') { bump(counts, 'reclaim_line_unreadable'); continue; }
      if (view.line === 'none') { bump(counts, 'no_reviewed_line'); continue; }
    }
    const mid = facts.latest?.externalId ?? '';

    const event = await db.from('webhook_events')
      .select('id, provider')
      .eq('tenant_id', tenantId).eq('channel_id', channelId)
      .contains('raw_payload', { messaging: [{ message: { mid } }] })
      .order('id', { ascending: true }).limit(1);
    if (event.error) { bump(counts, 'unreadable'); continue; }
    const ev = rows(event.data)[0];
    // Purged, or never stored: nothing to hand the worker. The customer is still waiting.
    if (ev === undefined) { bump(counts, 'event_missing'); continue; }
    const queued = await input.enqueue({
      provider: str(ev['provider']) || 'meta',
      // Its own QStash identity, and a new one each hour: the sweep is the retry loop, and a
      // failed first attempt must not be swallowed by the queue's dedup window. The send
      // itself is deduplicated by the row's key, not by this.
      dedupKey: `${reclaimDedupKey(mid)}:${Math.floor(input.now.getTime() / 3_600_000)}`,
      eventId: Number(ev['id']), tenantId, channelId, reclaimMid: mid,
    });
    if (!queued.ok) { bump(counts, 'enqueue_failed'); console.error('[reclaim] enqueue_failed', { conversationId, detail: queued.detail }); continue; }
    bump(counts, verdict.action === 'send' ? 'enqueued' : 'finish_enqueued');
  }
  return { ok: true, channels: live.size, counts };
}

async function readFacts(
  db: SupabaseClient,
  c: { tenantId: string; conversationId: string; conv: Record<string, unknown>; now: Date; schedule: ReclaimFacts['schedule'] },
): Promise<ReclaimFacts | 'unreadable'> {
  const base = {
    control: (str(c.conv['thread_control']) || 'unknown') as ThreadControl,
    source: (c.conv['thread_control_source'] ?? null) as ControlSource | null,
    controlAt: date(c.conv['thread_control_at']),
    now: c.now, schedule: c.schedule,
  };
  const latestRes = await db.from('messages').select('external_id, at')
    .eq('tenant_id', c.tenantId).eq('conversation_id', c.conversationId).eq('direction', 'inbound')
    .order('at', { ascending: false }).limit(1);
  if (latestRes.error) return 'unreadable';
  const m = rows(latestRes.data)[0];
  const at = m === undefined ? null : date(m['at']);
  const mid = m === undefined ? '' : str(m['external_id']);
  // A stored message with no Meta id cannot be keyed or re-driven; an unparseable time cannot
  // be measured. Neither is "no message".
  if (m !== undefined && (at === null || mid === '')) return 'unreadable';
  if (m === undefined || at === null) return { ...base, latest: null, reclaimRow: null, botReplied: false };

  const outRes = await db.from('outbound_messages').select('dedup_key, state')
    .eq('tenant_id', c.tenantId).eq('conversation_id', c.conversationId)
    .gte('created_at', at.toISOString())
    .limit(LIMIT);
  if (outRes.error) return 'unreadable';
  const key = reclaimDedupKey(mid);
  let reclaimRow: OutboundState | null = null;
  let botReplied = false;
  for (const r of rows(outRes.data)) {
    const state = str(r['state']) as OutboundState;
    if (str(r['dedup_key']) === key) { reclaimRow = state; continue; }
    // A reply parked `indeterminate` may have reached the customer: counted as replied, the
    // direction that cannot double-message.
    if (state === 'sent' || state === 'sending' || state === 'claiming' || state === 'indeterminate') botReplied = true;
  }
  return { ...base, latest: { externalId: mid, at }, reclaimRow, botReplied };
}
