/**
 * Period keys for `spend_counters`.
 *
 * The day boundary is **the tenant's, not UTC's and no longer Ulaanbaatar's by
 * assumption**. A daily ceiling that rolls over at UTC midnight rolls over at 08:00 in
 * Ulaanbaatar — in the middle of a salon's working morning — so a tenant that exhausted
 * "today" would recover mid-appointment and a founder reading an alert at 09:00 local
 * would be looking at two different days' spend blended together.
 *
 * The ancestor already had to learn this for closures (`config/closures.js`: "at 23:00
 * UTC it is already tomorrow in Ulaanbaatar, and the break must end on the salon's
 * calendar"). Same reasoning — but the offset used to be a constant here, `8 * 60`
 * minutes, while `tenants.timezone` has been a per-tenant column since `0001`. That is
 * the platform's founding test failing in miniature: something that distinguishes one
 * customer from another was code rather than a row. Every tenant's ceiling now rolls on
 * their own calendar.
 *
 * ## The platform's counter is NOT on a tenant's calendar
 *
 * `dayTargets` addresses two counters per reservation: the tenant's and the platform's.
 * Keying the platform row by the tenant that happened to trigger it would give the
 * platform a different day per tenant, so two tenants in different zones would open two
 * platform rows for one platform day — and the platform cap, the single number between a
 * platform-wide bug and the Anthropic invoice, would quietly become two caps. That fails
 * OPEN on money, which is the one direction this codebase never fails. The platform keys
 * on `PLATFORM_TIMEZONE`, a compiled constant, and only tenant-scoped counters follow the
 * tenant.
 */
import { tenantClock } from '../time/clock.ts';

/** e.g. "2026-09-02" — the given zone's calendar day. */
export function dayKey(now: Date, timezone: string): string {
  return tenantClock(now, timezone).date;
}

/** e.g. "2026-09" — the given zone's calendar month, which is what a tenant is billed for. */
export function monthKey(now: Date, timezone: string): string {
  return tenantClock(now, timezone).date.slice(0, 7);
}
