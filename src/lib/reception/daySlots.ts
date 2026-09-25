/**
 * Tomorrow's day and hours, filled into a tenant's own sentence (founder, 2026-09-25, D-126).
 *
 * Measured live the same day: «Hi margaash tanaih ajilahu» (are you open tomorrow?) got the
 * whole week. The model had written the right answer — «маргааш манай салон 10:00–20:00
 * цагийн хооронд ажиллана» — and the facts guard, correctly refusing hours in the model's
 * own words, served the only hours it had: all seven days. The founder's answer is one day:
 * «Маргааш (Бямба) 10:00–20:00 ажиллана.»
 *
 * The sentence stays the tenant's. A `deterministic_replies` body is written as
 * «Маргааш ({tomorrow.day}) {tomorrow.hours} ажиллана.» and this file fills the two slots
 * from `business_hours` on the tenant's clock. Nothing here writes Mongolian of its own: the
 * day name is the label the hours section already prints (`WEEKDAYS`), and the hours are the
 * row's two times.
 *
 * ## When the row does NOT answer
 *
 * `null`, and the caller withholds the row — the model answers instead, which costs one call
 * and says nothing false. Every case below is one where "tomorrow we open at X" could be
 * untrue:
 *
 *  - tomorrow has no `business_hours` row, or it is `closed`, or a time is missing;
 *  - a `tenant_closures` range covers tomorrow — a holiday is exactly when the week says
 *    open and the door is locked (the same rule `renderVolatile` follows for today);
 *  - the tenant lists two or more branches (D-125): one line would be one branch's hours
 *    told as the salon's;
 *  - the body still carries a `{tomorrow.` slot this file does not know.
 */
import { WEEKDAYS } from '../prompt/tenant.ts';
import type { BusinessHours, Closure } from './volatile.ts';

const DAY = '{tomorrow.day}';
const HOURS = '{tomorrow.hours}';

/** Does this body use a tomorrow slot at all? */
export function hasTomorrowSlot(body: string): boolean {
  return body.includes('{tomorrow.');
}

/** `YYYY-MM-DD` plus one day, and that day's weekday (0 = Sunday, as Postgres `dow`). */
export function nextLocalDate(localDate: string): { date: string; weekday: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  if (m === null) return null;
  // A calendar date, not an instant: UTC arithmetic on it has no zone to get wrong.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  if (Number.isNaN(d.getTime())) return null;
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}

/** «10:00–20:00»: the row's two times, joined by an en dash as the founder wrote it. */
function hoursText(row: BusinessHours): string | null {
  if (row.closed || row.opens === null || row.closes === null) return null;
  return `${row.opens.slice(0, 5)}–${row.closes.slice(0, 5)}`;
}

/**
 * The body with its tomorrow slots filled, the body unchanged when it has none, or null when
 * the row must not answer today (see the header).
 */
export function renderTomorrowSlots(
  body: string,
  input: {
    localDate: string;
    hours: readonly BusinessHours[];
    closures: readonly Closure[];
    branchCount: number;
  },
): string | null {
  if (!hasTomorrowSlot(body)) return body;
  if (input.branchCount >= 2) return null;
  const next = nextLocalDate(input.localDate);
  if (next === null) return null;
  if (input.closures.some((c) => c.startsOn <= next.date && next.date <= c.endsOn)) return null;
  const row = input.hours.find((h) => h.weekday === next.weekday);
  const label = WEEKDAYS.find((w) => w.dow === next.weekday)?.label;
  if (row === undefined || label === undefined) return null;
  const hours = hoursText(row);
  if (hours === null) return null;
  const out = body.split(DAY).join(label).split(HOURS).join(hours);
  return hasTomorrowSlot(out) ? null : out;
}
