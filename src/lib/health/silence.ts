/**
 * The inbound silence watchdog — the answer to the one thing `STATUS.md` §3 says plainly:
 *
 * > **A single failure could still make the whole thing silent.** A dead token produces no
 * > error, because no request arrives to fail.
 *
 * Every other failure in this platform announces itself. A refused reply writes a
 * `quality_flags` row, a spent budget trips an alert, a Graph `190` halts the channel. A
 * revoked token, an app unsubscribed from the Page, a webhook field switched off — none of
 * those produce anything at all. There is no error to catch, because there is no request.
 * The only observable is an **absence**, and an absence has to be looked for.
 *
 * ## Silence is measured in OPEN minutes, and that is the whole design
 *
 * The obvious watchdog — "alert if nothing has arrived for six hours" — fires every single
 * morning. A salon closed 20:00–10:00 is silent for fourteen hours by the clock and
 * perfectly healthy. An alarm that cries wolf nightly is muted within a week, and a muted
 * alarm is worse than none: it is the same failure `alerts/alert.ts` was built to avoid,
 * arriving from the other direction.
 *
 * So the elapsed measure is not wall-clock. It is **the minutes during which this tenant
 * was open for business**, integrated between the last inbound event and now, with
 * closures subtracted. Then a single threshold — three open hours, say — means the same
 * thing for a salon, a garage, a night-shift business and a tenant in another timezone,
 * with no per-tenant tuning and no seasonal drift.
 *
 * ## Two different faults wear the same symptom
 *
 * | | Means | Remedy |
 * |---|---|---|
 * | Received before, then stopped | the token died, or the app was unsubscribed | re-auth the Page, re-subscribe |
 * | **Never received anything** | the subscription never worked | check the app-level field subscription |
 *
 * The second is the failure `STATUS.md` §5 item 15 warns about in as many words: a
 * page-level subscribe returns `{"success": true}` even when the app has never enabled
 * that field, and **no events are ever delivered**. Nothing else in the system would ever
 * notice, because "no events" is exactly what a quiet Tuesday looks like. So `everReceived`
 * is carried on the verdict and the two produce different alert text.
 *
 * ## When it cannot measure, it says so — it does not guess
 *
 * If the tenant has no usable `business_hours` rows, this returns `unknown` rather than
 * picking a side. Counting unknown hours as OPEN alerts every unprovisioned tenant nightly;
 * counting them as CLOSED disables the watchdog silently, which is the watchdog having the
 * exact defect it exists to detect. `isOpenAt` already refuses to collapse "we do not know"
 * into "closed", and this is the same refusal one layer up.
 */
import { activeClosure, isOpenAt, tenantClock, type BusinessHours, type Closure } from '../reception/volatile.ts';

/**
 * How finely the walk samples the schedule. Five minutes is well below any real opening
 * time and bounds the work at 12 probes per open hour.
 */
export const PROBE_MINUTES = 5;

/**
 * How far back the walk will look before giving up, in days.
 *
 * The walk stops as soon as it has counted enough open minutes to decide, so this bound is
 * only reached when the business has genuinely been closed for a long time — a fortnight's
 * closure, or a schedule with almost no open hours in it. That is not a silent channel and
 * must not be reported as one.
 */
export const MAX_LOOKBACK_DAYS = 14;

export type SilenceInput = {
  /** The most recent event Meta actually delivered for this channel, or null. */
  lastInboundAt: Date | null;
  /** When this channel started expecting traffic. Used when nothing has ever arrived. */
  liveSince: Date | null;
  now: Date;
  timezone: string;
  hours: readonly BusinessHours[];
  closures: readonly Closure[];
  /** Open minutes of silence that count as a fault. */
  thresholdOpenMinutes: number;
};

export type SilenceVerdict =
  /**
   * Traffic is arriving, or the business simply has not been open long enough to tell.
   * `openMinutes` is EXACT here: the walk reached the last inbound event.
   */
  | { verdict: 'ok'; openMinutes: number }
  /**
   * Nothing has arrived across more open time than the tenant's threshold allows.
   *
   * `openMinutesAtLeast` is a FLOOR, not a total, and the name says so. The walk stops the
   * moment it has counted enough to decide, so a channel dead for three months reports
   * roughly the threshold rather than three months of trading hours. Naming it
   * `openMinutes` would make it a plausible-looking wrong number in the alert text — a
   * source answering confidently instead of admitting what it did not measure, which is
   * the failure D-020 is named after.
   */
  | { verdict: 'silent'; openMinutesAtLeast: number; since: Date; everReceived: boolean }
  /** The question could not be answered. An operator-visible state, never a default. */
  | { verdict: 'unknown'; detail: string };

