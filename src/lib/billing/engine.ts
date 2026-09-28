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
 * messages, summaries. `live` touches every active REAL account and never a test one (0070:
 * the modes partition the accounts, in the database and here). The worker is `live` only when
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
import type { IssuerOutcome } from './issuer.ts';
import type { Links } from './links.ts';
import { mailReady, renderMail } from './mail.ts';
import { renderInvoicePdf } from './pdf.ts';
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
  /**
   * The founder's name, phone, e-mail and Khan Bank account for the branded e-mail and PDF
   * (0070, `issuer.ts`). Absent or incomplete: the plain pre-0070 e-mail is sent.
   */
  issuer?: IssuerOutcome;
  /** The DalaTech mark as an absolute https URL, for the e-mail header. */
  logoUrl?: string;
  log: (level: 'info' | 'warn' | 'error', event: string, detail: Record<string, unknown>) => void;
  /**
   * Wall-clock ms after which no new QPay call or send batch is started; the rest waits for
   * the next run. Set by the entry points. A run the platform kills mid-send leaves claimed
   * messages that must be reported as unknown, so the run stops itself well before that.
   */
  deadline?: number;
};

/** The worker's `maxDuration` is 120 s; a QPay call or a send can take 15 s each. */
export const TICK_BUDGET_MS = 55_000;
export const CALLBACK_BUDGET_MS = 25_000;

function outOfTime(deps: BillingDeps, report: TickReport): boolean {
  if (deps.deadline === undefined || Date.now() <= deps.deadline) return false;
  if (!report.problems.includes(DEFERRED)) report.problems.push(DEFERRED);
  return true;
}
const DEFERRED = 'time budget reached: the rest continues on the next run';

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

/** A message claimed longer than this and not finished is `unknown`. */
export const SEND_CLAIM_STALE = '10 minutes';
/** A definite send failure is retried after these delays, then given up. */
export const RETRY_DELAYS_MIN = [5, 15, 60, 180, 360, 720, 1440] as const;
/** The callback does not ask QPay again within this many seconds of the last answer. */
export const CALLBACK_MIN_INTERVAL_S = 20;
/** Invoices older than this are not planned (their messages are long settled). */
const PLAN_WINDOW_DAYS = 400;
const SEND_BATCH = 3;

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
  /** The contract's number, printed on the branded invoice (0070). */
  contractRef: string | null;
};

/**
 * The columns `toInvoice` reads. Each query below spells them out as a literal rather than
 * using this constant, so `scripts/verify/query-columns.ts` checks every one against the
 * schema; this copy is for the operator scripts, which that check does not read.
 */
export const INVOICE_COLUMNS = 'id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at';

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
    contractRef: typeof r['contract_ref'] === 'string' && r['contract_ref'].trim() !== '' ? r['contract_ref'].trim() : null,
  };
}

class Unavailable extends Error {}

function rows(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

async function loadInvoices(
  deps: BillingDeps,
  filter: { statuses: Invoice['status'][]; id?: string; updatedSince?: Date },
): Promise<Invoice[]> {
  let q = deps.db.from('billing_invoices').select('id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at').in('status', filter.statuses);
  // 0070: the modes partition the accounts. Live never reads a test invoice, nor test a live one.
  q = q.eq('is_test', deps.mode === 'test');
  if (filter.updatedSince !== undefined) q = q.gte('updated_at', filter.updatedSince.toISOString());
  if (filter.id !== undefined) q = q.eq('id', filter.id);
  else q = q.gte('created_at', new Date(deps.now.getTime() - PLAN_WINDOW_DAYS * 86_400_000).toISOString());
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) throw new Unavailable(`billing_invoices unreadable: ${error.message}`);
  return rows(data).map(toInvoice);
}

async function loadAccounts(deps: BillingDeps, ids: string[]): Promise<Map<string, Account>> {
  const out = new Map<string, Account>();
  if (ids.length === 0) return out;
  const { data, error } = await deps.db.from('billing_accounts').select('id, tenant_id, display_name, email, is_test, contract_ref').in('id', [...new Set(ids)]);
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
  attachment?: { name: string; body: string; encoding?: 'utf8' | 'base64' };
  /** The HTML version of a client e-mail (0070). */
  html?: string;
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
    // 0070. Written only when set, so a row planned without them is exactly what it was.
    ...(p.attachment?.encoding === 'base64' ? { attachment_encoding: 'base64' } : {}),
    ...(p.html === undefined ? {} : { html_body: p.html }),
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
    pay_link: deps.links.pay(inv.id, inv.invoiceNo),
    paid_date: inv.paidAt === null ? '' : dottedDay(ubDayOf(inv.paidAt)),
    ...(period === undefined ? {} : { period }),
  };
}

