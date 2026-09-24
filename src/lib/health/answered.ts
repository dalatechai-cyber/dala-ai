/**
 * Did the Page already answer this customer? Asked before telling the founder it did not.
 *
 * ## The alert this exists to correct
 *
 * `webhook.delivery_exhausted` and `webhook.stranded_event` say a customer is waiting and «a
 * human can still answer». On a `live` channel that is the right thing to say: Dala AI is
 * the one who answers, and it failed. On a `shadow` channel it is false twice over. Our
 * reply was never going to reach the customer — the mirror withholds by design — and the
 * incumbent on the same Page answered them anyway.
 *
 * Measured, 2026-09-22 to 2026-09-24: Matrix had been in `canned_stale` since a data edit
 * after seq 12, so every mirror draft refused, and QStash exhausted on every message.
 * **Thirty-seven critical alerts** (29 exhausted, 8 stranded) reached the Telegram chat
 * that carries customers' demo requests, each one telling the founder to answer a customer.
 * The ancestor had already answered all of them, in 4.5–20.9 seconds by Meta's clock.
 * The founder's words: *"It's a false alarm, and I got 44 of them."*
 *
 * ## The evidence is an echo, and the clock is Meta's on both sides
 *
 * `message_echoes` has been subscribed on Matrix's Page since 2026-09-21, so every message
 * the Page sends arrives here as an echo, whoever sent it. An echo to this customer,
 * stamped at or after their own message, is the Page having answered them.
 *
 * Both timestamps are Meta's own — the customer's `timestamp` and the echo's. Mixing in
 * `webhook_events.received_at`, which is OUR clock, is the error `side-by-side.sql`
 * documents: the receipt hop was 1.3–6.4 s on measured traffic, which is larger than the
 * fastest reply here. `received_at` is used only to BOUND the scan, with slack for exactly
 * that hop.
 *
 * ## What "answered" does and does not mean, stated rather than discovered
 *
 * It means the Page sent this customer SOMETHING after they wrote. It does not mean the
 * reply addressed this message: two messages seconds apart and one reply would count both
 * as answered. The ancestor answers each message separately, and a person replying in the
 * inbox is the conversation going on without us, so for the question the alert asks —
 * *is somebody left waiting?* — this is the right evidence. It is not a quality judgement.
 *
 * An echo from OUR OWN app is excluded. In shadow there are none, and a channel that is
 * sending is not the case this module is consulted for; excluding it keeps "answered"
 * meaning "answered by someone other than the bot that failed".
 *
 * ## Every uncertain case keeps the alert
 *
 * An unreadable scan, a truncated scan, a turn with no timestamp, a channel whose mode was
 * never read: each of those pages the founder exactly as before, with a sentence saying why
 * the check could not settle it. The only thing this module can do is REMOVE a page, and
 * it does that only on positive evidence. A check that silenced alerts on a failed read
 * would be the watchdog acquiring the defect it exists to detect (D-060, D-062).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canDeliver } from '../channel/delivery.ts';
import { extractInboundMessages } from '../meta/extract.ts';

/**
 * How many webhook rows one check will read.
 *
 * The scan starts at the customer's message, so for the exhaustion alert it covers about
 * three minutes and for the hourly sweep at most a couple of hours. Matrix's busiest
 * measured hour carried well under a hundred rows of any kind. A scan that hits the limit
 * without finding every reply is UNDETERMINED, never "unanswered" and never "answered".
 */
export const ANSWER_SCAN_LIMIT = 200;

/**
 * Slack on the `received_at` bound, for the receipt hop and for Meta delivering the echo
 * webhook before the inbound one. Only widens the scan; the comparison itself is on Meta's
 * clock.
 */
export const RECEIPT_SLACK_MS = 2 * 60_000;

/** A customer message, as the question needs it: who wrote, and when by Meta's clock. */
export type CustomerTurn = { psid: string; sentAt: Date };

export type PageAnswered =
  /** Every turn has a later echo to its sender. `slowestSeconds` is the longest wait. */
  | { verdict: 'answered'; slowestSeconds: number }
  | { verdict: 'unanswered' }
  | { verdict: 'undetermined'; detail: string };

/** The customer turns in one stored entry, for a caller that holds only `raw_payload`. */
export function turnsOf(rawPayload: unknown): CustomerTurn[] {
  return extractInboundMessages(rawPayload).messages.map((m) => ({ psid: m.senderId, sentAt: m.sentAt }));
}

