/**
 * The billing calendar, on the Ulaanbaatar clock (D-151, D-156).
 *
 * Every date here is a `YYYY-MM-DD` string on the Ulaanbaatar calendar, never a `Date`: a
 * due date is a day a person reads, and a `Date` carries a time of day that a machine zone
 * can move across midnight. Arithmetic is on the calendar day itself (UTC noon of that
 * day, so no zone can shift it), which is why nothing here needs a time zone at all except
 * `billingToday`.
 *
 * ## The schedule, relative to the due day
 *
 * The contract makes the monthly fee due by the 5th (4.3). The founder's schedule is the
 * 1st for the invoice, the 3rd and 6th for the reminders, the 6th for the founder's summary,
 * and the 13th for the question about pausing — the contract (4.9) allows a pause only when
 * payment is MORE than 7 days late, which for a fee due on the 5th is the 13th (founder,
 * 2026-09-28). Each is an offset from the invoice's own due day, so an invoice with another
 * due day — a one-off, a hosting fee — follows the same rhythm, and a test invoice dated in
 * the past reaches its late stages at once. The question is only a question: nothing
 * pauses without the founder's tap.
 */
import { ubDate } from '../time/ub.ts';

/** Reminder before the due day: the 3rd, for a fee due on the 5th. */
export const REMINDER_BEFORE_DAYS = 2;
/** Reminder after the due day: the 6th. */
export const REMINDER_AFTER_DAYS_LATE = 1;
/** The founder is asked whether to pause: 8 days late, the 13th — contract 4.9, "more than 7 days". */
export const PAUSE_ASK_DAYS_LATE = 8;
/** The founder's summary of the month: on or after the 6th. */
export const SUMMARY_DAY = 6;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function parts(day: string): [number, number, number] {
  const m = DAY_RE.exec(day);
  if (m === null) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** A calendar day back from UTC noon of that day (never "now", so no zone can move it). */
function fromUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Today on the Ulaanbaatar calendar. */
export function billingToday(now: Date): string {
  return ubDate(now);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return fromUtc(Date.UTC(y, m - 1, d, 12) + n * 86_400_000);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db, 12) - Date.UTC(ya, ma - 1, da, 12)) / 86_400_000);
}

/** `YYYY-MM` of a day. */
export function monthOf(day: string): string {
  parts(day);
  return day.slice(0, 7);
}

/** The month before `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [y, m] = parts(`${month}-01`);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function dayOfMonth(day: string): number {
  return parts(day)[2];
}

/** «2026.10.05»: how a date is written for the client. */
export function dottedDay(day: string): string {
  const [y, m, d] = parts(day);
  return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
}

export type Stage = {
  reminderBefore: boolean;
  reminderAfter: boolean;
  pauseAsk: boolean;
  daysLate: number;
};

/**
 * Which messages an UNPAID invoice is due today. Each is a window, not a threshold, so an
 * invoice that is already late when first seen (a missed run, a test dated in the past)
 * gets the one message that fits today rather than every message it missed at once. The
 * pause question is a threshold: it is asked once, whenever the invoice is first seen late
 * enough, because a missed question is a decision the founder never got to make.
 */
export function stageFor(inv: { status: string; issuedOn: string; dueOn: string }, today: string): Stage {
  const late = daysBetween(inv.dueOn, today);
  const open = inv.status === 'open';
  return {
    reminderBefore: open && late >= -REMINDER_BEFORE_DAYS && late <= 0 && daysBetween(inv.issuedOn, today) >= 1,
    reminderAfter: open && late >= REMINDER_AFTER_DAYS_LATE && late < PAUSE_ASK_DAYS_LATE,
    pauseAsk: open && late >= PAUSE_ASK_DAYS_LATE,
    daysLate: late,
  };
}
