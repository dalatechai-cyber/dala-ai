/**
 * Period keys for `spend_counters`.
 *
 * The day boundary is **Ulaanbaatar's, not UTC's**. Mongolia is UTC+8 year-round with no
 * daylight saving. A daily ceiling that rolls over at UTC midnight rolls over at 08:00
 * local — in the middle of a salon's working morning — so a tenant that exhausted
 * "today" would recover mid-appointment and a founder reading an alert at 09:00 local
 * would be looking at two different days' spend blended together.
 *
 * The ancestor already had to learn this for closures (`config/closures.js`: "at 23:00
 * UTC it is already tomorrow in Ulaanbaatar, and the break must end on the salon's
 * calendar"). Same reasoning, same offset.
 */
const UB_OFFSET_MINUTES = 8 * 60;

function ubParts(now: Date): { y: number; m: number; d: number } {
  const shifted = new Date(now.getTime() + UB_OFFSET_MINUTES * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** e.g. "2026-09-02" — the salon's calendar day. */
export function dayKey(now: Date): string {
  const { y, m, d } = ubParts(now);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** e.g. "2026-09" — the salon's calendar month, which is what a tenant is billed for. */
export function monthKey(now: Date): string {
  const { y, m } = ubParts(now);
  return `${y}-${String(m).padStart(2, '0')}`;
}
