/**
 * What a client is charged, proposed from the contract's rules for the founder to confirm
 * (D-156). Nothing here is ever invoiced on its own: the result becomes an UNCONFIRMED
 * schedule, and only the founder's confirmation (bound to the exact lines and amount they
 * read) lets `billing_issue_due` touch it.
 *
 * The contract's rules (Ажил гүйцэтгэх гэрээ, 1.4 and 4.3):
 * - the multi-staff discount on the monthly fee: 2 AI staff 10%, 3 → 15%, 4 or more → 20%;
 * - annual prepay: 12 months for the price of 10;
 * - **discounts do not stack: the one most favourable to the client applies.** So an annual
 *   prepay for four staff is 12 months at 20% off (9.6 months' price), not 10 months: the
 *   proposal computes both and takes the lower, and says which it took.
 *
 * Prices are not in this file. The founder passes each staff member's monthly price when
 * proposing (they are the contract's figures, and the founder confirms them anyway), so no
 * copy of a tenant's price rows lives here to drift (D-151).
 */
import type { InvoiceLine } from './templates.ts';

export type StaffPrice = { label: string; monthlyMnt: number };

export type Phrases = {
  /** «{label} × {months} сар» */
  months: (label: string, months: number) => string;
  /** «Хөнгөлөлт ({count} AI ажилтан, {percent}%)» */
  teamDiscount: (count: number, percent: number) => string;
  /** «Жилийн урьдчилгаа: {months} сар үнэгүй» */
  annualFree: (months: number) => string;
};

export type Proposal = {
  kind: 'monthly_fee' | 'annual_prepay';
  everyMonths: 1 | 12;
  lines: InvoiceLine[];
  amountMnt: number;
  /** One sentence for the founder, in English: what was applied and what it was compared with. */
  why: string;
};

/** The contract's multi-staff discount, in percent. */
export function teamDiscountPercent(staffCount: number): number {
  if (staffCount >= 4) return 20;
  if (staffCount === 3) return 15;
  if (staffCount === 2) return 10;
  return 0;
}

function whole(n: number, what: string): number {
  if (!Number.isInteger(n)) throw new RangeError(`${what} is not a whole tugrik amount: ${n}`);
  return n;
}

export function propose(staff: readonly StaffPrice[], opts: { annual: boolean }, phrases: Phrases): Proposal {
  if (staff.length === 0) throw new RangeError('at least one AI staff member is required');
  for (const s of staff) {
    if (s.label.trim() === '') throw new RangeError('every staff member needs a label');
    if (!Number.isInteger(s.monthlyMnt) || s.monthlyMnt <= 0) throw new RangeError(`${s.label}: the monthly price must be a positive whole amount`);
  }
  const monthly = staff.reduce((sum, s) => sum + s.monthlyMnt, 0);
  const pct = teamDiscountPercent(staff.length);
  const discount = whole((monthly * pct) / 100, 'the team discount');

  if (!opts.annual) {
    const lines: InvoiceLine[] = staff.map((s) => ({ label: s.label, amount_mnt: s.monthlyMnt }));
    if (discount > 0) lines.push({ label: phrases.teamDiscount(staff.length, pct), amount_mnt: -discount });
    return {
      kind: 'monthly_fee', everyMonths: 1, lines, amountMnt: monthly - discount,
      why: pct > 0 ? `${staff.length} staff: ${pct}% multi-staff discount on the monthly fee` : 'one staff member: no discount',
    };
  }

  const tenMonths = monthly * 10;
  const teamYear = (monthly - discount) * 12;
  const lines: InvoiceLine[] = staff.map((s) => ({ label: phrases.months(s.label, 12), amount_mnt: s.monthlyMnt * 12 }));
  if (teamYear < tenMonths) {
    lines.push({ label: phrases.teamDiscount(staff.length, pct), amount_mnt: -discount * 12 });
    return {
      kind: 'annual_prepay', everyMonths: 12, lines, amountMnt: teamYear,
      why: `annual prepay: the ${pct}% multi-staff discount over 12 months (${teamYear}) beats 10 months' price (${tenMonths}); discounts do not stack`,
    };
  }
  lines.push({ label: phrases.annualFree(2), amount_mnt: -monthly * 2 });
  return {
    kind: 'annual_prepay', everyMonths: 12, lines, amountMnt: tenMonths,
    why: pct > 0
      ? `annual prepay: 10 months' price (${tenMonths}) beats the ${pct}% discount over 12 months (${teamYear}); discounts do not stack`
      : "annual prepay: 12 months for 10 months' price",
  };
}

/** `"Дали — AI хүлээн авагч=250000"` → a staff price. The founder's command-line form. */
export function parseStaff(arg: string): StaffPrice {
  const eq = arg.lastIndexOf('=');
  if (eq <= 0) throw new RangeError(`expected "<label>=<monthly amount>", got ${JSON.stringify(arg)}`);
  const label = arg.slice(0, eq).trim().normalize('NFC');
  const amount = arg.slice(eq + 1).trim().replace(/[,\s]/gu, '');
  if (!/^[0-9]+$/u.test(amount)) throw new RangeError(`${label}: ${JSON.stringify(arg.slice(eq + 1))} is not a whole amount`);
  return { label, monthlyMnt: Number(amount) };
}
