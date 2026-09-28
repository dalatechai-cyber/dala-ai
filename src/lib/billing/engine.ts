/**
 * The billing engine: one idempotent pass that brings every invoice to where today says it
 * should be (D-156). The QStash worker runs it hourly; the QPay callback runs the part for
 * one invoice; the operator can run it from a shell (`scripts/billing/tick.ts`). Running it
 * twice, or three runs at once, does nothing a single run would not: every write is
 * guarded by a unique key or a claim in the database (`0065_billing.sql`), not by this code
 * remembering what it did.
 *
 * One pass, in order:
 *
 *   1. **Issue** this month's invoices for confirmed schedules (`billing_issue_due`).
 *   2. **QPay**: create a QPay invoice for each open invoice without one, under a claim.
 *   3. **Payments**: ask QPay about every unsettled invoice and record what it reports.
 *      The callback only makes this happen sooner; it never supplies a payment itself.
 *   4. **Plan**: enqueue the messages today calls for — the invoice, a reminder, a
 *      receipt, the founder's copies, a mismatch, the pause question — each under a
 *      dedup key, so a message is planned once however often this runs.
 *   5. **Month**: the founder's summary (from the 6th) and the bookkeeping ledger for the
 *      month that ended (from the 1st), once each.
 *   6. **Sweep**: a message claimed and never finished becomes `unknown` for the founder.
 *   7. **Send** what is due, retrying definite failures with a backoff.
 *
 * ## Test and live
 *
 * `mode = 'test'` touches only `is_test` accounts, everywhere: issuing, QPay, payments,
 * messages, summaries. `live` touches every active account. The worker is `live` only when
 * the founder sets `BILLING_MODE=live` (`config.ts`), which is the approval of the first
 * real run; until then it is `test` or off.
 *
 * ## Money is never guessed
 *
 * A QPay answer this module cannot read completely records nothing and tells the founder.
 * A payment total other than the invoice's amount is a `mismatch`, which the founder
 * settles by command. Nothing here marks an invoice paid; only `billing_record_payment`
 * does, and only when the payments it holds sum to exactly the amount.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { localDayStart } from '../time/clock.ts';
import { ubStamp } from '../time/ub.ts';
import {
  billingToday, dayOfMonth, dottedDay, monthOf, previousMonth, stageFor, SUMMARY_DAY,
} from './calendar.ts';
import type { Links } from './links.ts';
import type { QpayPort } from './qpay.ts';
import type { EmailMessage, SendOutcome, TelegramMessage } from './send.ts';
import {
  formatMnt, render, renderLines, type BillingBlockKey, type InvoiceLine, type Wording,
} from './templates.ts';

export type BillingMode = 'test' | 'live';

export type BillingDeps = {
  db: SupabaseClient;
  now: Date;
  mode: BillingMode;
  qpay: QpayPort;
  links: Links;
  /** The signed wording. */
  signed: Wording;
  /** Drafts for TEST accounts only (operator runs with `--drafts`). Never set when deployed. */
  draftsForTest?: Wording;
  sendEmail: (m: EmailMessage) => Promise<SendOutcome>;
  sendTelegram: (m: TelegramMessage) => Promise<SendOutcome>;
  /** Where the monthly ledger CSV is e-mailed. Null: Telegram only. */
  founderEmail: string | null;
  log: (level: 'info' | 'warn' | 'error', event: string, detail: Record<string, unknown>) => void;
};

export type TickReport = {
  today: string;
  mode: BillingMode;
  issued: number;
  behind: number;
  qpayCreated: number;
  checked: number;
  paymentsRecorded: number;
  planned: number;
  sent: number;
  retrying: number;
  failed: number;
  unknown: number;
  problems: string[];
};

/** A claim on a QPay creation older than this is taken over (`billing_claim_qpay`). */
export const QPAY_CLAIM_STALE = '10 minutes';
/** A message claimed longer than this and not finished is `unknown`. */
export const SEND_CLAIM_STALE = '10 minutes';
/** A definite send failure is retried after these delays, then given up. */
export const RETRY_DELAYS_MIN = [5, 15, 60, 180, 360, 720, 1440] as const;
/** The QPay check has not succeeded for this long: the founder is told. */
export const CHECK_STALE_HOURS = 24;
/** The callback does not ask QPay again within this many seconds of the last answer. */
export const CALLBACK_MIN_INTERVAL_S = 20;
/** Invoices older than this are not planned (their messages are long settled). */
const PLAN_WINDOW_DAYS = 400;
const SEND_BATCH = 25;

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

export type Invoice = {
  id: string;
  accountId: string;
  periodKey: string;
  invoiceNo: string;
  kind: 'monthly_fee' | 'annual_prepay' | 'hosting' | 'one_off';
  lines: InvoiceLine[];
  amountMnt: number;
  periodStart: string | null;
  periodEnd: string | null;
  issuedOn: string;
  dueOn: string;
  isTest: boolean;
  status: 'open' | 'paid' | 'mismatch' | 'void';
  paidSumMnt: number;
  paidAt: Date | null;
  qpayInvoiceId: string | null;
  qpayCheckedAt: Date | null;
  createdAt: Date;
};

