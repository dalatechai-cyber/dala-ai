/**
 * One branch's `booking_config.config`, built from a brand's shared booking rules file
 * (`config/booking/<brand>.json`) and what only that branch has: its stylists' calendars and its
 * own QPay merchant. Pure: the caller says where the calendars and the merchant come from
 * (`scripts/booking/from-website.ts` reads the brand's website; the tests use test values). The
 * branch is named by an ARGUMENT, never here (a client is rows).
 *
 * The shared part (levels, services, minutes, matchers, timing) is copied as it is, so every
 * branch of a brand books alike by construction; `branches.ts` checks the rows stay so.
 */
import { NOT_CONNECTED } from './config.ts';

export type RawQpay = {
  merchant_id: string; mcc_code: string;
  bank_accounts: { bank_code: string; account_number: string; account_name: string }[];
  login?: string;
};

export type BranchRules = {
  branch_label: string;
  website_branch: string;
  qpay: 'website' | 'operator';
  stylists: { name: string; website: string; level: string; gender: 'female' | 'male' }[];
};

export type BranchSource = {
  /** The calendar of the stylist the brand's website knows by `website`; null: not connected yet. */
  calendarFor: (website: string) => string | null;
  /** This branch's own merchant, or not connected yet. */
  qpay: RawQpay | typeof NOT_CONNECTED;
  testSenderIds?: readonly string[];
};

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The branch's block of the rules file, or why it cannot be read. */
export function branchRules(rules: unknown, slug: string): { ok: true; branch: BranchRules } | { ok: false; detail: string } {
  if (!isObj(rules) || !isObj(rules['branches'])) return { ok: false, detail: 'the rules file has no branches' };
  const b = rules['branches'][slug];
  if (!isObj(b)) return { ok: false, detail: `the rules file has no branch ${slug}` };
  const stylists = b['stylists'];
  if (typeof b['branch_label'] !== 'string' || typeof b['website_branch'] !== 'string' || (b['qpay'] !== 'website' && b['qpay'] !== 'operator')
    || !Array.isArray(stylists) || stylists.length === 0) {
    return { ok: false, detail: `branch ${slug} needs branch_label, website_branch, qpay ("website" or "operator") and stylists` };
  }
  for (const [i, s] of stylists.entries()) {
    if (!isObj(s) || typeof s['name'] !== 'string' || typeof s['website'] !== 'string' || typeof s['level'] !== 'string'
      || (s['gender'] !== 'female' && s['gender'] !== 'male')) {
      return { ok: false, detail: `branch ${slug} stylists[${i}] needs name, website, level and gender` };
    }
  }
  return { ok: true, branch: b as unknown as BranchRules };
}

/** The config row for one branch. Validate it with `parseBookingConfig` before use. */
export function branchConfig(rules: unknown, slug: string, src: BranchSource): { ok: true; config: Record<string, unknown> } | { ok: false; detail: string } {
  const b = branchRules(rules, slug);
  if (!b.ok) return b;
  const shared = Object.fromEntries(Object.entries(rules as Record<string, unknown>).filter(([k]) => !k.startsWith('_') && k !== 'branches'));
  return {
    ok: true,
    config: {
      ...shared,
      test_sender_ids: [...(src.testSenderIds ?? [])],
      branch_label: b.branch.branch_label,
      stylists: b.branch.stylists.map((s) => ({
        name: s.name, label: s.name, level: s.level, gender: s.gender, calendar_id: src.calendarFor(s.website) ?? NOT_CONNECTED,
      })),
      qpay: src.qpay,
    },
  };
}