export async function pageAnsweredAll(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; ourAppId: string | null; turns: readonly CustomerTurn[] },
): Promise<PageAnswered> {
  if (input.turns.length === 0) return { verdict: 'undetermined', detail: 'no customer message in the event' };
  if (input.turns.some((t) => Number.isNaN(t.sentAt.getTime()))) {
    return { verdict: 'undetermined', detail: 'a customer message carried no timestamp' };
  }
  const earliest = Math.min(...input.turns.map((t) => t.sentAt.getTime()));

  const { data, error } = await db
    .from('webhook_events')
    .select('raw_payload')
    .eq('tenant_id', input.tenantId)
    .eq('channel_id', input.channelId)
    .gte('received_at', new Date(earliest - RECEIPT_SLACK_MS).toISOString())
    .order('received_at')
    .limit(ANSWER_SCAN_LIMIT);
  if (error) return { verdict: 'undetermined', detail: `webhook_events unreadable: ${error.message}` };
  const rows = Array.isArray(data) ? data : [];

  // The Page's replies to each customer, by Meta's clock. A purged `raw_payload` parses to
  // nothing, which can only make a reply invisible — the direction that keeps the alert.
  const replies = new Map<string, number[]>();
  for (const row of rows) {
    const { skipped } = extractInboundMessages((row as Record<string, unknown>)['raw_payload']);
    for (const s of skipped) {
      if (s.reason !== 'echo' || s.recipientId === null || s.sentAt === null) continue;
      if (input.ourAppId !== null && s.appId === input.ourAppId) continue;
      replies.set(s.recipientId, [...(replies.get(s.recipientId) ?? []), s.sentAt.getTime()]);
    }
  }

  let slowest = 0;
  for (const turn of input.turns) {
    const after = (replies.get(turn.psid) ?? []).filter((at) => at >= turn.sentAt.getTime());
    if (after.length === 0) {
      return rows.length >= ANSWER_SCAN_LIMIT
        ? { verdict: 'undetermined', detail: `scan stopped at ${ANSWER_SCAN_LIMIT} rows` }
        : { verdict: 'unanswered' };
    }
    slowest = Math.max(slowest, (Math.min(...after) - turn.sentAt.getTime()) / 1000);
  }
  return { verdict: 'answered', slowestSeconds: slowest };
}

/**
 * Should an unanswered-customer alert page the founder now?
 *
 * `page: false` only when BOTH hold: the channel would not have sent our reply anyway, and
 * the Page answered every customer in the event. `note` is a sentence for the alert body
 * when the check ran and still pages — so a shadow alert says it is a shadow alert.
 */
export type UnansweredRoute =
  | { page: true; note: string | null }
  | { page: false; slowestSeconds: number };

export async function routeUnansweredAlert(
  db: SupabaseClient,
  input: {
    tenantId: string;
    channelId: string | null;
    /** `tenant_channels.delivery_mode`, or null when the job refused before reading it. */
    deliveryMode: string | null;
    ourAppId: string | null;
    turns: readonly CustomerTurn[];
  },
): Promise<UnansweredRoute> {
  // Unknown mode: say nothing new. This is today's behaviour, and the right default for a
  // channel that may be live.
  if (input.deliveryMode === null || input.channelId === null) return { page: true, note: null };
  // A channel that sends: Dala AI IS the answer, so a failure is a customer left waiting.
  if (canDeliver(input.deliveryMode).deliver) return { page: true, note: null };

  const found = await pageAnsweredAll(db, {
    tenantId: input.tenantId, channelId: input.channelId, ourAppId: input.ourAppId, turns: input.turns,
  });
  const mode = input.deliveryMode;
  if (found.verdict === 'answered') return { page: false, slowestSeconds: found.slowestSeconds };
  if (found.verdict === 'unanswered') {
    return {
      page: true,
      note: `This channel is in ${mode}, so Dala AI would not have sent a reply anyway — and no reply `
        + 'from the Page to this customer has been seen since they wrote, so the incumbent may not have '
        + 'answered either.',
    };
  }
  return {
    page: true,
    note: `This channel is in ${mode}, so Dala AI would not have sent a reply anyway; whether the Page `
      + `answered could not be checked (${found.detail}).`,
  };
}

/** The alert kind a lost shadow draft is recorded under, for the digest to count. */
export const DRAFT_LOST_KIND = 'mirror.draft_lost';

/**
 * One row per event, shared by the worker and the sweep: both can reach the same event,
 * and the digest should count one lost draft once.
 */
export function draftLostDedupKey(eventId: number): string {
  return `draft_lost:${eventId}`;
}