export type Account = {
  id: string;
  tenantId: string | null;
  displayName: string;
  email: string | null;
  isTest: boolean;
};

export const INVOICE_COLUMNS =
  'id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, '
  + 'is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at';
const ACCOUNT_COLUMNS = 'id, tenant_id, display_name, email, is_test';

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const date = (v: unknown): Date | null => (typeof v === 'string' && v !== '' ? new Date(v) : null);

export function toInvoice(r: Record<string, unknown>): Invoice {
  const lines = Array.isArray(r['lines']) ? (r['lines'] as Array<Record<string, unknown>>) : [];
  return {
    id: str(r['id']),
    accountId: str(r['account_id']),
    periodKey: str(r['period_key']),
    invoiceNo: str(r['invoice_no']),
    kind: str(r['kind']) as Invoice['kind'],
    lines: lines.map((l) => ({ label: str(l['label']), amount_mnt: Number(l['amount_mnt']) })),
    amountMnt: Number(r['amount_mnt']),
    periodStart: typeof r['period_start'] === 'string' ? r['period_start'] : null,
    periodEnd: typeof r['period_end'] === 'string' ? r['period_end'] : null,
    issuedOn: str(r['issued_on']),
    dueOn: str(r['due_on']),
    isTest: r['is_test'] === true,
    status: str(r['status']) as Invoice['status'],
    paidSumMnt: Number(r['paid_sum_mnt'] ?? 0),
    paidAt: date(r['paid_at']),
    qpayInvoiceId: typeof r['qpay_invoice_id'] === 'string' && r['qpay_invoice_id'] !== '' ? r['qpay_invoice_id'] : null,
    qpayCheckedAt: date(r['qpay_checked_at']),
    createdAt: date(r['created_at']) ?? new Date(0),
  };
}

function toAccount(r: Record<string, unknown>): Account {
  return {
    id: str(r['id']),
    tenantId: typeof r['tenant_id'] === 'string' ? r['tenant_id'] : null,
    displayName: str(r['display_name']),
    email: typeof r['email'] === 'string' && r['email'] !== '' ? r['email'] : null,
    isTest: r['is_test'] === true,
  };
}

class Unavailable extends Error {}

function rows(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

async function loadInvoices(
  deps: BillingDeps,
  filter: { statuses: Invoice['status'][]; needQpay?: boolean; haveQpay?: boolean; id?: string },
): Promise<Invoice[]> {
  let q = deps.db.from('billing_invoices').select(INVOICE_COLUMNS).in('status', filter.statuses);
  if (deps.mode === 'test') q = q.eq('is_test', true);
  if (filter.needQpay === true) q = q.is('qpay_invoice_id', null);
  if (filter.haveQpay === true) q = q.not('qpay_invoice_id', 'is', null);
  if (filter.id !== undefined) q = q.eq('id', filter.id);
  else q = q.gte('created_at', new Date(deps.now.getTime() - PLAN_WINDOW_DAYS * 86_400_000).toISOString());
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) throw new Unavailable(`billing_invoices unreadable: ${error.message}`);
  return rows(data).map(toInvoice);
}

async function loadAccounts(deps: BillingDeps, ids: string[]): Promise<Map<string, Account>> {
  const out = new Map<string, Account>();
  if (ids.length === 0) return out;
  const { data, error } = await deps.db.from('billing_accounts').select(ACCOUNT_COLUMNS).in('id', [...new Set(ids)]);
  if (error) throw new Unavailable(`billing_accounts unreadable: ${error.message}`);
  for (const r of rows(data)) out.set(str(r['id']), toAccount(r));
  return out;
}

async function openPauses(deps: BillingDeps): Promise<Map<string, string>> {
  const { data, error } = await deps.db.from('billing_pauses').select('id, account_id').is('resumed_at', null);
  if (error) throw new Unavailable(`billing_pauses unreadable: ${error.message}`);
  return new Map(rows(data).map((r) => [str(r['account_id']), str(r['id'])]));
}

// ---------------------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------------------

type Planned = {
  dedupKey: string;
  kind: string;
  channel: 'email' | 'telegram';
  recipient: string;
  subject?: string;
  body: string;
  isTest: boolean;
  accountId?: string;
  invoiceId?: string;
  onlyWhileUnpaid?: boolean;
  button?: { label: string; url: string };
  attachment?: { name: string; body: string };
};

/** Enqueue once. A second plan of the same key is a no-op, by the unique index. */
async function enqueue(deps: BillingDeps, p: Planned, report: TickReport): Promise<void> {
  const { error } = await deps.db.from('billing_deliveries').upsert({
    dedup_key: p.dedupKey,
    kind: p.kind,
    channel: p.channel,
    recipient: p.recipient,
    subject: p.subject ?? null,
    body: p.body,
    is_test: p.isTest,
    account_id: p.accountId ?? null,
    invoice_id: p.invoiceId ?? null,
    only_while_unpaid: p.onlyWhileUnpaid ?? false,
    button_url: p.button?.url ?? null,
    button_label: p.button?.label ?? null,
    attachment_name: p.attachment?.name ?? null,
    attachment_body: p.attachment?.body ?? null,
  }, { onConflict: 'dedup_key', ignoreDuplicates: true });
  if (error) {
    report.problems.push(`could not queue ${p.dedupKey}: ${error.message}`);
    deps.log('error', 'billing.enqueue_failed', { dedupKey: p.dedupKey, detail: error.message });
    return;
  }
  report.planned += 1;
}

