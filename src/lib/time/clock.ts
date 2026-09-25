/**
 * The one place local time is computed.
 *
 * ## Why there is exactly one
 *
 * Before this file there were two conventions eight hours apart. `spend/periods.ts` keyed
 * the day on Ulaanbaatar, deliberately and with a paragraph explaining why; four other
 * sites keyed it on UTC with an inline `now.toISOString().slice(0, 10)`. Both read as
 * correct on their own. Together they meant a tenant's spend ceiling and the alerts about
 * that tenant rolled over on different days — and, for the silence watchdog, that a
 * channel quiet across one trading morning raised two alerts, because the UTC day rolls at
 * 08:00 in Ulaanbaatar, an hour before a salon opens.
 *
 * A second implementation of "what day is it there" is how that comes back. Everything
 * that needs a local date, time or weekday calls this.
 *
 * ## Why `Intl`, not an offset
 *
 * `spend/periods.ts` used to add a fixed `8 * 60` minutes. That is right for Mongolia,
 * which has had no daylight saving since 2017, and silently wrong for the first tenant
 * anywhere that does — including Mongolia's own 2015–2016 experiment, where the same
 * arithmetic would have been an hour out for half the year. The IANA zone knows; a
 * constant cannot.
 *
 * The locale is pinned to `en-CA` so nothing here depends on the runtime's default. Every
 * field read back is numeric except the weekday, which is matched against English
 * abbreviations that `en-CA` is what guarantees.
 *
 * ## An unknown zone THROWS, and that is deliberate
 *
 * `Intl.DateTimeFormat` raises `RangeError` on a time zone it does not recognise. Nothing
 * here catches it. A caller on the money path is inside `withTenantRole`'s try/catch and
 * refuses with a 503; a caller on an alert path fails loudly. The alternative — falling
 * back to UTC — would put a tenant's ceiling on the wrong calendar and say nothing, which
 * is the failure this module exists to end.
 */

/** `YYYY-MM-DD` and `HH:MM` on the given zone's clock, plus its weekday (0 = Sunday). */
export function tenantClock(now: Date, timezone: string): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);

  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // `hour` can come back as "24" for midnight under hour12:false in some ICU versions.
  const hour = get('hour') === '24' ? '00' : get('hour');

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    weekday: Math.max(0, weekdays.indexOf(get('weekday'))),
  };
}

/**
 * The instant a local calendar date begins on the given zone's clock: `YYYY-MM-DD 00:00`
 * there, as a `Date`. Two passes, each reading the zone's own offset through `tenantClock`,
 * so a zone with daylight saving lands on its real midnight rather than one an hour out.
 * Throws for a malformed date, as an unknown zone does.
 */
export function localDayStart(date: string, timezone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (m === null) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const offsetAt = (instant: number): number => {
    const c = tenantClock(new Date(instant), timezone);
    const [y, mo, d] = c.date.split('-').map(Number);
    const [h, mi] = c.time.split(':').map(Number);
    return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0) - Math.floor(instant / 60_000) * 60_000;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}
