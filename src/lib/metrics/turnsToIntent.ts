/**
 * Turns to intent: how many replies a customer spends to get the thing they asked for.
 *
 * ## The measurement that prompted it
 *
 * On 2026-09-07 the founder ran a booking conversation through Matrix's live bot. A
 * customer who says «цаг авмаар байна» is asked their gender, then the stylist tier, then
 * given a price, and only then the booking link. **Four replies to deliver one link**, on
 * a Page where 721 people had already gone unanswered.
 *
 * Coverage — did we answer at all — cannot see that. Both a one-reply booking and a
 * four-reply booking are answered. The difference is the customer's patience, and the
 * measurable part of it is the count.
 *
 * ## What it counts
 *
 * From the first inbound message expressing the intent, the number of OUTBOUND messages up
 * to and including the first one carrying the booking URL. The ancestor's transcript above
 * scores **4**. A reply that leads with the link scores **1**.
 *
 * ## `not_delivered` is not a low score, and reading it as one inverts the metric
 *
 * A bot that never sends the link at all produces no count. Averaged naively that is an
 * absent number rather than a bad one, so the worst possible behaviour would improve the
 * headline. `summarise` therefore reports `notDelivered` as its own count, computes the
 * median over delivered conversations only, and never folds the two together. The test for
 * that property is a DONE-TEST because it is the way this file would lie.
 *
 * `no_intent` is a third thing again — the customer never asked to book — and is excluded
 * from the denominator rather than scored. Counting those as failures would make the
 * metric a measure of how many customers happen to want a booking.
 *
 * ## This decides nothing
 *
 * `gate/match.ts` carries the arbitration's rule that matchers run inbound **only** to
 * select which gate text is rendered, never as an unanchored pattern that suppresses a
 * reply. Nothing here is on the reply path at all: it reads stored messages after the
 * fact. A wrong match costs an inaccurate number in a report, never a refused customer.
 *
 * The URL check runs over OUR OWN outbound text, which is the one place the repository
 * already permits a substring test — `guard/outbound.ts` does the same thing for the same
 * reason. The intent check runs over CUSTOMER text and therefore goes through
 * `mn/match.ts`'s folded, segmented stem matching, never a substring.
 *
 * ## The stems are data, and deliberately not in this file
 *
 * What counts as "asking to book" is Mongolian that changes the number, so it is a
 * parameter rather than a constant here. Hard-coding a list would put per-tenant language
 * in code, which is the thing the repository's central test forbids, and would put
 * customer-adjacent Mongolian outside the review mechanism. `MIN_STEM_CHARS` is enforced
 * rather than assumed: «цаг» is three characters and fires on «цагийн хуваарь», which is
 * an opening-hours question and the exact confusion Ш3's own closing line warns about.
 */
import { firstMatchingStem } from '../mn/match.ts';
import { MIN_STEM_CHARS } from '../gate/match.ts';
import { cpLength, nfc } from '../mn/text.ts';

export type ConversationTurn = {
  direction: 'inbound' | 'outbound';
  body: string;
};

export type TurnsResult =
  /** The link arrived. `turns` is the number of replies it took, 1 being immediate. */
  | { outcome: 'delivered'; turns: number; intentStem: string }
  /** The customer asked and never got the link. NOT a score — see the header. */
  | { outcome: 'not_delivered'; turns: null; intentStem: string }
  /** Nobody asked to book. Excluded from the denominator, not counted as a failure. */
  | { outcome: 'no_intent'; turns: null; intentStem: null };

export type IntentSpec = {
  /** Stems marking a booking request. Tenant data; see the header. */
  intentStems: readonly string[];
  /** `tenant_booking.booking_url`. A reply carrying it has delivered the intent. */
  bookingUrl: string;
};

/** Trailing slash and case are not differences. Compared against our own text only. */
function urlForms(bookingUrl: string): string[] {
  const base = nfc(bookingUrl).trim().toLowerCase();
  const bare = base.endsWith('/') ? base.slice(0, -1) : base;
  return [bare, `${bare}/`];
}

