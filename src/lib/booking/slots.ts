/**
 * Which start times a customer may be offered. Pure: the calendar's busy times are an input.
 *
 * The arithmetic is the tenant website's (`matrix_website/routes/calendar.js`, PR #73 "offer
 * only start times a service can actually finish in"), read 2026-10-02:
 *
 *  - starts every `step` minutes from opening;
 *  - the last start is closing minus the service's length, so a four-hour service is not
 *    offered at 18:00 on a day that closes at 20:00;
 *  - a start already past (plus the tenant's lead time) is not offered;
 *  - a start whose whole `[start, start + minutes)` touches any busy interval is not offered.
 *
 * Hours and closures are the tenant's own rows (`business_hours`, `tenant_closures`), on the
 * tenant's clock (D-151). A day with no hours row, a closed row, or inside a closure offers
 * nothing. Mongolia keeps no daylight saving; `localDayStart` handles a zone that does.
 */
import { localDayStart, tenantClock } from '../time/clock.ts';
import { nextLocalDate } from '../reception/daySlots.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';

export type Interval = { start: Date; end: Date };
export type OpenDay = { date: string; weekday: number; opensAt: Date; closesAt: Date };

/** `HH:MM[:SS]` → minutes after midnight, or null. */
function minutesOf(t: string | null): number | null {
  if (t === null) return null;
  const m = /^(\d{2}):(\d{2})/u.exec(t);
  if (m === null) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}

/** The next `daysAhead` local dates from today, kept only when the tenant opens on them. */
export function openDays(input: {
  now: Date; timezone: string; daysAhead: number; hours: readonly BusinessHours[]; closures: readonly Closure[];
}): OpenDay[] {
  const out: OpenDay[] = [];
  let date = tenantClock(input.now, input.timezone).date;
  let weekday = tenantClock(input.now, input.timezone).weekday;
  for (let i = 0; i < input.daysAhead; i += 1) {
    const row = input.hours.find((h) => h.weekday === weekday);
    const closed = input.closures.some((c) => c.startsOn <= date && date <= c.endsOn);
    const opens = row === undefined || row.closed ? null : minutesOf(row.opens);
    const closes = row === undefined || row.closed ? null : minutesOf(row.closes);
    if (!closed && opens !== null && closes !== null && closes > opens) {
      const midnight = localDayStart(date, input.timezone).getTime();
      out.push({ date, weekday, opensAt: new Date(midnight + opens * 60_000), closesAt: new Date(midnight + closes * 60_000) });
    }
    const next = nextLocalDate(date);
    if (next === null) break;
    date = next.date;
    weekday = next.weekday;
  }
  return out;
}

const overlaps = (a: Interval, b: Interval): boolean => a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

/** Free starts on one day for one calendar. */
export function freeStarts(input: {
  day: OpenDay; minutes: number; stepMinutes: number; now: Date; minLeadMinutes: number; busy: readonly Interval[];
}): Date[] {
  const out: Date[] = [];
  const earliest = input.now.getTime() + input.minLeadMinutes * 60_000;
  const length = input.minutes * 60_000;
  for (let t = input.day.opensAt.getTime(); t + length <= input.day.closesAt.getTime(); t += input.stepMinutes * 60_000) {
    if (t < earliest) continue;
    const slot = { start: new Date(t), end: new Date(t + length) };
    if (input.busy.some((b) => overlaps(slot, b))) continue;
    out.push(slot.start);
  }
  return out;
}

/** Is `[start, start + minutes)` still free against these busy times? The same test, once. */
export function isFree(start: Date, minutes: number, busy: readonly Interval[]): boolean {
  const slot = { start, end: new Date(start.getTime() + minutes * 60_000) };
  return !busy.some((b) => overlaps(slot, b));
}
