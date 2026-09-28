/**
 * QPay Quick QR, for DalaTech's own invoices (D-156).
 *
 * **The same merchant, the same credentials and the same endpoint as Core Language**
 * (founder, 2026-09-28). The values are copied into this project's environment under the
 * names Core Language uses; no code is shared with it (CLAUDE.md: never import from that
 * repo), and nothing here can reach its orders, which live in its own database. Its
 * invoices are told apart from ours in QPay by their description: Core Language writes
 * «Core English - …», every one of ours begins `DalaTech` and carries our `DT-` number.
 *
 * ## Three outcomes, not two, and the difference is money
 *
 * - `ok` — QPay said what it did.
 * - `refused` — QPay answered with an HTTP 4xx. It did not create anything; try again later.
 * - `unknown` — no answer, a timeout, or a 5xx. QPay MAY have created the invoice. The
 *   caller keeps its claim and does not retry until the claim is stale (`engine.ts`), and
 *   whatever QPay made is never shown to anybody, so nobody can pay it.
 *
 * ## A payment is read, never guessed
 *
 * `checkPayment` returns the settled payments with QPay's own payment id and amount, or
 * `undetermined` with the reason. It never fills a gap: a settled row without an id or an
 * amount makes the WHOLE answer undetermined, and nothing from it is recorded. The founder
 * is told instead. Core Language's check fulfils on an unknown amount (its audit #6); this
 * one does not, because here the amount is the whole question.
 *
 * Never logs a response body: QPay's payment rows carry the payer's bank details.
 */

import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { localDayStart } from '../time/clock.ts';

export const QPAY_BASE = 'https://quickqr.qpay.mn/v2';
/**
 * Core Language's merchant category code, reused because the merchant is shared. 8299 is
 * "schools and educational services"; whether QPay expects a different code on invoices
 * for software services is a question for the founder and QPay, not a fact this repo holds.
 */
export const QPAY_MCC_CODE = '8299';
const TIMEOUT_MS = 15_000;

export type QpayConfig = {
  username: string;
  password: string;
  terminalId: string;
  merchantId: string;
  bankCode: string;
  bankAccount: string;
  accountName: string;
};

export type QpayFailure = { ok: false; outcome: 'refused' | 'unknown'; detail: string };

export type QpayInvoice = {
  ok: true;
  invoiceId: string;
  qrText: string;
  qrImage: string;
  urls: Array<{ name: string; description: string; logo: string; link: string }>;
};

export type QpayPayment = { key: string; amountMnt: number; paidAt: Date };

export type QpayCheck =
  | { ok: true; determined: true; payments: QpayPayment[]; invoiceStatus: string | null }
  | { ok: true; determined: false; reason: string; invoiceStatus: string | null; outline?: string }
  | QpayFailure;

export type QpayPort = {
  token(): Promise<{ ok: true; token: string } | QpayFailure>;
  createInvoice(token: string, input: { amountMnt: number; description: string; callbackUrl: string }): Promise<QpayInvoice | QpayFailure>;
  checkPayment(token: string, qpayInvoiceId: string): Promise<QpayCheck>;
  cancelInvoice(token: string, qpayInvoiceId: string): Promise<{ ok: true } | QpayFailure>;
};

