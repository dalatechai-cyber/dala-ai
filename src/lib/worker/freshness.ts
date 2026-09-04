/**
 * Is this message still worth answering? (§3.9's H11 check 7, `reply_too_late`.)
 *
 * Settled by the founder 2026-09-04: **30 minutes**, per tenant, because *"a bot answering
 * an hour-old Messenger message reads as broken, not helpful."* §3.9 asks for exactly this
 * knob and names 120 as a plausible value for GS Auto Center, which is why it is a column
 * rather than a constant — CLAUDE.md's test is that what distinguishes one customer from
 * another is a row.
 *
 * ## This is not the same control as `STALE_EVENT_HOURS`
 *
 * `model/reception.ts` carries a 20-hour platform-wide check, and it stays. The two answer
 * different questions:
 *
 * | | Asks | Scope |
 * |---|---|---|
 * | `isFresh` (30 min) | is a reply still *wanted* | per tenant, a product rule |
 * | `STALE_EVENT_HOURS` (20 h) | is a reply still *deliverable* | platform, a backstop under Messenger's 24-hour window |
 *
 * With the tighter one in front, the backstop is unreachable from the worker — and it is
 * kept anyway, deliberately, because `handleReception` is a library function whose own
 * guarantee should not depend on which caller reaches it. Deleting it would leave the flow
 * safe only by the accident of who calls it today.
 *
 * ## Where the check sits, and why it is not the first thing in the loop
 *
 * It runs **after the message is persisted** and before the reservation. Persisting first
 * costs three rows and honours §3.4.5's rule — *persist everything, generate nothing* — so
 * the customer's question survives and reaches the Quality layer as an unanswered one.
 * Checking first would be marginally cheaper and would lose the message entirely, which is
 * the worse trade by a wide margin: rows are cheap, and a question nobody can see later is
 * the thing the Quality layer exists to prevent.
 */

/** §3.9's default. A tenant row may raise or lower it; the platform does not. */
export const DEFAULT_REPLY_AGE_LIMIT_MINUTES = 30;

/** One day. Past this the Messenger window has closed anyway and the value is a typo. */
export const MAX_REPLY_AGE_LIMIT_MINUTES = 1440;

/**
 * Read `tenants.max_reply_age_minutes`, falling back to the default on anything unusable.
 *
 * The column is `not null default 30` with a CHECK, so in a healthy database this never
 * falls back. It does so anyway rather than throwing, because the alternative is refusing
 * to answer a customer over a column that a migration has not reached yet — and the
 * default is the design's own value, not a guess.
 */
export function replyAgeLimitMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_REPLY_AGE_LIMIT_MINUTES;
  const n = Math.floor(raw);
  if (n < 1 || n > MAX_REPLY_AGE_LIMIT_MINUTES) return DEFAULT_REPLY_AGE_LIMIT_MINUTES;
  return n;
}

/**
 * Fresh enough to answer.
 *
 * `eventAt` is Meta's `occurred_at`, never our `received_at` — §3.9.1 is explicit, and the
 * reason is that a delayed delivery must not look fresh just because we saw it late. That
 * is precisely the case this check exists for: a queue that was stuck for an hour should
 * drop its backlog, not answer all of it at once.
 *
 * A message from the FUTURE is fresh. Clock skew between Meta and us is real and small,
 * and treating a timestamp a few seconds ahead as stale would drop live messages for a
 * reason no operator could ever diagnose.
 */
export function isFresh(eventAt: Date, now: Date, limitMinutes: number): boolean {
  const ageMs = now.getTime() - eventAt.getTime();
  if (Number.isNaN(ageMs)) return false;
  if (ageMs < 0) return true;
  return ageMs <= limitMinutes * 60_000;
}