/** A problem the founder must hear about, once per key. */
async function problem(deps: BillingDeps, key: string, text: string, isTest: boolean, report: TickReport): Promise<void> {
  report.problems.push(text);
  deps.log('warn', 'billing.problem', { key, text });
  await enqueue(deps, {
    dedupKey: `problem:${key}`, kind: 'founder_problem', channel: 'telegram', recipient: 'founder',
    body: `🟠 Billing${isTest ? ' (test)' : ''}: ${text}`, isTest,
  }, report);
}

function wordingFor(deps: BillingDeps, account: Account): Wording {
  if (!account.isTest || deps.draftsForTest === undefined) return deps.signed;
  // Drafts over the signed set, for a test account only: the founder is the only reader.
  return { source: 'draft', blocks: new Map([...deps.signed.blocks, ...deps.draftsForTest.blocks]) };
}

function periodText(w: Wording, inv: Invoice): string | undefined {
  if (inv.kind === 'monthly_fee' && inv.periodStart !== null) {
    const r = render(w, 'billing_period_month', {
      year: inv.periodStart.slice(0, 4), month: String(Number(inv.periodStart.slice(5, 7))),
    });
    return r.ok ? r.text : undefined;
  }
  if (inv.periodStart !== null && inv.periodEnd !== null) {
    const r = render(w, 'billing_period_range', { start: dottedDay(inv.periodStart), end: dottedDay(inv.periodEnd) });
    return r.ok ? r.text : undefined;
  }
  return inv.lines[0]?.label;
}

function clientValues(deps: BillingDeps, w: Wording, inv: Invoice, account: Account): Record<string, string> {
  const period = periodText(w, inv);
  return {
    client: account.displayName,
    invoice_no: inv.invoiceNo,
    amount: formatMnt(inv.amountMnt),
    lines: renderLines(inv.lines),
    due_date: dottedDay(inv.dueOn),
    pay_link: deps.links.pay(inv.id),
    paid_date: inv.paidAt === null ? '' : dottedDay(ubDayOf(inv.paidAt)),
    ...(period === undefined ? {} : { period }),
  };
}

function ubDayOf(at: Date): string {
  return billingToday(at);
}

/**
 * A message to the client: by e-mail when the account has an address, otherwise to the
 * founder to forward. Rendered now, so the row holds the exact bytes that will be sent.
 */
async function planClientMessage(
  deps: BillingDeps, report: TickReport, inv: Invoice, account: Account,
  kind: 'invoice' | 'reminder_before' | 'reminder_after' | 'receipt',
  keys: { subject: BillingBlockKey; body: BillingBlockKey },
  onlyWhileUnpaid: boolean,
  extra: Record<string, string> = {},
): Promise<string | null> {
  const w = wordingFor(deps, account);
  const values = { ...clientValues(deps, w, inv, account), ...extra };
  const subject = render(w, keys.subject, values);
  const body = render(w, keys.body, values);
  if (!subject.ok || !body.ok) {
    const why = !subject.ok ? subject.why : body.ok ? '' : body.why;
    await problem(deps, `wording:${kind}:${inv.id}`,
      `the ${kind.replace('_', ' ')} for ${account.displayName} (${inv.invoiceNo}) was NOT sent: ${why}. `
      + 'It goes out on the first run after the wording is signed.', inv.isTest, report);
    return null;
  }
  const draftMark = w.source === 'draft' ? '[TEST — unsigned draft wording]\n\n' : '';
  const text = `${draftMark}${body.text}`;
  const dedupKey = `${kind}:${inv.id}`;
  if (account.email !== null) {
    await enqueue(deps, {
      dedupKey, kind, channel: 'email', recipient: account.email, subject: subject.text, body: text,
      isTest: inv.isTest, accountId: account.id, invoiceId: inv.id, onlyWhileUnpaid,
    }, report);
  } else {
    await enqueue(deps, {
      dedupKey, kind, channel: 'telegram', recipient: 'founder',
      body: `✉️ Forward to ${account.displayName} (no e-mail on file) — ${kind.replace('_', ' ')} ${inv.invoiceNo}:\n\n${text}`,
      isTest: inv.isTest, accountId: account.id, invoiceId: inv.id, onlyWhileUnpaid,
    }, report);
  }
  return text;
}

// ---------------------------------------------------------------------------------------
// 1–3: issue, QPay, payments
// ---------------------------------------------------------------------------------------