async function call(
  fetchImpl: typeof fetch,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: true; status: number; json: unknown } | QpayFailure> {
  let res: Response;
  try {
    res = await fetchImpl(`${QPAY_BASE}${path}`, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, outcome: 'unknown', detail: `QPay ${path}: ${err instanceof Error ? err.name : 'error'}` };
  }
  if (res.status >= 400 && res.status < 500) {
    return { ok: false, outcome: 'refused', detail: `QPay ${path}: HTTP ${res.status}` };
  }
  if (!res.ok) return { ok: false, outcome: 'unknown', detail: `QPay ${path}: HTTP ${res.status}` };
  const text = await res.text().catch(() => '');
  if (text.trim() === '') return { ok: true, status: res.status, json: null };
  try {
    return { ok: true, status: res.status, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, outcome: 'unknown', detail: `QPay ${path}: HTTP ${res.status} with a body that is not JSON` };
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A whole, positive tugrik amount QPay stated, or null. `''` and `'0'` are not amounts. */
export function parseAmount(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.trim().replace(/,/gu, ''));
  else return null;
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * QPay's `payment_date`. With a zone (`Z`, `+08:00`) it is that instant. Without one it is
 * read as Ulaanbaatar wall time (QPay is a Mongolian processor) — never as the machine's
 * zone, which on Vercel is UTC and would move a payment made after 16:00 into the next day
 * and, at a month's end, into the next month's ledger. Anything else: null (the check time).
 */
export function paymentTime(v: string): Date | null {
  const t = v.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/u.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/u.exec(t);
  if (m === null) return null;
  const midnight = localDayStart(m[1] as string, PLATFORM_TIMEZONE);
  return new Date(midnight.getTime() + (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000);
}

const SETTLED = new Set(['PAID', 'SUCCESS']);
const NOT_SETTLED = new Set(['NEW', 'PENDING', 'FAILED', 'REFUNDED', 'CANCELLED', 'CANCELED', 'EXPIRED']);

/**
 * Read a `/payment/check` answer. Pure, so every shape QPay has been seen to send is a test.
 *
 * Rows are `rows` (Quick QR) or `payments` (older answers); whichever carries rows is used.
 * A row is settled when its status is PAID or SUCCESS, not settled when it is one of the
 * known unsettled states, and anything else is undetermined — an unknown status is not
 * evidence either way.
 */
export function readPaymentCheck(body: unknown, qpayInvoiceId: string, now: Date): QpayCheck {
  const b = asRecord(body);
  const invoiceStatus = typeof b['invoice_status'] === 'string' ? (b['invoice_status'] as string) : null;
  const lists = [b['rows'], b['payments']].filter((l): l is unknown[] => Array.isArray(l) && l.length > 0);
  const rows = lists[0] ?? [];
  const payments: QpayPayment[] = [];
  for (const raw of rows) {
    const r = asRecord(raw);
    const status = String(r['payment_status'] ?? r['status'] ?? '').toUpperCase();
    if (NOT_SETTLED.has(status)) continue;
    if (!SETTLED.has(status)) {
      // The status as QPay's word, or its outline: free text in it never reaches a reason.
      return { ok: true, determined: false, reason: `a payment row has status ${stringOutline(status)}`, invoiceStatus };
    }
    const id = r['payment_id'];
    const key = typeof id === 'string' && id.trim() !== '' ? id.trim() : typeof id === 'number' ? String(id) : null;
    if (key === null) return { ok: true, determined: false, reason: 'a settled payment has no payment_id', invoiceStatus };
    const amount = parseAmount(r['payment_amount'] ?? r['amount']);
    if (amount === null) return { ok: true, determined: false, reason: `settled payment ${key} has no readable amount`, invoiceStatus };
    const when = typeof r['payment_date'] === 'string' ? paymentTime(r['payment_date'] as string) : null;
    payments.push({ key: `qpay:${key}`, amountMnt: amount, paidAt: when ?? now });
  }
  if (payments.length === 0 && rows.length === 0 && (invoiceStatus === 'PAID' || invoiceStatus === 'CLOSED')) {
    // Paid, with no rows to say by what. NOT recorded under a made-up key: a later answer
    // that does carry the payment id would record the same money a second time.
    return { ok: true, determined: false, reason: `invoice ${qpayInvoiceId} is ${invoiceStatus} with no payment rows`, invoiceStatus };
  }
  return { ok: true, determined: true, payments, invoiceStatus };
}

/** QPay's own words: the only string values an outline or a reason shows as they are. */
const QPAY_WORDS = new Set([...SETTLED, ...NOT_SETTLED, 'OPEN', 'CLOSED', 'MNT']);
/** Keys whose numbers are amounts or counts, not identifiers (whole word: not `account`). */
const NUMBER_KEY = /(^|_)(amount|count|fee)$/i;
/** A key shown as it is; anything else (a map keyed by data) is shown by its length only. */
const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
/** A field name with an account, phone or IBAN inside it is data, not a field name. */
const isFieldKey = (k: string): boolean => FIELD_KEY.test(k) && !/\d{5}/.test(k);
const MAX_KEYS = 40;

/** A string reduced to its length and character classes, unless it is one of QPay's words. */
function stringOutline(v: string): string {
  if (QPAY_WORDS.has(v.toUpperCase())) return JSON.stringify(v);
  const classes = [/\d/.test(v) ? 'digits' : '', /[A-Za-z]/.test(v) ? 'latin' : '',
    /[^\dA-Za-z]/.test(v) ? 'other' : ''].filter((c) => c !== '').join('+');
  return `string(${[...v].length}${classes === '' ? '' : ` ${classes}`})`;
}

/**
 * The shape of a QPay answer with its values withheld: every field name, the type of its
 * value, the length and character classes of each string, and as they are only QPay's own
 * words (statuses, the currency) and numbers under amount/count/fee fields. Logged when an
 * answer cannot be read, so the reader can be fixed from what QPay actually sent without a
 * payer's name, account or phone ever reaching the logs.
 */
export function outlineOf(v: unknown, key = '', depth = 0): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (depth >= 4) return `array(${v.length})`;
    const items = v.slice(0, 5).map((x) => outlineOf(x, key, depth + 1));
    return `[${items.join(', ')}${v.length > 5 ? `, …${v.length - 5} more` : ''}]`;
  }
  if (typeof v === 'object') {
    if (depth >= 4) return 'object';
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const entries = keys.slice(0, MAX_KEYS).map((k) => `${isFieldKey(k) ? k : `<key ${[...k].length}>`}: `
      + outlineOf((v as Record<string, unknown>)[k], isFieldKey(k) ? k : '', depth + 1));
    return `{${entries.join(', ')}${keys.length > MAX_KEYS ? `, …${keys.length - MAX_KEYS} more` : ''}}`;
  }
  if (typeof v === 'number') return NUMBER_KEY.test(key) ? `number ${v}` : 'number';
  if (typeof v === 'boolean') return `boolean ${v}`;
  if (typeof v === 'string') {
    if (NUMBER_KEY.test(key) && /^\d{1,12}(\.\d{1,2})?$/.test(v)) return `string ${JSON.stringify(v)}`;
    return stringOutline(v);
  }
  return typeof v;
}

/** The live Quick QR port. `fetchImpl` is the test seam. */
export function quickQr(cfg: QpayConfig, fetchImpl: typeof fetch = fetch): QpayPort {
  const json = { 'content-type': 'application/json' };
  return {
    async token() {
      const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
      const r = await call(fetchImpl, '/auth/token', {
        method: 'POST',
        headers: { ...json, authorization: `Basic ${basic}` },
        body: JSON.stringify({ terminal_id: cfg.terminalId }),
      });
      if (!r.ok) return r;
      const t = asRecord(r.json)['access_token'];
      return typeof t === 'string' && t !== '' ? { ok: true, token: t } : { ok: false, outcome: 'refused', detail: 'QPay /auth/token: no access_token' };
    },

    async createInvoice(token, input) {
      const r = await call(fetchImpl, '/invoice', {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${token}` },
        body: JSON.stringify({
          merchant_id: cfg.merchantId,
          amount: input.amountMnt,
          currency: 'MNT',
          description: input.description,
          mcc_code: QPAY_MCC_CODE,
          callback_url: input.callbackUrl,
          bank_accounts: [{
            account_bank_code: cfg.bankCode,
            account_number: cfg.bankAccount,
            account_name: cfg.accountName,
            is_default: true,
          }],
        }),
      });
      if (!r.ok) return r;
      const d = asRecord(r.json);
      // Core Language reads `id`; the Quick QR SDK types say `invoice_id`. Either, never both different.
      const ids = [d['id'], d['invoice_id']].filter((v): v is string => typeof v === 'string' && v !== '');
      if (ids.length === 0 || new Set(ids).size > 1) {
        // QPay answered 2xx and may well have made an invoice we cannot name: unknown, not refused.
        return { ok: false, outcome: 'unknown', detail: `QPay /invoice: no single invoice id (keys: ${Object.keys(d).join(',')})` };
      }
      const urls = Array.isArray(d['urls']) ? d['urls'] : [];
      return {
        ok: true,
        invoiceId: ids[0] as string,
        qrText: typeof d['qr_text'] === 'string' ? d['qr_text'] : typeof d['qr_code'] === 'string' ? d['qr_code'] : '',
        qrImage: typeof d['qr_image'] === 'string' ? d['qr_image'] : '',
        urls: urls.map((u) => {
          const x = asRecord(u);
          return {
            name: String(x['name'] ?? ''), description: String(x['description'] ?? ''),
            logo: String(x['logo'] ?? ''), link: String(x['link'] ?? ''),
          };
        }).filter((u) => u.link !== ''),
      };
    },

    async checkPayment(token, qpayInvoiceId) {
      const r = await call(fetchImpl, '/payment/check', {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: qpayInvoiceId }),
      });
      if (!r.ok) return r;
      const check = readPaymentCheck(r.json, qpayInvoiceId, new Date());
      if (!check.ok || check.determined) return check;
      // An outline is for the log only; failing to make one must not stop the check.
      let outline: string;
      try { outline = outlineOf(r.json); } catch { outline = 'unoutlinable'; }
      return { ...check, outline };
    },

    async cancelInvoice(token, qpayInvoiceId) {
      const r = await call(fetchImpl, `/invoice/${encodeURIComponent(qpayInvoiceId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      return r.ok ? { ok: true } : r;
    },
  };
}