function assertSpec(spec: IntentSpec): void {
  if (nfc(spec.bookingUrl).trim() === '') {
    // An empty needle is found in every reply, so every conversation would score 1 and
    // the metric would report a triumph on a bot that had said nothing.
    throw new Error('turnsToBookingLink: bookingUrl is empty; every reply would match');
  }
  if (spec.intentStems.length === 0) {
    throw new Error('turnsToBookingLink: no intent stems; every conversation would read as no_intent');
  }
  for (const stem of spec.intentStems) {
    if (cpLength(nfc(stem)) < MIN_STEM_CHARS) {
      // Refuse rather than skip, for `gate/match.ts`'s reason: a silently dropped stem
      // makes the metric quietly measure a narrower question than the one asked.
      throw new Error(
        `turnsToBookingLink: stem ${JSON.stringify(stem)} is shorter than MIN_STEM_CHARS `
        + `(${MIN_STEM_CHARS}); short stems over Mongolian over-match badly`,
      );
    }
  }
}

export function turnsToBookingLink(
  turns: readonly ConversationTurn[],
  spec: IntentSpec,
): TurnsResult {
  assertSpec(spec);
  const forms = urlForms(spec.bookingUrl);

  let intentAt = -1;
  let intentStem: string | null = null;
  for (const [i, turn] of turns.entries()) {
    if (turn.direction !== 'inbound') continue;
    const stem = firstMatchingStem(turn.body, spec.intentStems);
    if (stem !== null) { intentAt = i; intentStem = stem; break; }
  }
  if (intentAt === -1 || intentStem === null) return { outcome: 'no_intent', turns: null, intentStem: null };

  // Replies are counted from the intent onward, so a link the bot volunteered EARLIER does
  // not pay for a later request. A customer who asks again after being sent the link is
  // asking again, and the count restarts from their asking.
  let replies = 0;
  for (const turn of turns.slice(intentAt + 1)) {
    if (turn.direction !== 'outbound') continue;
    replies += 1;
    const body = nfc(turn.body).toLowerCase();       // ascii-safe: our own text, per the header
    if (forms.some((f) => body.includes(f))) {
      return { outcome: 'delivered', turns: replies, intentStem };
    }
  }
  return { outcome: 'not_delivered', turns: null, intentStem };
}

export type TurnsSummary = {
  /** Every conversation looked at, including those where nobody asked to book. */
  conversations: number;
  /** The denominator: conversations where somebody asked. */
  withIntent: number;
  delivered: number;
  /** Reported beside the median, never inside it. */
  notDelivered: number;
  /** Ascending, delivered conversations only. */
  counts: readonly number[];
  median: number | null;
  worst: number | null;
};

/**
 * Aggregate, with the two failure modes kept apart from the average.
 *
 * Median rather than mean: the sample is small and one abandoned conversation should not
 * move the headline the way it would in a mean. `worst` is carried because the number a
 * salon reacts to is the bad case, not the typical one.
 */
export function summarise(results: readonly TurnsResult[]): TurnsSummary {
  const counts = results
    .filter((r): r is Extract<TurnsResult, { outcome: 'delivered' }> => r.outcome === 'delivered')
    .map((r) => r.turns)
    .sort((a, b) => a - b);
  const notDelivered = results.filter((r) => r.outcome === 'not_delivered').length;
  const mid = Math.floor(counts.length / 2);
  return {
    conversations: results.length,
    withIntent: counts.length + notDelivered,
    delivered: counts.length,
    notDelivered,
    counts,
    median: counts.length === 0
      ? null
      : counts.length % 2 === 1
        ? (counts[mid] as number)
        : ((counts[mid - 1] as number) + (counts[mid] as number)) / 2,
    worst: counts.length === 0 ? null : (counts[counts.length - 1] as number),
  };
}