async function issue(deps: BillingDeps, today: string, report: TickReport): Promise<void> {
  const { data, error } = await deps.db.rpc('billing_issue_due', { p_today: today, p_include_live: deps.mode === 'live' });
  if (error) throw new Unavailable(`billing_issue_due failed: ${error.message}`);
  const result = (data ?? {}) as { issued?: unknown[]; behind?: Array<Record<string, unknown>> };
  report.issued += Array.isArray(result.issued) ? result.issued.length : 0;
  for (const b of Array.isArray(result.behind) ? result.behind : []) {
    report.behind += 1;
    await problem(deps, `behind:${str(b['schedule_id'])}:${str(b['next_month'])}`,
      `schedule ${str(b['schedule_id'])} (${str(b['kind'])}) is behind: its next period is ${str(b['next_month'])}, before this month. `
      + 'Nothing was invoiced for it. Decide the missed periods by hand (scripts/billing/charge.ts), then move it on '
      + '(scripts/billing/account.ts --advance).', deps.mode === 'test', report);
  }
}

async function createQpayInvoices(deps: BillingDeps, report: TickReport, only?: string): Promise<void> {
  const invoices = await loadInvoices(deps, { statuses: ['open'], needQpay: true, ...(only === undefined ? {} : { id: only }) });
  let token: string | null = null;
  for (const inv of invoices) {
    const { data: attempt, error } = await deps.db.rpc('billing_claim_qpay', { p_invoice: inv.id, p_stale_after: QPAY_CLAIM_STALE });
    if (error) { report.problems.push(`claim ${inv.invoiceNo}: ${error.message}`); continue; }
    if (attempt === null || attempt === undefined) continue; // another run holds it, or it has one
    const tries = Number(attempt);
    if (token === null) {
      const t = await deps.qpay.token();
      if (!t.ok) {
        // Getting a token creates nothing, so the claim is released whatever happened.
        await deps.db.rpc('billing_release_qpay', { p_invoice: inv.id, p_error: t.detail });
        if (tries >= 3) await problem(deps, `qpay_token:${billingToday(deps.now)}`, `QPay refuses a token (${t.detail}); no QPay invoice can be made.`, inv.isTest, report);
        return;
      }
      token = t.token;
    }
    const made = await deps.qpay.createInvoice(token, {
      amountMnt: inv.amountMnt,
      description: `DalaTech ${inv.invoiceNo}`,
      callbackUrl: deps.links.callback(inv.id),
    });
    if (!made.ok) {
      if (made.outcome === 'refused') await deps.db.rpc('billing_release_qpay', { p_invoice: inv.id, p_error: made.detail });
      // `unknown`: the claim is kept and goes stale; whatever QPay may have made is never shown.
      deps.log('warn', 'billing.qpay_create_failed', { invoice: inv.invoiceNo, outcome: made.outcome, detail: made.detail, tries });
      if (tries >= 3) {
        await problem(deps, `qpay_create:${inv.id}`,
          `QPay has not created an invoice for ${inv.invoiceNo} after ${tries} tries (${made.detail}). Still trying.`, inv.isTest, report);
      }
      continue;
    }
    const { data: set, error: setErr } = await deps.db.rpc('billing_set_qpay', {
      p_invoice: inv.id, p_qpay_invoice_id: made.invoiceId, p_qr_text: made.qrText, p_qr_image: made.qrImage, p_urls: made.urls,
    });
    if (setErr || set !== true) {
      // Not recorded, so never shown: withdraw it at QPay so it cannot linger either way.
      await deps.qpay.cancelInvoice(token, made.invoiceId);
      deps.log('error', 'billing.qpay_not_recorded', { invoice: inv.invoiceNo, detail: setErr?.message ?? 'already set' });
      continue;
    }
    report.qpayCreated += 1;
  }
}

async function syncPayments(deps: BillingDeps, report: TickReport, recordedBy: string, only?: string): Promise<void> {
  const invoices = await loadInvoices(deps, { statuses: ['open', 'mismatch'], haveQpay: true, ...(only === undefined ? {} : { id: only }) });
  if (invoices.length === 0) return;
  const t = await deps.qpay.token();
  if (!t.ok) {
    deps.log('warn', 'billing.qpay_token_failed', { detail: t.detail });
    for (const inv of invoices) await checkStale(deps, inv, report, t.detail);
    return;
  }
  for (const inv of invoices) {
    if (only !== undefined && inv.qpayCheckedAt !== null
        && deps.now.getTime() - inv.qpayCheckedAt.getTime() < CALLBACK_MIN_INTERVAL_S * 1000) continue;
    const check = await deps.qpay.checkPayment(t.token, inv.qpayInvoiceId as string);
    if (!check.ok) { await checkStale(deps, inv, report, check.detail); continue; }
    report.checked += 1;
    if (!check.determined) {
      await problem(deps, `undetermined:${inv.id}:${check.reason}`,
        `QPay's answer for ${inv.invoiceNo} could not be read completely (${check.reason}). Nothing was recorded. `
        + 'Check the payment in the QPay merchant app; record it with scripts/billing/settle.ts if it is real.', inv.isTest, report);
      continue;
    }
    let failed = false;
    for (const p of check.payments) {
      const { data, error } = await deps.db.rpc('billing_record_payment', {
        p_invoice: inv.id, p_payment_key: p.key, p_source: 'qpay', p_amount: p.amountMnt,
        p_paid_at: p.paidAt.toISOString(), p_qpay_invoice_id: inv.qpayInvoiceId, p_recorded_by: recordedBy, p_note: null,
      });
      if (error) {
        failed = true;
        await problem(deps, `record:${p.key}`, `a QPay payment for ${inv.invoiceNo} was not recorded: ${error.message}`, inv.isTest, report);
        continue;
      }
      if ((data as Record<string, unknown> | null)?.['inserted'] === true) report.paymentsRecorded += 1;
    }
    if (!failed) {
      await deps.db.from('billing_invoices').update({ qpay_checked_at: deps.now.toISOString() }).eq('id', inv.id);
    }
  }
}

