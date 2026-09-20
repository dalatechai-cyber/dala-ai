/**
 * The 09:00 digest, and the three-day re-escalation.
 *
 * `alerts/alert.ts` stopped the repeat: an `on_change` episode speaks once and then holds
 * its tongue until something changes. That fixes the founder's complaint — one condition
 * was producing a critical Telegram every morning for six days — and it opens the opposite
 * one. A condition that alerts once and then falls silent is forgotten, and three weeks
 * later nobody can tell it from a condition that never happened.
 *
 * Two mechanisms close that, and they are deliberately different in kind:
 *
 *  1. **The digest.** One message a day, at 09:00 Ulaanbaatar — before the salon opens —
 *     listing what is currently open and how long it has been. It is a summary, never an
 *     alarm, and it always arrives at the same moment, so it can never be mistaken for a
 *     new event. That is the whole reason it is separate from the alert path rather than a
 *     batching option on it.
 *  2. **Re-escalation.** An open `critical` nobody has been paged about for three days gets
 *     its own `now` message, outside the digest. Buried in a summary it would read as more
 *     of the same; the point is that it is not.
 *
 * ## It sends even when nothing is open, and that is not the noise this PR removed
 *
 * A digest that stays silent on a clean day makes silence mean two things — "nothing is
 * wrong" and "the digest stopped running" — which is precisely the conflation D-060 and
 * D-062 were about, rebuilt one layer up in the very mechanism meant to be the safety net.
 * So a clean day still sends one short line, and that line carries proof of life: when the
 * silence watchdog last actually ran. If the watchdog has stopped, the clean digest is what
 * says so, and it says it as a finding rather than as an absence.
 *
 * One line a day is not what trained anybody to ignore Telegram. Six criticals about one
 * unchanged condition were.
 *
 * ## Nothing here decides what is broken
 *
 * The digest reads `alerts`. It does not re-run the watchdog, re-check a channel, or form
 * an opinion. A summary that computes its own verdicts is a second implementation of every
 * detector it summarises, and this repository's whole catalogue of incidents is second
 * implementations disagreeing quietly.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  markNotified, openEpisodes, sendTelegram, severityMark, type OpenAlert,
} from './alert.ts';
import { DROPPED_FLAG } from '../inbound/dropped.ts';
import { CAPPED_FLAG } from '../worker/comments.ts';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { tenantClock } from '../time/clock.ts';

/**
 * How long an open `critical` may go unmentioned before it gets its own message again.
 *
 * Three days, set by the founder. Shorter and it is the daily repeat with extra steps;
 * much longer and the digest is carrying the whole weight of not being forgotten.
 */
export const ESCALATE_AFTER_DAYS = 3;

/** Telegram's hard limit is 4096 characters. Stay clear of it rather than at it. */
const MAX_MESSAGE_CHARS = 3800;
const MAX_BODY_CHARS = 200;

/** Criticals first. Within a severity, the oldest open episode leads. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warn: 1, info: 2 };

export type DigestPlan = {
  /** The single summary message. Always present — see the docstring. */
  summary: string;
  /** Open criticals due their own `now` message. Empty on most days. */
  escalate: OpenAlert[];
};

/**
 * Inbound events this platform saw and did not answer, over the last day.
 *
 * Counted by KIND rather than by number alone, because the number on its own is the thing
 * that misled a reader on 2026-09-14: three skipped deliveries look identical whether they
 * were thumbs-up stickers (right to drop) or photographs of the colour a customer wanted
 * (the most valuable message a salon receives). `sticker ×3` and `image ×3` are different
 * mornings.
 */
export type DroppedSummary = {
  total: number;
  /** Attachment kinds where there were attachments; otherwise the skip reason. */
  byKind: Record<string, number>;
  /** The count could not be read. Never folded into zero — see `droppedLine`. */
  unavailable: boolean;
};

/**
 * One clause about dropped inbound, present on every digest including clean ones.
 *
 * Zero says "zero" rather than saying nothing, for the same reason the heartbeat does: a
 * counter that is silent when it finds nothing is indistinguishable from a counter that
 * has stopped, and this one was built precisely because a silent drop went unseen.
 */
