/**
 * Ulaanbaatar time for people (founder, 2026-09-27: "Mongolian time everywhere").
 *
 * `toISOString()` is UTC whatever the server's zone, so it was never wrong as a key, but a
 * founder reading "2026-09-27T16:40:00.000Z" in Telegram has to add eight hours in their head,
 * and a day key taken off it rolls at 08:00 in Ulaanbaatar. Everything a person reads, and
 * every per-day dedup key, goes through here; both read `tenantClock`, the one place local
 * time is computed (`clock.ts`), so the machine's own zone never enters.
 */
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { tenantClock } from './clock.ts';

/** `YYYY-MM-DD` on the Ulaanbaatar clock. */
export function ubDate(at: Date): string {
  return tenantClock(at, PLATFORM_TIMEZONE).date;
}

/** `YYYY-MM-DD HH` on the Ulaanbaatar clock: an hour key. */
export function ubHour(at: Date): string {
  const c = tenantClock(at, PLATFORM_TIMEZONE);
  return `${c.date} ${c.time.slice(0, 2)}`;
}

/** «2026-09-28 00:40 UB time»: a moment shown to the founder, labelled. */
export function ubStamp(at: Date): string {
  const c = tenantClock(at, PLATFORM_TIMEZONE);
  return `${c.date} ${c.time} UB time`;
}