async function checkStale(deps: BillingDeps, inv: Invoice, report: TickReport, detail: string): Promise<void> {
  const since = inv.qpayCheckedAt ?? inv.createdAt;
  if (deps.now.getTime() - since.getTime() < CHECK_STALE_HOURS * 3_600_000) return;
  await problem(deps, `check_stale:${inv.id}:${billingToday(deps.now)}`,
    `QPay has not answered a payment check for ${inv.invoiceNo} for over ${CHECK_STALE_HOURS} hours (${detail}). `
    + 'A payment made in that time is not recorded yet.', inv.isTest, report);
}

// ---------------------------------------------------------------------------------------
// 4: plan
// ---------------------------------------------------------------------------------------

async function plan(deps: BillingDeps, today: string, report: TickReport, only?: string): Promise<void> {
  const invoices = await loadInvoices(deps, { statuses: ['open', 'mismatch', 'paid'], ...(only === undefined ? {} : { id: only }) });
  const accounts = await loadAccounts(deps, invoices.map((i) => i.accountId));
  const paused = await openPauses(deps);
  for (const inv of invoices) {
    const account = accounts.get(inv.accountId);
    if (account === undefined) { report.problems.push(`invoice ${inv.invoiceNo} has no readable account`); continue; }
    if (inv.qpayInvoiceId === null) continue; // nothing payable exists yet: say nothing

    if (inv.status === 'open') {
      const text = await planClientMessage(deps, report, inv, account, 'invoice',
        { subject: 'billing_invoice_subject', body: 'billing_invoice_body' }, true);
      // With no e-mail on file the founder already received the text to forward; a copy of
      // it would be the same message twice.
      if (text !== null && account.email !== null) {
        const route = `e-mailed to ${account.email}`;
        await enqueue(deps, {
          dedupKey: `founder_copy:${inv.id}`, kind: 'founder_copy', channel: 'telegram', recipient: 'founder', isTest: inv.isTest,
          accountId: account.id, invoiceId: inv.id,
          body: `🧾 ${inv.isTest ? 'TEST ' : ''}Invoice ${inv.invoiceNo} — ${account.displayName}\n`
            + `${formatMnt(inv.amountMnt)}, due ${dottedDay(inv.dueOn)} (${route}).\n`
            + `Pay link: ${deps.links.pay(inv.id)}\n\nCopy of what the client received:\n\n${text}`,
        }, report);
      }
      const stage = stageFor(inv, today);
      if (stage.reminderBefore) {
        await planClientMessage(deps, report, inv, account, 'reminder_before',
          { subject: 'billing_reminder_before_subject', body: 'billing_reminder_before_body' }, true);
      }
      if (stage.reminderAfter) {
        await planClientMessage(deps, report, inv, account, 'reminder_after',
          { subject: 'billing_reminder_after_subject', body: 'billing_reminder_after_body' }, true);
      }
      if (stage.pauseAsk && !paused.has(account.id)) {
        const who = account.tenantId === null ? ' (test account: no AI staff to stop; the pause is recorded only)' : '';
        await enqueue(deps, {
          dedupKey: `founder_pause:${inv.id}`, kind: 'founder_pause', channel: 'telegram', recipient: 'founder',
          isTest: inv.isTest, accountId: account.id, invoiceId: inv.id,
          body: `⏸ ${account.displayName} has not paid ${inv.invoiceNo}: ${formatMnt(inv.amountMnt)}, due ${dottedDay(inv.dueOn)}, `
            + `${stage.daysLate} day(s) late.${who}\n`
            + 'Contract 4.9 allows a pause once payment is MORE than 7 days late. Nothing happens unless you tap below and confirm.',
          button: { label: `Pause ${account.displayName}`, url: deps.links.action('pause', account.id, inv.id, deps.now) },
        }, report);
      }
    }

    if (inv.status === 'mismatch') {
      const diff = inv.paidSumMnt - inv.amountMnt;
      await enqueue(deps, {
        dedupKey: `founder_mismatch:${inv.id}:${inv.paidSumMnt}`, kind: 'founder_mismatch', channel: 'telegram', recipient: 'founder',
        isTest: inv.isTest, accountId: account.id, invoiceId: inv.id,
        body: `⚠️ ${account.displayName} ${inv.invoiceNo}: payments total ${formatMnt(inv.paidSumMnt)} against ${formatMnt(inv.amountMnt)} `
          + `(${diff > 0 ? 'over' : 'short'} by ${formatMnt(Math.abs(diff))}). Nothing was assumed and no receipt was sent.\n`
          + `Settle: node scripts/billing/settle.ts resolve --invoice ${inv.invoiceNo} --outcome paid|void --note "…" --by <you>`,
      }, report);
    }

    if (inv.status === 'paid') {
      const receipt = await planClientMessage(deps, report, inv, account, 'receipt',
        { subject: 'billing_receipt_subject', body: 'billing_receipt_body' }, false,
        { amount: formatMnt(inv.paidSumMnt > 0 ? inv.paidSumMnt : inv.amountMnt) });
      const pauseId = paused.get(account.id);
      await enqueue(deps, {
        dedupKey: `founder_paid:${inv.id}`, kind: 'founder_paid', channel: 'telegram', recipient: 'founder',
        isTest: inv.isTest, accountId: account.id, invoiceId: inv.id,
        body: `✅ ${account.displayName} paid ${inv.invoiceNo}: ${formatMnt(inv.paidSumMnt > 0 ? inv.paidSumMnt : inv.amountMnt)}`
          + `${inv.paidAt === null ? '' : ` (${ubStamp(inv.paidAt)})`}.`
          + (receipt === null ? ' The receipt was NOT sent (see the wording problem).' : ' Receipt sent.')
          + (pauseId === undefined ? '' : '\nTheir AI staff are PAUSED. The contract restores them within 1 working day of full payment.'),
        ...(pauseId === undefined ? {} : {
          button: { label: `Resume ${account.displayName}`, url: deps.links.action('resume', account.id, inv.id, deps.now) },
        }),
      }, report);
    }
  }
}