export function droppedLine(d: DroppedSummary): string {
  if (d.unavailable) return 'inbound dropped (24h): UNREADABLE — quality_flags could not be counted';
  if (d.total === 0) return 'No inbound events dropped (24h)';
  // Count descending, then by code point. NOT `localeCompare`: this string is assembled on
  // whatever runtime Vercel gives us, and D-026's rule is that ordering never depends on a
  // locale. `check-deterministic-order.mjs` fails the build on the other spelling.
  const parts = Object.entries(d.byKind)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([kind, n]) => `${kind} ×${n}`);
  return `${d.total} inbound dropped unanswered (24h): ${parts.join(', ')}`;
}

/**
 * Public comments the per-post cap silenced, over the last day.
 *
 * The cap's own reasoning says the operator answers *is a cap of 1 costing me customers?*
 * by counting `post_cap_reached`. That counter finally exists; this is what carries it to
 * the one place the founder actually reads.
 *
 * Distinct POSTS as well as the total, because they answer different questions. Six capped
 * comments on one viral post is the cap working exactly as designed — one public answer
 * under a post is the whole rule. Six across six posts is six conversations the salon's
 * wall never got, and only the second is a reason to raise the number.
 */
export type CappedSummary = {
  total: number;
  posts: number;
  /** The count could not be read. Never folded into zero — see `cappedLine`. */
  unavailable: boolean;
};

/**
 * One clause about capped comments, present on every digest including clean ones.
 *
 * Same argument as `droppedLine`: a counter that goes silent when it finds nothing is
 * indistinguishable from a counter that has stopped, and this one exists because a capped
 * comment was invisible for the whole of the rehearsal's first night.
 */
export function cappedLine(c: CappedSummary): string {
  if (c.unavailable) return 'comments capped (24h): UNREADABLE — quality_flags could not be counted';
  if (c.total === 0) return 'No public comments capped (24h)';
  return `${c.total} public comment${c.total === 1 ? '' : 's'} silenced by the per-post cap (24h), `
    + `across ${c.posts} post${c.posts === 1 ? '' : 's'}`;
}

