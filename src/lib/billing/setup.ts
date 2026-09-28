/**
 * Creating a client's billing record: the account and its UNCONFIRMED schedules (D-156).
 * Shared by `scripts/billing/account.ts` and `scripts/onboard/tenant.ts --billing-staff`, so a
 * client onboarded by either path gets exactly the same rows.
 *
 * Nothing written here is ever invoiced by itself. A schedule is invoiced only after the
 * founder confirms it with the fingerprint this prints (`billing_confirm_schedule`), and
 * the fingerprint covers the lines, the amount, the cycle, the first month and the due day.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { propose, type Phrases, type Proposal, type StaffPrice } from './amounts.ts';
import { render, type Wording } from './templates.ts';

export type AccountInput = {
  tenantSlug: string | null;
  isTest: boolean;
  displayName: string;
  email: string | null;
  contractRef: string | null;
};

export type ScheduleInput = {
  staff: StaffPrice[];
  annual: boolean;
  /** `YYYY-MM`: the first month the schedule invoices. */
  startMonth: string;
  dueDay: number;
  hosting?: { amountMnt: number; startMonth: string; label: string };
};

export type PlannedSchedule = { kind: 'monthly_fee' | 'annual_prepay' | 'hosting'; everyMonths: 1 | 12; lines: Proposal['lines']; amountMnt: number; nextMonth: string; dueDay: number; why: string };

/** The line wording (`billing_line_*`), signed if it is, else the drafts, for the founder to confirm. */
export function phrasesFrom(w: Wording): Phrases {
  const need = (r: ReturnType<typeof render>): string => {
    if (!r.ok) throw new Error(`line wording: ${r.why}`);
    return r.text;
  };
  return {
    months: (label, months) => need(render(w, 'billing_line_months', { label, months: String(months) })),
    teamDiscount: (count, percent) => need(render(w, 'billing_line_team_discount', { count: String(count), percent: String(percent) })),
    annualFree: (months) => need(render(w, 'billing_line_annual_free', { months: String(months) })),
  };
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export function planSchedules(input: ScheduleInput, phrases: Phrases, currentMonth: string): PlannedSchedule[] {
  for (const m of [input.startMonth, input.hosting?.startMonth].filter((x): x is string => x !== undefined)) {
    if (!MONTH_RE.test(m)) throw new RangeError(`${m} is not a YYYY-MM month`);
    if (m < currentMonth) throw new RangeError(`${m} is before this month (${currentMonth}); a past period is a one-off charge (scripts/billing/charge.ts), never a schedule`);
  }
  if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 28) throw new RangeError('the due day is 1–28');
  const out: PlannedSchedule[] = [];
  if (input.staff.length > 0) {
    const p = propose(input.staff, { annual: input.annual }, phrases);
    out.push({ kind: p.kind, everyMonths: p.everyMonths, lines: p.lines, amountMnt: p.amountMnt, nextMonth: `${input.startMonth}-01`, dueDay: input.dueDay, why: p.why });
  }
  if (input.hosting !== undefined) {
    if (!Number.isInteger(input.hosting.amountMnt) || input.hosting.amountMnt <= 0) throw new RangeError('hosting must be a positive whole amount');
    out.push({
      kind: 'hosting', everyMonths: 12, lines: [{ label: input.hosting.label, amount_mnt: input.hosting.amountMnt }],
      amountMnt: input.hosting.amountMnt, nextMonth: `${input.hosting.startMonth}-01`, dueDay: input.dueDay, why: 'yearly hosting, paid in advance (contract 4.4)',
    });
  }
  if (out.length === 0) throw new RangeError('nothing to invoice: give --staff and/or --hosting');
  return out;
}

export type WriteResult = { accountId: string; createdAccount: boolean; schedules: Array<{ id: string; kind: string; fingerprint: string; amountMnt: number }> };

/** Write the account (or find it) and insert the schedules, unconfirmed. Refuses to replace an active schedule. */
export async function writeBillingRecord(db: SupabaseClient, acc: AccountInput, schedules: PlannedSchedule[]): Promise<WriteResult> {
  let tenantId: string | null = null;
  if (acc.tenantSlug !== null) {
    const { data, error } = await db.from('tenants').select('id').eq('slug', acc.tenantSlug).maybeSingle();
    if (error) throw new Error(`tenants unreadable: ${error.message}`);
    if (data === null) throw new Error(`no tenant with slug ${acc.tenantSlug}`);
    tenantId = String((data as Record<string, unknown>)['id']);
  }
  const displayName = acc.displayName.normalize('NFC').trim();
  let q = db.from('billing_accounts').select('id, display_name, email, is_test');
  q = tenantId !== null ? q.eq('tenant_id', tenantId) : q.eq('is_test', true).eq('display_name', displayName);
  const { data: found, error: findErr } = await q.maybeSingle();
  if (findErr) throw new Error(`billing_accounts unreadable: ${findErr.message}`);
  let accountId: string;
  let createdAccount = false;
  if (found === null) {
    const { data, error } = await db.from('billing_accounts').insert({
      tenant_id: tenantId, display_name: displayName, email: acc.email, is_test: acc.isTest,
      contract_ref: acc.contractRef?.normalize('NFC') ?? null,
    }).select('id').single();
    if (error) throw new Error(`billing account not written: ${error.message}`);
    accountId = String((data as Record<string, unknown>)['id']);
    createdAccount = true;
  } else {
    accountId = String((found as Record<string, unknown>)['id']);
  }
  const { data: active, error: actErr } = await db.from('billing_schedules').select('id, kind').eq('account_id', accountId).eq('active', true);
  if (actErr) throw new Error(`billing_schedules unreadable: ${actErr.message}`);
  const activeKinds = new Set((Array.isArray(active) ? active : []).map((r) => String((r as Record<string, unknown>)['kind'])));
  for (const s of schedules) {
    if (activeKinds.has(s.kind) || (s.kind !== 'hosting' && (activeKinds.has('monthly_fee') || activeKinds.has('annual_prepay')))) {
      throw new Error(`the account already has an active ${s.kind === 'hosting' ? 'hosting' : 'fee'} schedule; end it first (account.ts end-schedule)`);
    }
  }
  const out: WriteResult['schedules'] = [];
  for (const s of schedules) {
    const { data, error } = await db.from('billing_schedules').insert({
      account_id: accountId, kind: s.kind, lines: s.lines, amount_mnt: s.amountMnt, every_months: s.everyMonths,
      next_month: s.nextMonth, due_day: s.dueDay,
    }).select('id').single();
    if (error) throw new Error(`schedule ${s.kind} not written: ${error.message}`);
    const id = String((data as Record<string, unknown>)['id']);
    const { data: fp, error: fpErr } = await db.rpc('billing_schedule_fingerprint', { p_schedule: id });
    if (fpErr) throw new Error(`fingerprint unreadable: ${fpErr.message}`);
    out.push({ id, kind: s.kind, fingerprint: String(fp), amountMnt: s.amountMnt });
  }
  return { accountId, createdAccount, schedules: out };
}
