/**
 * Ора's packs through DalaTech's billing (0081; the ora repo's docs/DALA_AI_CHANGE_REQUEST.md
 * and docs/PAYMENTS.md). Ора is a separate DalaTech product; money for it moves here only.
 *
 * Two directions, two secrets, never the same value:
 *
 * - **Ора → here**: `POST /api/ora/pack-invoice`, signed with `ORA_PLATFORM_SECRET`. It makes
 *   (or finds again) the one-off invoice for one Ора order, keyed `one_off:ora-pack-<32 hex>`,
 *   and answers its number and pay address. The amount and the line are this module's, never
 *   the request's; the request must name the same amount or it is refused.
 * - **here → Ора**: one signed `pack.paid` event per paid pack invoice, through the billing
 *   outbox (`billing_deliveries`, channel `webhook`), signed with
 *   `ORA_BILLING_WEBHOOK_SECRET_TEST` for a test account. The row holds the event WITHOUT
 *   its time; each delivery adds `ts` and is signed then, because Ора refuses an event signed
 *   more than 15 minutes ago. The event's `id` is the same on every retry, so Ора counts it
 *   once however often it arrives.
 *
 * ## Test first: the 100₮ test pack only (founder, 2026-10-01, "option B")
 *
 * Only a TEST account (`is_test`) can be invoiced, only while `BILLING_MODE=test`, and only
 * the 100₮ test pack. The real 49,000₮ pack is refused (`live_not_enabled`) until the founder
 * says go; enabling it is a separate change that adds its amount, its line and
 * `ORA_BILLING_WEBHOOK_SECRET_LIVE`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { billingToday } from './calendar.ts';
import { billingLinkSecret, billingOrigin, billingPayOrigin, billingSwitch } from './config.ts';
import { linksFor } from './links.ts';
import type { SendOutcome } from './send.ts';

/** The one product Ора may request today: the founder's 100₮ test pack. */
export const ORA_TEST_PACK = {
  amountMnt: 100,
  // The founder's line, as Ора's change request writes it (§1). Read on a test account only:
  // the founder is the payer.
  label: 'Ора — туршилтын багц (100₮)',
} as const;

export const ORA_BODY_LIMIT = 4096;
/** A request signed further than this from now, either way, is refused. */
export const ORA_REQUEST_SKEW_MS = 5 * 60_000;
const KEY_PREFIX = 'ora-pack-';
const ORDER_RE = /^ord_([0-9a-f]{32})$/u;
const PACK_KEY_RE = /^one_off:ora-pack-([0-9a-f]{32})$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SIGNATURE_RE = /^v1=[0-9a-f]{64}$/u;
const SECRET_MIN = 32;

/** The Ора order a pack invoice was made for, or null when the invoice is not a pack. */
export function oraPackOrder(periodKey: string): string | null {
  const m = PACK_KEY_RE.exec(periodKey);
  return m === null ? null : `ord_${m[1] as string}`;
}