// ---------------------------------------------------------------------------------------
// 5: the month
// ---------------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/** The founder's summary text for the month `today` is in. Pure, so it is tested. */
export function summaryText(input: {
  month: string; today: string; mode: BillingMode;
  invoices: Invoice[]; accounts: Map<string, Account>;
}): string {
  const name = (i: Invoice) => input.accounts.get(i.accountId)?.displayName ?? i.accountId;
  const inMonth = input.invoices.filter((i) => monthOf(i.issuedOn) === input.month || i.status === 'open' || i.status === 'mismatch');
  const paid = inMonth.filter((i) => i.status === 'paid' && monthOf(i.issuedOn) === input.month);
  const open = inMonth.filter((i) => i.status === 'open');
  const mismatch = inMonth.filter((i) => i.status === 'mismatch');
  const outstanding = [...open, ...mismatch].reduce((s, i) => s + Math.max(0, i.amountMnt - i.paidSumMnt), 0);
  const late = (i: Invoice) => {
    const d = -Math.round((Date.parse(`${i.dueOn}T12:00:00Z`) - Date.parse(`${input.today}T12:00:00Z`)) / 86_400_000);
    return d > 0 ? `${d} day(s) late` : d === 0 ? 'due today' : `due in ${-d} day(s)`;
  };
  const out: string[] = [`📊 Billing — ${monthName(input.month)}${input.mode === 'test' ? ' (TEST accounts only)' : ''}, as of ${dottedDay(input.today)}`];
  out.push('', `Paid (${paid.length}):`);
  for (const i of paid) out.push(`• ${name(i)} — ${i.invoiceNo} — ${formatMnt(i.paidSumMnt)}${i.paidAt === null ? '' : ` — ${dottedDay(billingToday(i.paidAt))}`}`);
  out.push('', `Not paid (${open.length}):`);
  for (const i of open) out.push(`• ${name(i)} — ${i.invoiceNo} — ${formatMnt(i.amountMnt)} — ${late(i)}`);
  if (mismatch.length > 0) {
    out.push('', `Wrong amount, waiting for you (${mismatch.length}):`);
    for (const i of mismatch) out.push(`• ${name(i)} — ${i.invoiceNo} — paid ${formatMnt(i.paidSumMnt)} of ${formatMnt(i.amountMnt)}`);
  }
  out.push('', `Outstanding: ${formatMnt(outstanding)} across ${open.length + mismatch.length} invoice(s).`);
  return out.join('\n');
}

export type LedgerRow = {
  paidAtUb: string; invoiceNo: string; client: string; source: string; paymentKey: string;
  amountMnt: number; invoiceAmountMnt: number; invoiceStatus: string;
};

