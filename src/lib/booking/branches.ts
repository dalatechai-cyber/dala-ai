/**
 * A brand's branches book alike (D-157: one price list, one booking link, one rule set): the
 * same services and minutes, the same deposits, the same agreement sentence, the same QPay
 * merchant and the same entry matchers. What differs is each branch's own stylists and their
 * calendars, and a calendar is never shared between two branches (one booking would block
 * both). Pure; `scripts/booking/check.ts` reads the rows.
 */
import { allServices, type BookingConfig } from './config.ts';

export type BranchFinding = { kind: 'drift' | 'shared_calendar'; detail: string };

export function compareBranches(branches: readonly { slug: string; config: BookingConfig }[]): BranchFinding[] {
  const out: BranchFinding[] = [];
  const [first, ...rest] = branches;
  if (first === undefined) return out;
  const services = (c: BookingConfig) => JSON.stringify(allServices(c).map((s) => [s.name, s.minutes]));
  const levels = (c: BookingConfig) => JSON.stringify(c.levels.map((l) => [l.key, l.label, l.depositMnt]));
  const merchant = (c: BookingConfig) => JSON.stringify(c.qpay);
  const childRule = (c: BookingConfig) => JSON.stringify(c.childServices.map((s) => [s.name, s.gender]));
  for (const b of rest) {
    const pair = `${first.slug} / ${b.slug}`;
    if (services(first.config) !== services(b.config)) out.push({ kind: 'drift', detail: `${pair}: services or their minutes differ` });
    if (levels(first.config) !== levels(b.config)) out.push({ kind: 'drift', detail: `${pair}: levels or deposits differ` });
    if (first.config.agreementText !== b.config.agreementText) out.push({ kind: 'drift', detail: `${pair}: the agreement sentence differs` });
    if (merchant(first.config) !== merchant(b.config)) out.push({ kind: 'drift', detail: `${pair}: the QPay merchant differs` });
    if (JSON.stringify(first.config.entryMatchers) !== JSON.stringify(b.config.entryMatchers)) out.push({ kind: 'drift', detail: `${pair}: entry matchers differ` });
    if (first.config.genderRule !== b.config.genderRule) out.push({ kind: 'drift', detail: `${pair}: the gender rule differs` });
    if (childRule(first.config) !== childRule(b.config)) out.push({ kind: 'drift', detail: `${pair}: who serves a children's service differs` });
  }
  const owner = new Map<string, string>();
  for (const b of branches) {
    for (const s of b.config.stylists) {
      const other = owner.get(s.calendarId);
      if (other !== undefined && other !== b.slug) out.push({ kind: 'shared_calendar', detail: `${s.label}'s calendar is in both ${other} and ${b.slug}` });
      owner.set(s.calendarId, b.slug);
    }
  }
  return out;
}