function ageOf(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function clip(text: string, max: number): string {
  // Code points, not UTF-16 units: Mongolian Cyrillic is multibyte and an emoji in a body
  // would otherwise be cut in half, which is how a mojibake character reaches a human.
  const cps = [...text.replace(/\s+/g, ' ').trim()];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max - 1).join('')}…`;
}

/**
 * Compose the digest and pick what to re-escalate. Pure: it reads nothing and sends nothing.
 *
 * `watchdogLastRan` is the proof of life described above — null means `channel_health` holds
 * no observation at all, which on a clean day is the most important thing the message can
 * say.
 */
export function planDigest(
  open: readonly OpenAlert[],
  input: {
    now: Date; watchdogLastRan: Date | null; channelsChecked: number;
    dropped: DroppedSummary; capped: CappedSummary;
  },
): DigestPlan {
  const date = tenantClock(input.now, PLATFORM_TIMEZONE).date;
  const ranked = [...open].sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return bySeverity !== 0 ? bySeverity : a.at.getTime() - b.at.getTime();
  });

  const heartbeat = input.watchdogLastRan === null
    // Not "probably fine". `channel_health` is upserted on EVERY run including healthy ones,
    // precisely so that its absence is a statement, and this is where that pays off.
    ? 'the silence watchdog has never recorded an observation — check that it is running'
    : `silence watchdog last ran ${ageOf(input.watchdogLastRan, input.now)} ago `
      + `(${input.channelsChecked} channel${input.channelsChecked === 1 ? '' : 's'})`;

  const dropped = droppedLine(input.dropped);
  const capped = cappedLine(input.capped);

  if (ranked.length === 0) {
    return { summary: `Dala AI — ${date}\nNothing open. ${heartbeat}.\n${dropped}.\n${capped}.`, escalate: [] };
  }

  const header = `Dala AI — ${date}\n${ranked.length} open condition${ranked.length === 1 ? '' : 's'}. `
    + `${heartbeat}.\n${dropped}.\n${capped}.`;
  const lines: string[] = [];
  let used = header.length;
  let omitted = 0;
  for (const a of ranked) {
    const line = `\n\n${severityMark(a.severity)} ${a.kind} · ${ageOf(a.at, input.now)}\n${clip(a.body, MAX_BODY_CHARS)}`;
    // Counted before appending, and the overflow is REPORTED rather than silently dropped —
    // a summary that quietly omits the item you needed is worse than one that is too long.
    if (used + line.length > MAX_MESSAGE_CHARS) { omitted += 1; continue; }
    used += line.length;
    lines.push(line);
  }
  const tail = omitted > 0 ? `\n\n…and ${omitted} more, not shown (message length).` : '';

  const cutoff = input.now.getTime() - ESCALATE_AFTER_DAYS * 24 * 60 * 60_000;
  const escalate = ranked.filter(
    // `notifiedAt ?? at`: a digest-routed episode was never paged about, so its age runs
    // from when it opened. Null is not "recently told".
    (a) => a.severity === 'critical' && (a.notifiedAt ?? a.at).getTime() < cutoff,
  );

  return { summary: `${header}${lines.join('')}${tail}`, escalate };
}

/** How far back the dropped-inbound count reaches. The digest is daily, so the window is. */
export const DROPPED_WINDOW_HOURS = 24;

/**
 * Count the inbound events nobody answered, by kind, over the last day.
 *
 * ## Why an unreadable count does not 503 the digest, unlike the alerts read
 *
 * The alerts read is the digest's subject: a summary that cannot see `alerts` and answers
 * 200 with "nothing open" is the mechanism claiming a clean day it never checked. This is
 * a second fact carried alongside, and failing the whole job over it would trade a missing
 * clause for a missing digest — including the open criticals it was about to list.
 *
 * So it degrades instead, and the degradation is LOUD: `unavailable` prints as UNREADABLE
 * in the message rather than as zero. A count that reports zero when it failed to look is
 * the exact defect this whole feature exists to remove, and rebuilding it here — inside
 * the thing meant to make drops visible — is the mistake worth naming.
 */
async function countDropped(db: SupabaseClient, now: Date): Promise<DroppedSummary> {
  const since = new Date(now.getTime() - DROPPED_WINDOW_HOURS * 60 * 60_000).toISOString();
  const { data, error } = await db
    .from('quality_flags')
    .select('detail')
    .eq('flag', DROPPED_FLAG)
    .gte('at', since);
  if (error) return { total: 0, byKind: {}, unavailable: true };

  const rows = Array.isArray(data) ? data : [];
  const byKind: Record<string, number> = {};
  for (const row of rows) {
    const detail = (row as Record<string, unknown>)['detail'];
    const d = detail !== null && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    const attachments = d['attachments'];
    // The kind is what a reader needs; the reason is the fallback for a skip that carried
    // no attachment at all — a postback, or an event too malformed to parse.
    const kinds = Array.isArray(attachments) && attachments.length > 0   // ascii-safe: an ARRAY length, not a string — no text is measured here
      ? attachments.map(String)
      : [String(d['reason'] ?? 'unknown')];
    for (const k of kinds) byKind[k] = (byKind[k] ?? 0) + 1;
  }
  return { total: rows.length, byKind, unavailable: false };
}

/**
 * Count them, degrading loudly for `countDropped`'s reason: a zero that means "the read
 * failed" is the defect this clause exists to remove, rebuilt inside it.
 */
async function countCapped(db: SupabaseClient, now: Date): Promise<CappedSummary> {
  const since = new Date(now.getTime() - DROPPED_WINDOW_HOURS * 60 * 60_000).toISOString();
  const { data, error } = await db
    .from('quality_flags')
    .select('detail')
    .eq('flag', CAPPED_FLAG)
    .gte('at', since);
  if (error) return { total: 0, posts: 0, unavailable: true };

  const rows = Array.isArray(data) ? data : [];
  const posts = new Set<string>();
  for (const row of rows) {
    const detail = (row as Record<string, unknown>)['detail'];
    const d = detail !== null && typeof detail === 'object' ? detail as Record<string, unknown> : {};
    const postId = d['post_id'];
    // A row with no `post_id` still counts toward the total; it just cannot be attributed.
    // Silently dropping it would understate the very number this line exists to report.
    if (typeof postId === 'string' && postId !== '') posts.add(postId);
  }
  return { total: rows.length, posts: posts.size, unavailable: false };
}

export type DigestEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (rawBody: string, signature: string | null) => Promise<boolean>;
};

export type DigestJobResult = { status: number; body: Record<string, unknown> };

/**
 * Read, compose, send. The route is an adapter over this, as with purge and health.
 *
 * A failed READ is a 503: a digest that cannot see the alerts table must be retried and
 * must be visible, and answering 200 with an empty summary would be the mechanism claiming
 * a clean day it never checked.
 */
export async function runDigestJob(
  effects: DigestEffects,
  input: { rawBody: string; signature: string | null },
): Promise<DigestJobResult> {
  if (!(await effects.verifySignature(input.rawBody, input.signature))) {
    return { status: 401, body: { error: 'bad_signature' } };
  }

  const episodes = await openEpisodes(effects.db);
  if (!episodes.ok) return { status: 503, body: { error: 'unavailable', detail: episodes.detail } };

  const { data: healthRows, error: healthErr } = await effects.db
    .from('channel_health')
    .select('observed_at')
    .order('observed_at', { ascending: false });
  if (healthErr) {
    return { status: 503, body: { error: 'unavailable', detail: `channel_health unreadable: ${healthErr.message}` } };
  }
  const observed = (Array.isArray(healthRows) ? healthRows : [])
    .map((r) => new Date(String((r as Record<string, unknown>)['observed_at'])))
    .filter((d) => !Number.isNaN(d.getTime()));

  const plan = planDigest(episodes.open, {
    now: effects.now,
    watchdogLastRan: observed[0] ?? null,
    channelsChecked: observed.length,
    dropped: await countDropped(effects.db, effects.now),
    capped: await countCapped(effects.db, effects.now),
  });

  // ALERTS_ENABLED=false silences every path or it silences none of them — the same escape
  // `raiseAlert` honours, applied here so a CI run cannot post to a real chat.
  if (process.env['ALERTS_ENABLED'] === 'false') {
    return {
      status: 200,
      body: { open: episodes.open.length, escalated: 0, sent: false, detail: 'ALERTS_ENABLED=false' },
    };
  }

  const sent = await sendTelegram(plan.summary);
  // NOT a 503. The conditions were read correctly and the row state is unchanged; retrying
  // the whole job would re-send the digest to anyone it did reach. The failure is reported
  // in the body, where the QStash run log keeps it.
  const summarySent = sent.ok;

  // The ids that actually reached Telegram, not a count. Stamping by count assumes the
  // successes are a PREFIX of the list, so one failed send followed by a good one would
  // restart the three-day clock on the message nobody received and leave the delivered one
  // due again tomorrow — silently, and in the direction of saying less.
  const notified: number[] = [];
  for (const a of plan.escalate) {
    const one = await sendTelegram(
      `${severityMark(a.severity)} STILL OPEN after ${ageOf(a.at, effects.now)}: ${clip(a.body, MAX_BODY_CHARS)}`,
    );
    if (one.ok) notified.push(a.id);
  }
  const stamped = await markNotified(effects.db, notified, effects.now);

  return {
    status: 200,
    body: {
      open: episodes.open.length,
      escalated: notified.length,
      sent: summarySent,
      ...(summarySent ? {} : { summary_detail: sent.ok ? '' : sent.detail }),
      ...(stamped.ok ? {} : { stamp_detail: stamped.detail ?? '' }),
    },
  };
}