/** Every payment recorded with a payment time in the Ulaanbaatar month `month`. */
export async function ledgerRows(db: SupabaseClient, month: string, mode: BillingMode): Promise<LedgerRow[]> {
  const start = localDayStart(`${month}-01`, PLATFORM_TIMEZONE);
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const end = localDayStart(`${next}-01`, PLATFORM_TIMEZONE);
  const { data, error } = await db.from('billing_payments')
    .select('invoice_id, payment_key, source, amount_mnt, paid_at')
    .gte('paid_at', start.toISOString()).lt('paid_at', end.toISOString())
    .order('paid_at', { ascending: true });
  if (error) throw new Unavailable(`billing_payments unreadable: ${error.message}`);
  const pays = rows(data);
  if (pays.length === 0) return [];
  const { data: invData, error: invErr } = await db.from('billing_invoices').select(INVOICE_COLUMNS)
    .in('id', [...new Set(pays.map((p) => str(p['invoice_id'])))]);
  if (invErr) throw new Unavailable(`billing_invoices unreadable: ${invErr.message}`);
  const invoices = new Map(rows(invData).map((r) => [str(r['id']), toInvoice(r)]));
  const { data: accData, error: accErr } = await db.from('billing_accounts').select(ACCOUNT_COLUMNS)
    .in('id', [...new Set([...invoices.values()].map((i) => i.accountId))]);
  if (accErr) throw new Unavailable(`billing_accounts unreadable: ${accErr.message}`);
  const accounts = new Map(rows(accData).map((r) => [str(r['id']), toAccount(r)]));
  const out: LedgerRow[] = [];
  for (const p of pays) {
    const inv = invoices.get(str(p['invoice_id']));
    if (inv === undefined) throw new Unavailable(`payment ${str(p['payment_key'])} names an unreadable invoice`);
    if (mode === 'test' && !inv.isTest) continue;
    const at = new Date(str(p['paid_at']));
    out.push({
      paidAtUb: ubStamp(at).replace(' UB time', ''),
      invoiceNo: inv.invoiceNo,
      client: accounts.get(inv.accountId)?.displayName ?? inv.accountId,
      source: str(p['source']),
      paymentKey: str(p['payment_key']),
      amountMnt: Number(p['amount_mnt']),
      invoiceAmountMnt: inv.amountMnt,
      invoiceStatus: inv.status,
    });
  }
  return out;
}

/** RFC 4180 CSV. Every field quoted, so a client name with a comma cannot shift a column. */
export function ledgerCsv(rowsIn: LedgerRow[]): string {
  const q = (v: string | number) => `"${String(v).replace(/"/gu, '""')}"`;
  const head = ['paid_at_ub', 'invoice_no', 'client', 'source', 'payment_key', 'amount_mnt', 'invoice_amount_mnt', 'invoice_status'];
  const lines = rowsIn.map((r) => [r.paidAtUb, r.invoiceNo, r.client, r.source, r.paymentKey, r.amountMnt, r.invoiceAmountMnt, r.invoiceStatus].map(q).join(','));
  return `${[head.map(q).join(','), ...lines].join('\r\n')}\r\n`;
}

async function month(deps: BillingDeps, today: string, report: TickReport): Promise<void> {
  const isTest = deps.mode === 'test';
  const suffix = isTest ? ':test' : '';
  if (dayOfMonth(today) >= SUMMARY_DAY) {
    const invoices = await loadInvoices(deps, { statuses: ['open', 'mismatch', 'paid'] });
    const accounts = await loadAccounts(deps, invoices.map((i) => i.accountId));
    await enqueue(deps, {
      dedupKey: `founder_summary:${monthOf(today)}${suffix}`, kind: 'founder_summary', channel: 'telegram', recipient: 'founder', isTest,
      body: summaryText({ month: monthOf(today), today, mode: deps.mode, invoices, accounts }),
    }, report);
  }
  const prev = previousMonth(monthOf(today));
  const ledger = await ledgerRows(deps.db, prev, deps.mode);
  const total = ledger.reduce((s, r) => s + r.amountMnt, 0);
  const byClient = new Map<string, number>();
  for (const r of ledger) byClient.set(r.client, (byClient.get(r.client) ?? 0) + r.amountMnt);
  const text = [
    `📒 Bookkeeping — ${monthName(prev)}${isTest ? ' (TEST accounts only)' : ''}: ${ledger.length} payment(s), ${formatMnt(total)} received.`,
    ...[...byClient.entries()].map(([c, a]) => `• ${c}: ${formatMnt(a)}`),
    '',
    `As recorded at ${ubStamp(deps.now)}. Every payment with its time and invoice, as it stands now: `
      + `node scripts/billing/report.ts ledger --month ${prev}`
      + (deps.founderEmail === null ? '' : ` (also e-mailed to ${deps.founderEmail} as CSV)`),
    'No VAT: DalaTech is not VAT-registered (contract 4.6).',
  ].join('\n');
  await enqueue(deps, {
    dedupKey: `founder_ledger:${prev}${suffix}`, kind: 'founder_ledger', channel: 'telegram', recipient: 'founder', isTest, body: text,
  }, report);
  if (deps.founderEmail !== null) {
    await enqueue(deps, {
      dedupKey: `founder_ledger_csv:${prev}${suffix}`, kind: 'founder_ledger', channel: 'email', recipient: deps.founderEmail, isTest,
      subject: `DalaTech billing ledger ${prev}${isTest ? ' (test)' : ''}`, body: text,
      attachment: { name: `dalatech-billing-${prev}${isTest ? '-test' : ''}.csv`, body: ledgerCsv(ledger) },
    }, report);
  }
}

// ---------------------------------------------------------------------------------------
// 6–7: sweep and send
// ---------------------------------------------------------------------------------------

async function sweep(deps: BillingDeps, report: TickReport): Promise<void> {
  const { data, error } = await deps.db.rpc('billing_sweep_unfinished', { p_older_than: SEND_CLAIM_STALE });
  if (error) { report.problems.push(`sweep failed: ${error.message}`); return; }
  for (const r of rows(data)) {
    report.unknown += 1;
    const kind = str(r['kind']);
    deps.log('warn', 'billing.delivery_unknown', { id: r['id'], kind });
    if (kind === 'founder_problem') continue; // never a problem about a problem
    await problem(deps, `unknown:${str(r['id'])}`,
      `a ${kind} to ${str(r['recipient'])} may or may not have gone out (the send never finished). It was NOT sent again. `
      + `If it did not arrive: node scripts/billing/settle.ts requeue --delivery ${str(r['id'])} --by <you>`, r['is_test'] === true, report);
  }
}