export function signOra(secret: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Whether `header` is `v1=<hex HMAC-SHA256(secret, body)>`, compared in constant time. */
export function oraSignatureValid(secret: string, body: string, header: string | null): boolean {
  if (header === null || !SIGNATURE_RE.test(header)) return false;
  const want = Buffer.from(signOra(secret, body), 'utf8');
  const given = Buffer.from(header, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

function secretFrom(v: string | undefined): string | null {
  return v === undefined || v.length < SECRET_MIN ? null : v;
}

export type OraJobResult = { status: number; body: Record<string, unknown> };

/**
 * One pack invoice for one Ора order. The same order always answers the same invoice
 * (`billing_issue_one_off` is idempotent on its key), so Ора may retry freely.
 *
 * 503 not configured or the database unreadable (Ора retries); 413 too large; 401 signature
 * or time; 422 well signed but refused (`reason` says which rule); 200 `{invoice_no, pay_url}`.
 */
export async function runOraPackInvoiceJob(input: {
  db: () => SupabaseClient; now: Date; rawBody: string; signature: string | null;
}): Promise<OraJobResult> {
  let mode;
  try {
    mode = billingSwitch();
  } catch {
    return { status: 503, body: { error: 'bad_billing_mode' } };
  }
  if (mode === 'off') return { status: 503, body: { error: 'disabled' } };
  const secret = secretFrom(process.env['ORA_PLATFORM_SECRET']);
  if (secret === null) return { status: 503, body: { error: 'not_configured' } };
  if (Buffer.byteLength(input.rawBody, 'utf8') > ORA_BODY_LIMIT) return { status: 413, body: { error: 'too_large' } };
  if (!oraSignatureValid(secret, input.rawBody, input.signature)) return { status: 401, body: { error: 'bad_signature' } };

  let req: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    req = parsed as Record<string, unknown>;
  } catch {
    return { status: 422, body: { error: 'refused', reason: 'bad_request' } };
  }
  const ts = typeof req['ts'] === 'string' ? Date.parse(req['ts']) : Number.NaN;
  if (Number.isNaN(ts) || Math.abs(input.now.getTime() - ts) > ORA_REQUEST_SKEW_MS) return { status: 401, body: { error: 'stale' } };
  const refuse = (reason: string): OraJobResult => ({ status: 422, body: { error: 'refused', reason } });
  const account = req['account'];
  const order = typeof req['order'] === 'string' ? ORDER_RE.exec(req['order']) : null;
  if (req['v'] !== 1 || typeof account !== 'string' || !UUID_RE.test(account) || order === null
    || typeof req['test'] !== 'boolean' || typeof req['amount_mnt'] !== 'number') return refuse('bad_request');
  const test = req['test'];
  // 0070: the modes partition the accounts. A test pack is only payable while billing is in test.
  if (test !== (mode === 'test')) return refuse('wrong_mode');
  if (!test) return refuse('live_not_enabled');
  if (req['amount_mnt'] !== ORA_TEST_PACK.amountMnt) return refuse('wrong_amount');

  const db = input.db();
  const { data: acc, error: accErr } = await db.from('billing_accounts').select('id, is_test, status, ora_account')
    .eq('id', account).maybeSingle();
  if (accErr) return { status: 503, body: { error: 'unavailable' } };
  if (acc === null) return refuse('unknown_account');
  const a = acc as Record<string, unknown>;
  if (a['ora_account'] !== true) return refuse('not_an_ora_account');
  if (a['status'] !== 'active') return refuse('account_not_active');
  if (a['is_test'] !== test) return refuse('wrong_mode');

  const today = billingToday(input.now);
  const { data, error } = await db.rpc('billing_issue_one_off', {
    p_account: account, p_key: `${KEY_PREFIX}${order[1] as string}`,
    p_lines: [{ label: ORA_TEST_PACK.label, amount_mnt: ORA_TEST_PACK.amountMnt }], p_amount: ORA_TEST_PACK.amountMnt,
    p_issued_on: today, p_due_on: today, p_by: 'ora',
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', event: 'ora.pack_invoice_failed', detail: error.message }));
    return { status: 503, body: { error: 'unavailable' } };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  const invoiceId = typeof r['invoice_id'] === 'string' ? r['invoice_id'] : '';
  const invoiceNo = typeof r['invoice_no'] === 'string' ? r['invoice_no'] : '';
  if (invoiceId === '' || invoiceNo === '') return { status: 503, body: { error: 'unavailable' } };
  let payUrl: string;
  try {
    payUrl = linksFor(billingOrigin(), billingLinkSecret(), billingPayOrigin()).pay(invoiceId, invoiceNo);
  } catch {
    return { status: 503, body: { error: 'not_configured' } };
  }
  console.log(JSON.stringify({ level: 'info', event: 'ora.pack_invoice', invoice: invoiceNo, created: r['created'] === true }));
  return { status: 200, body: { invoice_no: invoiceNo, pay_url: payUrl } };
}

// ---------------------------------------------------------------------------------------
// The event to Ора
// ---------------------------------------------------------------------------------------

/**
 * The `pack.paid` event as the outbox stores it: everything but `ts`, which each delivery
 * adds. One per paid pack invoice; `id` is stable across retries.
 */
export function packPaidEvent(input: {
  invoiceId: string; invoiceNo: string; accountId: string; order: string; amountMnt: number; isTest: boolean;
}): string {
  return JSON.stringify({
    v: 1, id: `pack.paid:${input.invoiceId}`, type: 'pack.paid', account: input.accountId, order: input.order,
    invoice: input.invoiceNo, amount_mnt: input.amountMnt, test: input.isTest,
  });
}

/** The stored event with this delivery's time added: `{v, id, ts, …}`, the exact bytes signed. */
export function eventForDelivery(stored: string, at: Date): string {
  const e = JSON.parse(stored) as Record<string, unknown>;
  const { v, id, ...rest } = e;
  return JSON.stringify({ v, id, ts: at.toISOString(), ...rest });
}

export type OraEvent = { body: string; isTest: boolean };
export type OraEndpoint = { url: string; secret: string };

const SEND_TIMEOUT_MS = 15_000;

/**
 * Deliver one event. Ора counts an event once by its `id`, so sending again can never
 * credit twice: a timeout or a lost connection is retried (`retry`), unlike an e-mail.
 *
 * 200 sent, with Ора's outcome kept (`credited`, `duplicate`, `already_paid`, `over_limit`);
 * 401, 422 or any other refusal is `terminal` (the founder is told why); 408, 429, 5xx and
 * no answer are `retry`. A redirect is not followed: an address that moved is a refusal.
 */
export async function deliverOraEvent(endpoint: OraEndpoint, event: OraEvent, at: Date, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  let body: string;
  try {
    body = eventForDelivery(event.body, at);
  } catch {
    return { outcome: 'terminal', detail: 'the stored event is not JSON' };
  }
  let res: Response;
  try {
    res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ora-signature': signOra(endpoint.secret, body) },
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { outcome: 'retry', detail: `Ора: no answer (${err instanceof Error ? err.name : 'error'})` };
  }
  let answer: Record<string, unknown> = {};
  try {
    const text = (await res.text()).slice(0, 2000);
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) answer = parsed as Record<string, unknown>;
  } catch {
    answer = {};
  }
  const word = (k: string): string => (typeof answer[k] === 'string' ? String(answer[k]).replace(/[^a-z_]/gu, '').slice(0, 40) : '');
  if (res.status === 200) {
    const outcome = word('outcome') || (answer['duplicate'] === true ? 'duplicate' : 'ok');
    return { outcome: 'sent', providerMessageId: `ora:${outcome}` };
  }
  const detail = `Ора answered HTTP ${res.status}${word('error') === '' ? '' : ` (${word('error')})`}`;
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { outcome: 'retry', detail };
  return { outcome: 'terminal', detail };
}

/**
 * The deployed sender: the address and the secret for the event's mode, read at send time.
 * Not configured: `retry`, so the event goes once the founder sets them (and the founder is
 * told if that never happens). A live event has no secret yet: live packs are not enabled.
 */
export function oraEventSender(): (event: OraEvent) => Promise<SendOutcome> {
  return async (event) => {
    const url = process.env['ORA_WEBHOOK_URL'];
    const secret = event.isTest ? secretFrom(process.env['ORA_BILLING_WEBHOOK_SECRET_TEST']) : null;
    if (url === undefined || !url.startsWith('https://') || secret === null) {
      return { outcome: 'retry', detail: `Ора events are not configured (ORA_WEBHOOK_URL and ORA_BILLING_WEBHOOK_SECRET_${event.isTest ? 'TEST' : 'LIVE'})` };
    }
    return deliverOraEvent({ url, secret }, event, new Date());
  };
}
