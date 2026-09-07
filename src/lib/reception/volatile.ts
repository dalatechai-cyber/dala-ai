/**
 * L4 — the volatile tail, rendered per request and never cached.
 *
 * ## Why this is a separate string and not a suffix
 *
 * `salonBrain.js:155` returns `` `${cachedBasePrompt}${buildClosureSection(closure)}` `` and
 * wraps the whole concatenation in one cached block. A closure starting or ending
 * therefore invalidates the entire prefix — twice a year, harmlessly.
 *
 * **The pattern is the trap.** The moment anyone adds "today is {{date}}" to that string,
 * every request writes a fresh cache entry, caching silently stops, and the bill roughly
 * triples with no error and no visible symptom. This function returns its own string, the
 * caller puts it in its own `system` block with no `cache_control`, and the mistake stops
 * being available.
 *
 * ## Everything here is on the TENANT'S clock
 *
 * "Is it open now" and "which day is it" are questions about Ulaanbaatar, not about UTC.
 * A salon asked at 23:30 local on a Saturday is being asked about Saturday; computing the
 * weekday in UTC would answer about Sunday for eight hours of every day.
 */
import { nfc } from '../mn/text.ts';
import { tenantClock } from '../time/clock.ts';

/** `business_hours`, one row per weekday. `weekday` is 0 = Sunday, as Postgres `dow` is. */
export type BusinessHours = {
  weekday: number;
  opens: string | null;
  closes: string | null;
  closed: boolean;
};

/** A `tenant_closures` row. `message` is quoted VERBATIM — it is the tenant's sentence. */
export type Closure = { startsOn: string; endsOn: string; title: string; message: string };

export type VolatileInput = {
  now: Date;
  timezone: string;
  channel: string;
  hours: readonly BusinessHours[];
  closures: readonly Closure[];
};

/**
 * Is the tenant open at this local time?
 *
 * Returns `null` when the day has no row at all: "we do not know" is not "closed". A
 * missing row is a provisioning gap, and telling a customer the salon is shut because a
 * row is absent is a worse answer than saying nothing about it.
 */
export function isOpenAt(hours: readonly BusinessHours[], weekday: number, hhmm: string): boolean | null {
  const row = hours.find((h) => h.weekday === weekday);
  if (row === undefined) return null;
  if (row.closed) return false;
  if (row.opens === null || row.closes === null) return null;

  const opens = row.opens.slice(0, 5);
  const closes = row.closes.slice(0, 5);
  // An overnight window (opens 20:00, closes 02:00) wraps midnight, so the comparison
  // flips. A salon rarely needs it; a bar always does, and the cost of handling it is one
  // branch rather than a second table shape later.
  return closes < opens ? hhmm >= opens || hhmm < closes : hhmm >= opens && hhmm < closes;
}

/** The closure covering this local date, if any. Dates are inclusive at both ends. */
export function activeClosure(closures: readonly Closure[], localDate: string): Closure | null {
  return closures.find((c) => c.startsOn <= localDate && localDate <= c.endsOn) ?? null;
}

/**
 * Structural labels for the volatile block.
 *
 * These are prompt scaffolding the MODEL reads, not sentences a customer sees, so they sit
 * in code rather than behind the `reviewed_at` gate. They are collected here in one place
 * so that if the founder decides the gate should cover them too, moving them is one edit.
 */
const LABELS = {
  now: 'ОДООГИЙН ЦАГ',
  channel: 'СУВАГ',
  status: 'ОДОО',
  open: 'НЭЭЛТТЭЙ',
  shut: 'ХААЛТТАЙ',
  closure: 'ТУХАЙН ХУГАЦААНЫ МЭДЭГДЭЛ',
} as const;

/**
 * Render L4.
 *
 * The closure `message` is reproduced **verbatim**. It is the tenant's own sentence,
 * written and reviewed by them, and paraphrasing it would put words in their mouth about
 * something as concrete as whether they are open on a public holiday.
 */
export function renderVolatile(input: VolatileInput): string {
  const clock = tenantClock(input.now, input.timezone);
  const lines = [
    `${LABELS.now}: ${clock.date} ${clock.time} (${input.timezone})`,
    `${LABELS.channel}: ${input.channel}`,
  ];

  const closure = activeClosure(input.closures, clock.date);
  const open = isOpenAt(input.hours, clock.weekday, clock.time);

  // A closure outranks the weekly hours: a holiday is exactly the case where the schedule
  // says open and the door is locked.
  if (closure !== null) {
    lines.push(`${LABELS.status}: ${LABELS.shut}`);
    lines.push(`${LABELS.closure}: ${nfc(closure.message)}`);
  } else if (open !== null) {
    lines.push(`${LABELS.status}: ${open ? LABELS.open : LABELS.shut}`);
  }
  // `open === null` and no closure: say nothing. An absent row is a provisioning gap, and
  // asserting either state from it would be inventing one.

  return lines.join('\n');
}
