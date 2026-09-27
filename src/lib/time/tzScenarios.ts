/**
 * Every time-dependent answer the platform gives, for instants either side of Ulaanbaatar
 * midnight, printed as JSON. `tz.test.ts` runs this under several machine time zones and
 * requires byte-identical output: nothing here may depend on where the server runs.
 */
import { tenantClock, localDayStart } from './clock.ts';
import { ubDate, ubHour, ubStamp } from './ub.ts';
import { dayKey, monthKey } from '../spend/periods.ts';
import { renderVolatile, type BusinessHours } from '../reception/volatile.ts';
import { reportWindow } from '../alerts/digest.ts';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';

const HOURS: BusinessHours[] = [
  { weekday: 0, opens: null, closes: null, closed: true },
  { weekday: 1, opens: '00:00:00', closes: '10:00:00', closed: false },
  { weekday: 2, opens: '10:00:00', closes: '20:00:00', closed: false },
];

// 2026-09-27 is a Sunday. 15:59Z is 23:59 Sunday in Ulaanbaatar, 16:00Z is 00:00 Monday,
// and 2026-09-30T16:00Z is the first minute of October there while September in UTC.
export const INSTANTS: readonly string[] = [
  '2026-09-27T15:59:00Z', '2026-09-27T16:00:00Z', '2026-09-27T16:05:00Z',
  '2026-09-27T23:59:00Z', '2026-09-28T00:00:00Z', '2026-09-30T15:59:00Z', '2026-09-30T16:00:00Z',
];

export function scenarios(): unknown[] {
  return INSTANTS.map((iso) => {
    const now = new Date(iso);
    const clock = tenantClock(now, PLATFORM_TIMEZONE);
    return {
      iso,
      clock,
      dayStart: localDayStart(clock.date, PLATFORM_TIMEZONE).toISOString(),
      ub: [ubDate(now), ubHour(now), ubStamp(now)],
      spend: [dayKey(now, PLATFORM_TIMEZONE), monthKey(now, PLATFORM_TIMEZONE)],
      report: reportWindow(now),
      volatile: renderVolatile({
        now, timezone: PLATFORM_TIMEZONE, surface: 'direct_message', hours: HOURS, closures: [], branches: [],
      }),
    };
  });
}

if (process.argv[1]?.endsWith('tzScenarios.ts')) {
  process.stdout.write(JSON.stringify(scenarios()));
}
