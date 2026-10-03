/**
 * A brand's branches book alike (D-157: one price list, one booking link, one rule set): the
 * same services, minutes, levels and deposits, the same entry matchers and the same gender and
 * children's rules. What differs is each branch's own: its stylists, their calendars, and its QPay
 * merchant and payout account. Those must DIFFER: a calendar in two branches would let one
 * booking block both, and a merchant or account in two branches would pay one branch's deposits
 * to the other (each branch is its own business). Pure; `scripts/booking/check.ts` reads the rows.
 *
 * A branch whose calendars or merchant are still `not-connected` is compared all the same: its
 * shape must already match, so connecting it later is filling in ids, never a rewrite.
 */
import { allServices, type BookingConfig } from './config.ts';

export type BranchFinding = { kind: 'drift' | 'shared_calendar' | 'shared_merchant'; detail: string };

export function compareBranches(branches: readonly { slug: string; config: BookingConfig }[]): BranchFinding[] {
  const out: BranchFinding[] = [];
  const [first, ...rest] = branches;
  if (first === undefined) return out;
  const services = (c: BookingConfig) => JSON.stringify(allServices(c).map((s) => [s.name, s.minutes, s.level]));
  const grouping = (c: BookingConfig) => JSON.stringify(c.serviceGroups.map((g) => [g.label, g.audience, g.services.map((s) => [s.name, s.label, s.family])]));
  const levels = (c: BookingConfig) => JSON.stringify(c.levels.map((l) => [l.key, l.label, l.depositMnt]));
  const childRule = (c: BookingConfig) => JSON.stringify(c.childServices.map((s) => [s.name, s.gender]));
  for (const b of rest) {
    const pair = `${first.slug} / ${b.slug}`;
    if (services(first.config) !== services(b.config)) out.push({ kind: 'drift', detail: `${pair}: services, their minutes or their levels differ` });
    if (grouping(first.config) !== grouping(b.config)) out.push({ kind: 'drift', detail: `${pair}: the service buttons (groups, labels, families) differ` });
    if (levels(first.config) !== levels(b.config)) out.push({ kind: 'drift', detail: `${pair}: levels or deposits differ` });
    if (JSON.stringify(first.config.entryMatchers) !== JSON.stringify(b.config.entryMatchers)) out.push({ kind: 'drift', detail: `${pair}: entry matchers differ` });
    if (first.config.genderRule !== b.config.genderRule) out.push({ kind: 'drift', detail: `${pair}: the gender rule differs` });
    if (childRule(first.config) !== childRule(b.config)) out.push({ kind: 'drift', detail: `${pair}: who serves a children's service differs` });
  }
  const calendarOwner = new Map<string, string>();
  const merchantOwner = new Map<string, string>();
  const accountOwner = new Map<string, string>();
  for (const b of branches) {
    for (const s of b.config.stylists) {
      if (s.calendarId === null) continue;
      const other = calendarOwner.get(s.calendarId);
      if (other !== undefined && other !== b.slug) out.push({ kind: 'shared_calendar', detail: `${s.label}'s calendar is in both ${other} and ${b.slug}` });
      calendarOwner.set(s.calendarId, b.slug);
    }
    const q = b.config.qpay;
    if (q === null) continue;
    const m = merchantOwner.get(q.merchantId);
    if (m !== undefined && m !== b.slug) out.push({ kind: 'shared_merchant', detail: `${m} and ${b.slug} name the same QPay merchant id` });
    merchantOwner.set(q.merchantId, b.slug);
    for (const a of q.bankAccounts) {
      const o = accountOwner.get(a.accountNumber);
      if (o !== undefined && o !== b.slug) out.push({ kind: 'shared_merchant', detail: `${o} and ${b.slug} name the same payout account` });
      accountOwner.set(a.accountNumber, b.slug);
    }
  }
  return out;
}