/**
 * Was the tenant open at this instant?
 *
 * `null` propagates: a day with no row, or a row with no times, is not evidence of being
 * shut. A closure outranks the weekly schedule, exactly as it does in L4 — a holiday is
 * precisely the case where the schedule says open and the door is locked.
 */
function openAt(input: SilenceInput, at: Date): boolean | null {
  const clock = tenantClock(at, input.timezone);
  if (activeClosure(input.closures, clock.date) !== null) return false;
  return isOpenAt(input.hours, clock.weekday, clock.time);
}

/**
 * Open minutes between `since` and `now`, walking BACKWARDS from now.
 *
 * Backwards, and stopping the moment the threshold is exceeded, so the work is bounded by
 * the threshold rather than by how long the channel has been dead. A token revoked three
 * months ago costs the same handful of probes as one revoked this morning; the forward
 * version would walk ninety days to reach a conclusion it had after the first three hours.
 */
function openMinutesSince(input: SilenceInput, since: Date): { minutes: number; exhausted: boolean } | { unknown: string } {
  const floor = input.now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60_000;
  const stop = Math.max(since.getTime(), floor);
  const step = PROBE_MINUTES * 60_000;

  let minutes = 0;
  let cursor = input.now.getTime();

  while (cursor > stop && minutes <= input.thresholdOpenMinutes) {
    const probe = Math.max(cursor - step, stop);
    // Sample the middle of the interval rather than an edge: a probe exactly at the
    // opening time would count a whole step either side of it depending on alignment.
    const open = openAt(input, new Date((cursor + probe) / 2));
    if (open === null) {
      return { unknown: `no usable business_hours row for ${tenantClock(new Date(probe), input.timezone).date}` };
    }
    if (open) minutes += (cursor - probe) / 60_000;
    cursor = probe;
  }

  return { minutes, exhausted: cursor > since.getTime() && minutes <= input.thresholdOpenMinutes };
}

/**
 * Has this channel gone silent?
 *
 * Takes its inputs and reads nothing — the same discipline as `reception/handle.ts`, and
 * for the same reason: every branch here is a question about *what to conclude*, and none
 * of them should be entangled with *how to find out*.
 */
export function assessSilence(input: SilenceInput): SilenceVerdict {
  const everReceived = input.lastInboundAt !== null;
  const since = input.lastInboundAt ?? input.liveSince;

  if (since === null) {
    // Neither a delivered event nor a go-live time. There is no clock to measure from, and
    // inventing one would either alert on a channel that was provisioned a minute ago or
    // stay quiet about one that has never worked.
    return { verdict: 'unknown', detail: 'no last inbound event and no live-since time: nothing to measure from' };
  }

  // Clock skew, or an event stamped in the future. Not silence, and not worth an alarm.
  if (since.getTime() >= input.now.getTime()) return { verdict: 'ok', openMinutes: 0 };

  const walked = openMinutesSince(input, since);
  if ('unknown' in walked) return { verdict: 'unknown', detail: walked.unknown };

  if (walked.minutes > input.thresholdOpenMinutes) {
    return { verdict: 'silent', openMinutesAtLeast: walked.minutes, since, everReceived };
  }

  if (walked.exhausted) {
    // Fourteen days of lookback contained less open time than the threshold. The tenant has
    // been closed, not unreachable — reporting silence here would be an alarm about a
    // holiday. Reported as unmeasurable rather than healthy, because a schedule this empty
    // is itself worth an operator's glance.
    return {
      verdict: 'unknown',
      detail: `${MAX_LOOKBACK_DAYS} days of lookback held only ${Math.round(walked.minutes)} open minutes, below the ${input.thresholdOpenMinutes}-minute threshold`,
    };
  }

  return { verdict: 'ok', openMinutes: walked.minutes };
}