function ubDayOf(at: Date): string {
  return billingToday(at);
}

type Branded = { text: string; html: string; pdf: { name: string; base64: string } | null };

/**
 * The branded e-mail for one message (0070), or null while it cannot be sent (a block not
 * signed, a setting missing: the founder is told once, and the plain e-mail goes instead),
 * or 'refused' when it should be sendable and does not render (a signed block that breaks
 * its placeholders, an invoice too long for one PDF page): then NOTHING is sent and the
 * founder is told, exactly as a plain message that does not render.
 */
async function brandedMail(
  deps: BillingDeps, report: TickReport, inv: Invoice, account: Account,
  kind: 'invoice' | 'reminder_before' | 'reminder_after' | 'receipt', w: Wording, values: Record<string, string>,
): Promise<Branded | null | 'refused'> {
  const issuer = deps.issuer ?? { ok: false as const, missing: ['(no issuer settings were read)'] };
  const ready = mailReady(w, issuer);
  if (!ready.ok || !issuer.ok) {
    const why = ready.ok ? 'the issuer settings are incomplete' : ready.why;
    await problem(deps, `branded_unready:${deps.mode}:${why.startsWith('these settings') ? 'settings' : 'wording'}`,
      `invoices still go out as the plain e-mail, not the branded one with the PDF: ${why}.`, inv.isTest, report);
    return null;
  }
  const payUrl = deps.links.pay(inv.id, inv.invoiceNo);
  const mail = renderMail({
    kind, wording: w, invoice: inv, account, issuer: issuer.issuer, payUrl,
    ...(values['period'] === undefined ? {} : { period: values['period'] }),
    logoUrl: deps.logoUrl ?? '',
  });
  const pdf = kind === 'receipt' ? null : await renderInvoicePdf({ wording: w, invoice: inv, account, issuer: issuer.issuer, payUrl });
  const why = !mail.ok ? mail.why : pdf !== null && !pdf.ok ? pdf.why : null;
  if (why !== null || !mail.ok) {
    await problem(deps, `wording:${kind}:${inv.id}`,
      `the ${kind.replace('_', ' ')} for ${account.displayName} (${inv.invoiceNo}) was NOT sent: ${why ?? 'it did not render'}.`, inv.isTest, report);
    return 'refused';
  }
  return { text: mail.text, html: mail.html, pdf: pdf === null || !pdf.ok ? null : { name: pdf.name, base64: pdf.base64 } };
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
  // Planned once, ever: a message already in the outbox is not rendered again (0070: the PDF
  // is not free to make every hour), and what it said is what the founder's copy quotes.
  const { data: planned, error: plannedErr } = await deps.db.from('billing_deliveries')
    .select('body').eq('dedup_key', `${kind}:${inv.id}`).maybeSingle();
  if (!plannedErr && planned !== null) return str((planned as Record<string, unknown>)['body']);
  const w = wordingFor(deps, account);
  const values = { ...clientValues(deps, w, inv, account), ...extra };
  const subject = render(w, keys.subject, values);
  // 0070: the branded e-mail (HTML, plain text, the PDF) once it can be sent; until then
  // the plain e-mail below, exactly as before. A client without an e-mail is the founder's
  // to forward by hand, so the plain text is what they need.
  const branded = account.email === null ? null : await brandedMail(deps, report, inv, account, kind, w, values);
  if (branded === 'refused') return null;
  const body = branded === null ? render(w, keys.body, values) : { ok: true as const, text: branded.text };
  if (!subject.ok || !body.ok) {
    const why = !subject.ok ? subject.why : body.ok ? '' : body.why;
    await problem(deps, `wording:${kind}:${inv.id}`,
      `the ${kind.replace('_', ' ')} for ${account.displayName} (${inv.invoiceNo}) was NOT sent: ${why}. `
      + 'It goes out on the first run after the wording is signed.', inv.isTest, report);
    return null;
  }
  // The branded text carries its own draft mark.
  const draftMark = w.source === 'draft' && branded === null ? '[TEST — unsigned draft wording]\n\n' : '';
  const text = `${draftMark}${body.text}`;
  const dedupKey = `${kind}:${inv.id}`;
  if (account.email !== null) {
    await enqueue(deps, {
      dedupKey, kind, channel: 'email', recipient: account.email, subject: subject.text, body: text,
      isTest: inv.isTest, accountId: account.id, invoiceId: inv.id, onlyWhileUnpaid,
      ...(branded === null ? {} : {
        html: branded.html,
        ...(branded.pdf === null ? {} : { attachment: { name: branded.pdf.name, body: branded.pdf.base64, encoding: 'base64' as const } }),
      }),
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

// ---------------------------------------------------------------------------------------
// QPay codes (0068). A code is a QPay Quick QR invoice: it lives five minutes, so it is made
// when the client opens the pay page (never at issue, never stored in a message), and an
// invoice holds as many as the client needs. A payment on any of them is that invoice's.
// ---------------------------------------------------------------------------------------

/** QPay refuses a code five minutes after it was made (QP2036). */
export const QPAY_CODE_LIFETIME_MS = 5 * 60_000;
/** The page counts down to a little before QPay's own end, never past it. */
const CODE_SAFETY_MS = 10_000;
/** A code with at least this long left is shown again (a reload), not replaced. */
export const CODE_REUSE_MIN_LEFT_MS = 3 * 60_000;
/** A renew pressed twice, or a reload right after it, shows the code just made. */
const CODE_RENEW_DEBOUNCE_MS = 20_000;
/** However the link is opened, at most this many codes an hour per invoice. */
export const CODES_PER_HOUR = 20;
/** A code is answered for the last time this long after it stopped taking money. */
export const CODE_SETTLE_MS = 60 * 60_000;
/** A code QPay has not answered for this long after it expired: the founder is told. */
export const CODE_STALE_MS = 24 * 3_600_000;

export type PayCode = {
  id: string;
  invoiceId: string;
  qpayInvoiceId: string;
  qrImage: string;
  urls: Array<{ name: string; logo: string; link: string }>;
  createdAt: Date;
  expiresAt: Date;
  checkedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  /** Every payment key QPay has ever reported on this code. */
  reportedKeys: string[];
};

function toCode(r: Record<string, unknown>): PayCode {
  const urls = Array.isArray(r['urls']) ? (r['urls'] as Array<Record<string, unknown>>) : [];
  return {
    id: str(r['id']),
    invoiceId: str(r['invoice_id']),
    qpayInvoiceId: str(r['qpay_invoice_id']),
    qrImage: typeof r['qr_image'] === 'string' ? r['qr_image'] : '',
    urls: urls.map((u) => ({ name: str(u['name']), logo: str(u['logo']), link: str(u['link']) })),
    createdAt: date(r['created_at']) ?? new Date(0),
    expiresAt: date(r['expires_at']) ?? new Date(0),
    checkedAt: date(r['checked_at']),
    closedAt: date(r['closed_at']),
    cancelledAt: date(r['cancelled_at']),
    reportedKeys: Array.isArray(r['reported_keys']) ? (r['reported_keys'] as unknown[]).map(str) : [],
  };
}

const CODE_PAGE = 500;

/**
 * The codes still watched (not yet answered for after they stopped taking money), every one
 * of them: read in pages, because a list cut short by the server's row limit would silently
 * drop the newest codes, the ones clients are paying.
 */
async function watchedCodes(deps: BillingDeps, only?: string): Promise<PayCode[]> {
  const out: PayCode[] = [];
  for (let from = 0; ; from += CODE_PAGE) {
    let q = deps.db.from('billing_qpay_codes')
      .select('id, invoice_id, qpay_invoice_id, qr_image, urls, created_at, expires_at, checked_at, closed_at, cancelled_at, reported_keys')
      .is('closed_at', null);
    if (only !== undefined) q = q.eq('invoice_id', only);
    const { data, error } = await q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + CODE_PAGE - 1);
    if (error) throw new Unavailable(`billing_qpay_codes unreadable: ${error.message}`);
    const page = rows(data).map(toCode);
    out.push(...page);
    if (page.length < CODE_PAGE) return out;
  }
}

/** Every key QPay ever reported on any code of these invoices, closed codes included. */
async function everReported(deps: BillingDeps, invoiceIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (invoiceIds.length === 0) return out;
  const { data, error } = await deps.db.from('billing_qpay_codes').select('invoice_id, reported_keys')
    .in('invoice_id', [...new Set(invoiceIds)]).not('reported_keys', 'eq', '{}');
  if (error) throw new Unavailable(`billing_qpay_codes unreadable: ${error.message}`);
  for (const r of rows(data)) {
    const set = out.get(str(r['invoice_id'])) ?? new Set<string>();
    for (const k of Array.isArray(r['reported_keys']) ? r['reported_keys'] : []) set.add(str(k));
    out.set(str(r['invoice_id']), set);
  }
  return out;
}

async function invoicesById(deps: BillingDeps, ids: string[]): Promise<Map<string, Invoice>> {
  const out = new Map<string, Invoice>();
  if (ids.length === 0) return out;
  const q = deps.db.from('billing_invoices').select('id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at').in('id', [...new Set(ids)])
    .eq('is_test', deps.mode === 'test'); // 0070: the modes partition the accounts
  const { data, error } = await q;
  if (error) throw new Unavailable(`billing_invoices unreadable: ${error.message}`);
  for (const r of rows(data)) out.set(str(r['id']), toInvoice(r));
  return out;
}

/**
 * Ask QPay about every watched code and record what it reports. Per invoice, every code is
 * asked first and the payments recorded after, together: the database is told every key
 * QPay named for the invoice, so a hand entry QPay itself names is never taken for a
 * conflict, and one that it does not name still stops the record (0067).
 *
 * A callback, a page visit and the hourly run all come here. A callback about a paid or a
 * withdrawn invoice still asks: money that reaches the merchant must reach the founder.
 */
async function syncPayments(deps: BillingDeps, report: TickReport, recordedBy: string, only?: string): Promise<void> {
  const codes = await watchedCodes(deps, only);
  if (codes.length === 0) return;
  const invoices = await invoicesById(deps, codes.map((c) => c.invoiceId));
  const byInvoice = new Map<string, PayCode[]>();
  for (const c of codes) {
    if (!invoices.has(c.invoiceId)) continue; // a live invoice in test mode
    byInvoice.set(c.invoiceId, [...(byInvoice.get(c.invoiceId) ?? []), c]);
  }
  if (byInvoice.size === 0) return;
  // A callback or a page visit does not ask again about a code answered moments ago; with
  // nothing left to ask, QPay is not called at all (not even for a token).
  if (only !== undefined) {
    for (const [id, list] of byInvoice) {
      const due = list.filter((c) => c.checkedAt === null || deps.now.getTime() - c.checkedAt.getTime() >= CALLBACK_MIN_INTERVAL_S * 1000);
      if (due.length === 0) byInvoice.delete(id); else byInvoice.set(id, due);
    }
    if (byInvoice.size === 0) return;
  }
  // Least recently checked first, so a slow QPay cannot starve the same invoices every hour.
  const order = [...byInvoice.entries()].sort(([, a], [, b]) =>
    Math.min(...a.map((c) => c.checkedAt?.getTime() ?? -1)) - Math.min(...b.map((c) => c.checkedAt?.getTime() ?? -1)));
  const named = await everReported(deps, [...byInvoice.keys()]);
  const t = await deps.qpay.token();
  if (!t.ok) {
    deps.log('warn', 'billing.qpay_token_failed', { detail: t.detail });
    for (const [id, list] of order) for (const c of list) await checkStale(deps, invoices.get(id) as Invoice, c, report, t.detail);
    return;
  }
  for (const [i, [invoiceId, list]] of order.entries()) {
    const inv = invoices.get(invoiceId) as Invoice;
    if (outOfTime(deps, report)) {
      for (const [id, rest] of order.slice(i)) for (const c of rest) await checkStale(deps, invoices.get(id) as Invoice, c, report, 'not reached within the time budget');
      return;
    }
    const found: Array<{ code: PayCode; payment: { key: string; amountMnt: number; paidAt: Date } }> = [];
    const answered: Array<{ code: PayCode; keys: string[]; pending: boolean }> = [];
    let unreadable = false;
    for (const code of list) {
      const check = await deps.qpay.checkPayment(t.token, code.qpayInvoiceId);
      if (!check.ok) { await checkStale(deps, inv, code, report, check.detail); unreadable = true; continue; }
      report.checked += 1;
      if (!check.determined) {
        // The outline carries no values but QPay's own words and amounts (outlineOf).
        deps.log('warn', 'billing.qpay_undetermined', { invoice: inv.invoiceNo, code: code.qpayInvoiceId, reason: check.reason, outline: check.outline ?? null });
        await problem(deps, `undetermined:${inv.id}:${check.reason}`,
          `QPay's answer for ${inv.invoiceNo} could not be read completely (${check.reason}). Nothing was recorded. `
          + 'Check the payment in the QPay merchant app; if it is real, record it under QPay\'s own payment id: '
          + `node scripts/billing/settle.ts qpay --invoice ${inv.invoiceNo} --payment-id <id> --amount <amount> --paid-on <YYYY-MM-DD> --by <you>`,
          inv.isTest, report);
        unreadable = true;
        continue;
      }
      answered.push({ code, keys: check.payments.map((p) => p.key), pending: check.pending === true });
      for (const p of check.payments) found.push({ code, payment: p });
    }
    // A code that could not be read is asked again next time (and reported if that goes on);
    // what the others report is recorded now. The database still refuses a payment a hand
    // entry may already hold under an id no answer named (0067).
    // Every key QPay has named for this invoice, now or on a code answered before (closed ones
    // included): a hand entry QPay once named is never taken for a conflict (0067).
    const reported = [...new Set([...(named.get(inv.id) ?? []), ...found.map((f) => f.payment.key)])];
    if (reported.length > 0) {
      // A QPay payment settled by hand (settle.ts qpay) is keyed by the id the founder typed.
      // If QPay's answers name none of those ids, the same money may be here under another
      // key: record nothing and ask, never count it twice.
      const { data: prior, error: priorErr } = await deps.db.from('billing_payments')
        .select('payment_key, recorded_by').eq('invoice_id', inv.id).eq('source', 'qpay');
      if (priorErr) {
        await problem(deps, `payments_unreadable:${inv.id}:${billingToday(deps.now)}`,
          `QPay reports a payment for ${inv.invoiceNo}, but the payments already recorded could not be read (${priorErr.message}). `
          + 'Nothing was recorded; the next run tries again.', inv.isTest, report);
        continue;
      }
      const byHand = ((prior ?? []) as { payment_key: string; recorded_by: string }[])
        .filter((r) => r.recorded_by.startsWith('operator:') && !reported.includes(r.payment_key));
      const fresh = found.map((f) => f.payment.key).filter((k) => !((prior ?? []) as { payment_key: string }[]).some((r) => r.payment_key === k));
      if (byHand.length > 0 && fresh.length > 0) {
        await problem(deps, `hand_qpay:${inv.id}:${[...new Set(fresh)].sort().join(',')}`,
          `QPay reports ${[...new Set(fresh)].join(', ')} for ${inv.invoiceNo}, and QPay has never named `
          + `${byHand.map((r) => r.payment_key).join(', ')}, which was recorded by hand. Decide: if the hand entry was this same money `
          + '(typed under another id), nothing more is needed; if it was a different payment, this one is a second payment — record it with '
          + `settle.ts qpay --invoice ${inv.invoiceNo} --payment-id <QPay's id> --second-payment yes. Nothing was recorded automatically.`,
          inv.isTest, report);
        continue;
      }
    }
    let failed = false;
    const seen = new Set<string>();
    for (const { code, payment: p } of found) {
      if (seen.has(p.key)) continue; // the same payment named by two answers is one payment
      seen.add(p.key);
      const { data, error } = await deps.db.rpc('billing_record_payment', {
        p_invoice: inv.id, p_payment_key: p.key, p_source: 'qpay', p_amount: p.amountMnt,
        p_paid_at: p.paidAt.toISOString(), p_qpay_invoice_id: code.qpayInvoiceId, p_recorded_by: recordedBy, p_note: null,
        // Every payment QPay named for this invoice: a hand entry under one of these ids is a
        // payment QPay identified, not a conflict (0067). The database decides under its lock.
        p_reported_keys: reported,
      });
      if (error) {
        failed = true;
        await problem(deps, `record:${p.key}`, `a QPay payment for ${inv.invoiceNo} was not recorded: ${error.message}`, inv.isTest, report);
        continue;
      }
      if ((data as Record<string, unknown> | null)?.['inserted'] === true) report.paymentsRecorded += 1;
    }
    if (failed) continue;
    if (unreadable) report.problems.push(`a code of ${inv.invoiceNo} could not be read; asked again next run`);
    // Answered, and recorded: note it; a code answered after it could no longer take money
    // (plus a margin for QPay's own settling) is final and no longer asked about.
    for (const { code, keys, pending } of answered) {
      // A payment QPay has shown in flight for a day: the founder is told, once per code.
      if (pending && deps.now.getTime() - code.expiresAt.getTime() >= CODE_STALE_MS) {
        await problem(deps, `pending_stale:${code.id}`,
          `QPay has shown a payment in flight on a code of ${inv.invoiceNo} (${code.qpayInvoiceId}) for over ${CODE_STALE_MS / 3_600_000} hours. `
          + 'It is not recorded; it is still asked about every hour. Check it with QPay.', inv.isTest, report);
      }
      // Final: answered after it could no longer take money, with nothing still in flight.
      const final = !pending && deps.now.getTime() >= code.expiresAt.getTime() + CODE_SETTLE_MS;
      const { error } = await deps.db.from('billing_qpay_codes').update({
        checked_at: deps.now.toISOString(),
        reported_keys: [...new Set([...code.reportedKeys, ...keys])].sort(),
        ...(final ? { closed_at: deps.now.toISOString() } : {}),
      }).eq('id', code.id);
      if (error) report.problems.push(`check time of a code of ${inv.invoiceNo} not recorded: ${error.message}`);
    }
    const { error } = await deps.db.from('billing_invoices').update({ qpay_checked_at: deps.now.toISOString() }).eq('id', inv.id);
    if (error) report.problems.push(`check time of ${inv.invoiceNo} not recorded: ${error.message}`);
  }
}

async function checkStale(deps: BillingDeps, inv: Invoice, code: PayCode, report: TickReport, detail: string): Promise<void> {
  // A code QPay could take money on, never answered for since it stopped: a payment made on
  // it may be unrecorded. Once per code.
  const since = Math.max(code.expiresAt.getTime(), code.checkedAt?.getTime() ?? 0);
  if (deps.now.getTime() - since < CODE_STALE_MS) return;
  await problem(deps, `check_stale:${code.id}`,
    `QPay has not answered a payment check for a code of ${inv.invoiceNo} (${code.qpayInvoiceId}) for over ${CODE_STALE_MS / 3_600_000} hours (${detail}). `
    + 'A payment made on it is not recorded yet; it is still asked about every hour.', inv.isTest, report);
}

export type PayPageState =
  | { kind: 'code'; invoice: Invoice; code: PayCode; now: Date }
  | { kind: 'no_code'; invoice: Invoice; why: 'capped' }
  | { kind: 'settled'; invoice: Invoice }
  | { kind: 'unavailable'; detail: string };

/**
 * What the client's pay page shows for one invoice (0068). QPay is asked first, so an invoice
 * paid a moment ago shows as paid, not as a new code. While it is open: the code on screen if
 * it has long enough left (a reload), else a new one — recorded BEFORE it is shown, so a
 * payment on it always finds this invoice. `renew` is the «Шинэ QR код авах» button.
 *
 * The button (and only the button) withdraws the code it replaces at QPay, best effort: a
 * client is less likely to pay twice. A reload or a second tab never withdraws anything. A
 * payment made on a withdrawn code before the withdrawal still counts; it is watched like
 * any other.
 */
export async function payPageState(given: BillingDeps, invoiceId: string, renew: boolean): Promise<PayPageState> {
  const deps: BillingDeps = { ...given, deadline: given.deadline ?? Date.now() + CALLBACK_BUDGET_MS };
  const report = emptyReport(deps);
  // `deps.now` is when the visit began; QPay is asked a few seconds later.
  const wallStart = Date.now();
  const nowish = (): Date => new Date(deps.now.getTime() + (Date.now() - wallStart));
  try {
    await syncPayments(deps, report, 'check', invoiceId);
    // A payment recorded just now is receipted by the callback or the next run.
    await plan(deps, report.today, report, invoiceId);
    const found = await invoicesById(deps, [invoiceId]);
    const invoice = found.get(invoiceId);
    if (invoice === undefined) return { kind: 'unavailable', detail: 'not found' };
    if (invoice.status !== 'open') return { kind: 'settled', invoice };

    const { data: latestRows, error: latestErr } = await deps.db.from('billing_qpay_codes')
      .select('id, invoice_id, qpay_invoice_id, qr_image, urls, created_at, expires_at, checked_at, closed_at, cancelled_at, reported_keys')
      .eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(1);
    if (latestErr) return { kind: 'unavailable', detail: latestErr.message };
    const latest = rows(latestRows).map(toCode)[0];
    const now = nowish().getTime();
    if (latest !== undefined && latest.cancelledAt === null && latest.closedAt === null && latest.qrImage !== '') {
      const left = latest.expiresAt.getTime() - now;
      const fresh = now - latest.createdAt.getTime() < CODE_RENEW_DEBOUNCE_MS;
      if ((!renew && left >= CODE_REUSE_MIN_LEFT_MS) || (renew && fresh && left > 0)) {
        return { kind: 'code', invoice, code: latest, now: new Date(now) };
      }
    }

    const { data: slot, error: slotErr } = await deps.db.rpc('billing_pay_code_slot', { p_invoice: invoiceId, p_max_per_hour: CODES_PER_HOUR });
    if (slotErr) return { kind: 'unavailable', detail: slotErr.message };
    if (slot === 'capped') return { kind: 'no_code', invoice, why: 'capped' };
    if (slot !== 'ok') return { kind: 'settled', invoice: { ...invoice, status: slot as Invoice['status'] } };

    const t = await deps.qpay.token();
    if (!t.ok) return { kind: 'unavailable', detail: t.detail };
    const requestedAt = nowish().getTime();
    const made = await deps.qpay.createInvoice(t.token, {
      amountMnt: invoice.amountMnt,
      description: `DalaTech ${invoice.invoiceNo}`,
      callbackUrl: deps.links.callback(invoice.id),
    });
    if (!made.ok) {
      deps.log('warn', 'billing.qpay_create_failed', { invoice: invoice.invoiceNo, outcome: made.outcome, detail: made.detail });
      return { kind: 'unavailable', detail: made.detail };
    }
    // QPay's five minutes start before its answer reached us: count from the request.
    const expiresAt = new Date(requestedAt + QPAY_CODE_LIFETIME_MS - CODE_SAFETY_MS);
    const { data: status, error: addErr } = await deps.db.rpc('billing_add_pay_code', {
      p_invoice: invoice.id, p_qpay_invoice_id: made.invoiceId, p_qr_text: made.qrText, p_qr_image: made.qrImage,
      p_urls: made.urls, p_expires_at: expiresAt.toISOString(),
    });
    if (addErr) {
      // Not recorded, so never shown: nobody holds it. Withdraw it so it takes no money.
      const c = await deps.qpay.cancelInvoice(t.token, made.invoiceId);
      deps.log('error', 'billing.qpay_code_not_recorded', { invoice: invoice.invoiceNo, detail: addErr.message, withdrawn: c.ok });
      return { kind: 'unavailable', detail: addErr.message };
    }
    const code: PayCode = {
      id: '', invoiceId: invoice.id, qpayInvoiceId: made.invoiceId, qrImage: made.qrImage, urls: made.urls,
      createdAt: new Date(requestedAt), expiresAt, checkedAt: null, closedAt: null, cancelledAt: null, reportedKeys: [],
    };
    // Only the button withdraws, and only the code the client was looking at when they pressed
    // it: a reload, a second tab or a link preview never takes away a code someone may be
    // paying (best effort; a payment made before the withdrawal still counts).
    if (renew && latest !== undefined && latest.cancelledAt === null && latest.expiresAt.getTime() > nowish().getTime()) {
      const c = await deps.qpay.cancelInvoice(t.token, latest.qpayInvoiceId);
      if (c.ok) await deps.db.from('billing_qpay_codes').update({ cancelled_at: new Date().toISOString() }).eq('id', latest.id);
    }
    if (status !== 'open') return { kind: 'settled', invoice: { ...invoice, status: status as Invoice['status'] } };
    return { kind: 'code', invoice, code, now: nowish() };
  } catch (err) {
    if (err instanceof Unavailable) return { kind: 'unavailable', detail: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// 4: plan
// ---------------------------------------------------------------------------------------

async function plan(deps: BillingDeps, today: string, report: TickReport, only?: string): Promise<void> {
  const invoices = await loadInvoices(deps, { statuses: ['open', 'mismatch', 'paid', 'void'], ...(only === undefined ? {} : { id: only }) });
  const accounts = await loadAccounts(deps, invoices.map((i) => i.accountId));
  const paused = await openPauses(deps);
  for (const inv of invoices) {
    const account = accounts.get(inv.accountId);
    if (account === undefined) { report.problems.push(`invoice ${inv.invoiceNo} has no readable account`); continue; }

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
            + `Pay link: ${deps.links.pay(inv.id, inv.invoiceNo)}\n\nCopy of what the client received:\n\n${text}`,
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
          isTest: inv.isTest, accountId: account.id, invoiceId: inv.id, onlyWhileUnpaid: true,
          body: `⏸ ${account.displayName} has not paid ${inv.invoiceNo}: ${formatMnt(inv.amountMnt)}, due ${dottedDay(inv.dueOn)}, `
            + `${stage.daysLate} day(s) late.${who}\n`
            + 'Contract 4.9 allows a pause once payment is MORE than 7 days late. Nothing happens unless you tap below and confirm.',
          button: { label: `Pause ${account.displayName}`, url: deps.links.action('pause', account.id, inv.id, deps.now) },
        }, report);
      }
    }

    if (inv.status === 'void' && inv.paidSumMnt > 0) {
      await enqueue(deps, {
        dedupKey: `founder_void_paid:${inv.id}:${inv.paidSumMnt}`, kind: 'founder_mismatch', channel: 'telegram', recipient: 'founder',
        isTest: inv.isTest, accountId: account.id, invoiceId: inv.id,
        body: `⚠️ ${account.displayName} paid ${formatMnt(inv.paidSumMnt)} on ${inv.invoiceNo}, which you WITHDREW. `
          + 'The money reached the merchant; decide whether to refund it or apply it to another invoice. No receipt was sent.',
      }, report);
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
  const { data: invData, error: invErr } = await db.from('billing_invoices').select('id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at')
    .in('id', [...new Set(pays.map((p) => str(p['invoice_id'])))]);
  if (invErr) throw new Unavailable(`billing_invoices unreadable: ${invErr.message}`);
  const invoices = new Map(rows(invData).map((r) => [str(r['id']), toInvoice(r)]));
  const { data: accData, error: accErr } = await db.from('billing_accounts').select('id, tenant_id, display_name, email, is_test')
    .in('id', [...new Set([...invoices.values()].map((i) => i.accountId))]);
  if (accErr) throw new Unavailable(`billing_accounts unreadable: ${accErr.message}`);
  const accounts = new Map(rows(accData).map((r) => [str(r['id']), toAccount(r)]));
  const out: LedgerRow[] = [];
  for (const p of pays) {
    const inv = invoices.get(str(p['invoice_id']));
    if (inv === undefined) throw new Unavailable(`payment ${str(p['payment_key'])} names an unreadable invoice`);
    // One ledger per kind: test payments never inflate what the business received.
    if ((mode === 'test') !== inv.isTest) continue;
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
    // Live summaries are about clients: test invoices are left out (test mode shows only them).
    const invoices = (await loadInvoices(deps, { statuses: ['open', 'mismatch', 'paid'] })).filter((i) => isTest || !i.isTest);
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
  // Small batches, the budget checked before each: a claimed message is sent in this run
  // or it becomes `unknown`, so never claim more than the time left can send.
  for (let round = 0; round < 40; round += 1) {
    if (outOfTime(deps, report)) return;
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
          ...(typeof d['html_body'] === 'string' && d['html_body'] !== '' ? { html: d['html_body'] } : {}),
          ...(typeof d['attachment_name'] === 'string'
            ? { attachment: {
              name: d['attachment_name'], content: str(d['attachment_body']),
              encoding: d['attachment_encoding'] === 'base64' ? 'base64' as const : 'utf8' as const,
            } } : {}),
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
export async function runBillingTick(given: BillingDeps): Promise<TickResult> {
  const deps: BillingDeps = { ...given, deadline: given.deadline ?? Date.now() + TICK_BUDGET_MS };
  const report = emptyReport(deps);
  const today = report.today;
  try {
    await issue(deps, today, report);
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
export async function runInvoiceCallback(given: BillingDeps, invoiceId: string): Promise<TickResult> {
  const deps: BillingDeps = { ...given, deadline: given.deadline ?? Date.now() + CALLBACK_BUDGET_MS };
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