export function retryAt(now: Date, attempts: number): Date | null {
  const delay = RETRY_DELAYS_MIN[attempts - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay * 60_000);
}

async function sendDue(deps: BillingDeps, report: TickReport): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const { data, error } = await deps.db.rpc('billing_claim_deliveries', { p_limit: SEND_BATCH, p_include_live: deps.mode === 'live' });
    if (error) { report.problems.push(`claim failed: ${error.message}`); return; }
    const claimed = rows(data);
    if (claimed.length === 0) return;
    for (const d of claimed) {
      const id = str(d['id']);
      const kind = str(d['kind']);
      const sent = str(d['channel']) === 'email'
        ? await deps.sendEmail({
          to: str(d['recipient']), subject: str(d['subject']), text: str(d['body']),
          ...(typeof d['attachment_name'] === 'string'
            ? { attachment: { name: d['attachment_name'], content: str(d['attachment_body']) } } : {}),
        })
        : await deps.sendTelegram({
          text: str(d['body']),
          ...(typeof d['button_url'] === 'string' ? { button: { label: str(d['button_label']), url: d['button_url'] } } : {}),
        });
      if (sent.outcome === 'unknown') {
        // Left claimed on purpose: the sweep turns it into `unknown` for the founder.
        deps.log('warn', 'billing.send_unknown', { id, kind, detail: sent.detail });
        continue;
      }
      const next = sent.outcome === 'retry' ? retryAt(deps.now, Number(d['attempts'])) : null;
      const { error: finErr } = await deps.db.rpc('billing_finish_delivery', {
        p_id: id, p_ok: sent.outcome === 'sent',
        p_provider_message_id: sent.outcome === 'sent' ? sent.providerMessageId : null,
        p_error: sent.outcome === 'sent' ? null : sent.detail,
        p_retry_at: next === null ? null : next.toISOString(),
      });
      if (finErr) {
        // The send happened; recording it did not. The row stays `sending` and the sweep
        // reports it as unknown — the honest state — rather than it going out twice.
        report.problems.push(`could not record the result of ${kind} ${id}: ${finErr.message}`);
        continue;
      }
      if (sent.outcome === 'sent') { report.sent += 1; continue; }
      if (next !== null) { report.retrying += 1; continue; }
      report.failed += 1;
      deps.log('error', 'billing.send_failed', { id, kind, detail: sent.detail });
      if (kind !== 'founder_problem') {
        await problem(deps, `failed:${id}`,
          `a ${kind} to ${str(d['recipient'])} failed for good (${sent.detail}). `
          + `Fix the cause, then: node scripts/billing/settle.ts requeue --delivery ${id} --by <you>`, d['is_test'] === true, report);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

function emptyReport(deps: BillingDeps): TickReport {
  return {
    today: billingToday(deps.now), mode: deps.mode, issued: 0, behind: 0, qpayCreated: 0, checked: 0,
    paymentsRecorded: 0, planned: 0, sent: 0, retrying: 0, failed: 0, unknown: 0, problems: [],
  };
}

export type TickResult = { ok: true; report: TickReport } | { ok: false; detail: string; report: TickReport };

/** One full pass. `ok: false` only when the database could not be read: the caller retries. */
export async function runBillingTick(deps: BillingDeps): Promise<TickResult> {
  const report = emptyReport(deps);
  const today = report.today;
  try {
    await issue(deps, today, report);
    await createQpayInvoices(deps, report);
    await syncPayments(deps, report, 'check');
    await plan(deps, today, report);
    await month(deps, today, report);
    await sweep(deps, report);
    // Problems found above are queued; the send below delivers them in this same run.
    await sendDue(deps, report);
    return { ok: true, report };
  } catch (err) {
    if (err instanceof Unavailable) {
      deps.log('error', 'billing.tick_unavailable', { detail: err.message });
      // Whatever was queued before the failure still goes out.
      await sendDue(deps, report).catch(() => undefined);
      return { ok: false, detail: err.message, report };
    }
    throw err;
  }
}

/**
 * QPay called back about one invoice. The body is not read: QPay is asked directly, so a
 * forged or replayed callback can at most make the platform check sooner.
 */
export async function runInvoiceCallback(deps: BillingDeps, invoiceId: string): Promise<TickResult> {
  const report = emptyReport(deps);
  try {
    const found = await loadInvoices(deps, { statuses: ['open', 'mismatch', 'paid', 'void'], id: invoiceId });
    if (found.length === 0) return { ok: true, report }; // not ours, or a live invoice in test mode
    await syncPayments(deps, report, 'callback', invoiceId);
    await plan(deps, report.today, report, invoiceId);
    await sendDue(deps, report);
    return { ok: true, report };
  } catch (err) {
    if (err instanceof Unavailable) return { ok: false, detail: err.message, report };
    throw err;
  }
}
