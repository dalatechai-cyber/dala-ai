/**
 * The four billing surfaces, as functions the routes adapt (D-156). As with the other
 * workers, **nothing in a route file may branch**: every decision is here, where a test
 * reaches it.
 *
 * - `runBillingWorkerJob` — QStash, hourly. Signature first; `BILLING_MODE` off is a 200
 *   that does nothing; a database that cannot be read is a 503 so QStash retries.
 * - `runQpayCallbackJob` — QPay's `callback_url`. Authenticated by the signed link in its
 *   own URL (QPay does not sign callbacks), and it trusts nothing QPay sends: it asks QPay.
 * - `runPayPageJob` — the client's page. Public; the signed link is the key. It makes the
 *   QPay code the client pays with, when they open it (QPay codes live five minutes).
 * - `runActionJob` — the founder's pause/resume. GET confirms, POST acts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  billingEmailVia, billingLinkSecret, billingOrigin, billingPayOrigin, billingSwitch, founderEmail, qpayConfigFromEnv,
} from './config.ts';
import {
  payPageState, runBillingTick, runInvoiceCallback, toInvoice, type Account, type BillingDeps, type TickReport,
} from './engine.ts';
import { issuerFromEnv, type Issuer } from './issuer.ts';
import { WORDMARK_PATH } from './mail.ts';
import { linksFor, parsePayRef, payRefMatches, verifyLink } from './links.ts';
import { actionConfirmPage, actionDonePage, notFoundPage, PAY_CODE_KEYS, renderPayPage, type PageOutcome } from './page.ts';
import { oraEventSender } from './ora.ts';
import { quickQr } from './qpay.ts';
import { sendBrevoEmail, sendFounderTelegram, sendResendEmail } from './send.ts';
import { loadSignedWording } from './templates.ts';

export type JobResult = { status: number; body: Record<string, unknown> };

function log(level: 'info' | 'warn' | 'error', event: string, detail: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...detail });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** The deployed engine's dependencies. Throws on a missing variable; callers turn that into 503. */
export async function deployedDeps(db: SupabaseClient, now: Date, mode: 'test' | 'live'): Promise<BillingDeps | { error: string }> {
  const wording = await loadSignedWording(db);
  if (!wording.ok) return { error: wording.detail };
  const via = billingEmailVia();
  return {
    db,
    now,
    mode,
    qpay: quickQr(qpayConfigFromEnv()),
    links: linksFor(billingOrigin(), billingLinkSecret(), billingPayOrigin()),
    signed: wording.wording,
    sendEmail: (m) => (via === 'resend' ? sendResendEmail(m) : sendBrevoEmail(m)),
    sendTelegram: (m) => sendFounderTelegram(m),
    sendOraEvent: oraEventSender(),
    founderEmail: founderEmail(),
    issuer: issuerFromEnv(),
    // The e-mail's wordmark (Ора's layout, 2026-10-02); the pay page keeps the square mark.
    logoUrl: `${billingOrigin().replace(/\/+$/u, '')}${WORDMARK_PATH}`,
    log,
  };
}

/**
 * The invoice a pay address names (0070): the short `DT-202610-0001-K7QM2X`, or a signed
 * link from before 0070 (those keep working: e-mails already sent carry them). Null when it
 * is neither, or the code is not that invoice's; both are a plain 404, so a guess learns
 * nothing about which invoice numbers exist.
 */
async function invoiceIdFor(db: SupabaseClient, ref: string, now: Date): Promise<string | null | 'unavailable'> {
  const secret = billingLinkSecret();
  const short = parsePayRef(ref);
  if (short !== null) {
    const { data, error } = await db.from('billing_invoices').select('id').eq('invoice_no', short.invoiceNo).maybeSingle();
    if (error) return 'unavailable';
    if (data === null) return null;
    const id = String((data as Record<string, unknown>)['id']);
    return payRefMatches(secret, id, short.code) ? id : null;
  }
  return verifyLink(secret, ref, 'pay', now)?.id ?? null;
}

function summarise(r: TickReport): Record<string, unknown> {
  return { ...r, problems: r.problems.slice(0, 20) };
}

export async function runBillingWorkerJob(input: {
  db: () => SupabaseClient;
  now: Date;
  rawBody: string;
  signature: string | null;
  verifySignature: (raw: string, signature: string | null) => Promise<boolean>;
}): Promise<JobResult> {
  if (!(await input.verifySignature(input.rawBody, input.signature))) return { status: 401, body: { error: 'bad_signature' } };
  let mode;
  try {
    mode = billingSwitch();
  } catch (err) {
    log('error', 'billing.bad_switch', { detail: err instanceof Error ? err.message : String(err) });
    return { status: 503, body: { error: 'bad_billing_mode' } };
  }
  if (mode === 'off') return { status: 200, body: { disabled: true } };
  let deps: BillingDeps | { error: string };
  try {
    deps = await deployedDeps(input.db(), input.now, mode);
  } catch (err) {
    log('error', 'billing.misconfigured', { detail: err instanceof Error ? err.message : String(err) });
    return { status: 503, body: { error: 'billing_misconfigured' } };
  }
  if ('error' in deps) return { status: 503, body: { error: 'unavailable', detail: deps.error } };
  const result = await runBillingTick(deps);
  log(result.ok ? 'info' : 'error', 'billing.tick', summarise(result.report));
  return result.ok
    ? { status: 200, body: summarise(result.report) }
    : { status: 503, body: { error: 'unavailable', detail: result.detail, report: summarise(result.report) } };
}

export async function runQpayCallbackJob(input: { db: () => SupabaseClient; now: Date; token: string }): Promise<JobResult> {
  let mode;
  try {
    mode = billingSwitch();
  } catch {
    return { status: 503, body: { error: 'bad_billing_mode' } };
  }
  if (mode === 'off') return { status: 200, body: { disabled: true } };
  let claims;
  try {
    claims = verifyLink(billingLinkSecret(), input.token, 'callback', input.now);
  } catch {
    return { status: 503, body: { error: 'billing_misconfigured' } };
  }
  if (claims === null) return { status: 404, body: { error: 'not_found' } };
  let deps: BillingDeps | { error: string };
  try {
    deps = await deployedDeps(input.db(), input.now, mode);
  } catch (err) {
    log('error', 'billing.misconfigured', { detail: err instanceof Error ? err.message : String(err) });
    return { status: 503, body: { error: 'billing_misconfigured' } };
  }
  if ('error' in deps) return { status: 503, body: { error: 'unavailable' } };
  const result = await runInvoiceCallback(deps, claims.id);
  log(result.ok ? 'info' : 'error', 'billing.callback', { invoice: claims.id, ...summarise(result.report) });
  // QPay retries a non-2xx; a 503 when we could not look is what we want it to do.
  return result.ok ? { status: 200, body: { ok: true } } : { status: 503, body: { error: 'unavailable' } };
}

/**
 * The client's pay page (0068). GET shows the invoice and a live QPay code (made now, or the
 * one on screen if it has long enough left); POST is «Шинэ QR код авах»: a new code, then a
 * redirect back to GET, so a reload never re-posts. `?state=1` is the page's own poll: the
 * invoice's status from the database, nothing asked of QPay, nothing made.
 */
export async function runPayPageJob(input: {
  db: () => SupabaseClient; now: Date; token: string; method?: 'GET' | 'POST'; stateOnly?: boolean;
}): Promise<PageOutcome> {
  const db = input.db();
  let invoiceId;
  try {
    invoiceId = await invoiceIdFor(db, input.token, input.now);
  } catch {
    return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  }
  if (invoiceId === 'unavailable') return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  if (invoiceId === null) return notFoundPage();
  const { data, error } = await db.from('billing_invoices')
    .select('id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at').eq('id', invoiceId).maybeSingle();
  if (error) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  if (data === null) return notFoundPage();
  const stored = toInvoice(data as Record<string, unknown>);
  if (stored.status === 'void') return notFoundPage();

  let mode;
  try {
    mode = billingSwitch();
  } catch {
    return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  }
  // 0070: the modes partition the accounts. A live invoice is not served while billing runs
  // in test mode, and a TEST invoice is not served once billing is live.
  if ((mode === 'test' && !stored.isTest) || (mode === 'live' && stored.isTest)) return notFoundPage();
  if (input.stateOnly === true) return { status: 200, html: JSON.stringify({ status: stored.status }), contentType: 'json' };

  const { data: acc, error: accErr } = await db.from('billing_accounts')
    .select('id, tenant_id, display_name, email, is_test, contract_ref').eq('id', stored.accountId).maybeSingle();
  if (accErr || acc === null) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  const a = acc as Record<string, unknown>;
  const account: Account = {
    id: String(a['id']), tenantId: typeof a['tenant_id'] === 'string' ? a['tenant_id'] : null,
    displayName: String(a['display_name'] ?? ''), email: null, isTest: a['is_test'] === true,
    contractRef: typeof a['contract_ref'] === 'string' && a['contract_ref'].trim() !== '' ? a['contract_ref'].trim() : null,
  };
  const extras = pageExtras();
  // Paid, or with the founder: nothing to make, QPay not needed.
  if (stored.status !== 'open' && input.method !== 'POST') {
    const wording = await loadSignedWording(db);
    if (!wording.ok) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
    return renderPayPage({ kind: 'settled', invoice: stored, account, ...extras }, wording.wording);
  }

  // Billing off: no code can be made.
  if (mode === 'off') return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  let deps: BillingDeps | { error: string };
  try {
    deps = await deployedDeps(db, input.now, mode);
  } catch (err) {
    log('error', 'billing.misconfigured', { detail: err instanceof Error ? err.message : String(err) });
    return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  }
  if ('error' in deps) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  // A live client reads only signed words: until the code lines are signed, no code is made
  // for a page that could not be shown.
  const signedDeps = deps;
  if (!stored.isTest && PAY_CODE_KEYS.some((k) => !signedDeps.signed.blocks.has(k))) {
    return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  }
  const state = await payPageState(deps, stored.id, input.method === 'POST');
  if (state.kind === 'unavailable') {
    log('warn', 'billing.pay_page_unavailable', { invoice: stored.invoiceNo, detail: state.detail });
    return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  }
  if (input.method === 'POST') return { status: 303, html: '', redirect: true };
  if (state.kind === 'code') {
    return renderPayPage({
      kind: 'code', invoice: state.invoice, account, qrImage: state.code.qrImage, urls: state.code.urls,
      secondsLeft: (state.code.expiresAt.getTime() - state.now.getTime()) / 1000, ...extras,
    }, deps.signed);
  }
  return renderPayPage({ kind: state.kind, invoice: state.invoice, account, ...extras }, deps.signed);
}

/**
 * Where «Шинэ QR код авах» sends the browser back to: the address it is on. On the short
 * host (`BILLING_PAY_ORIGIN`, rewritten to `/pay/<ref>` by next.config.mjs) that is `/<ref>`;
 * anywhere else the path the request came in on.
 */
export function payPagePath(host: string | null, ref: string, pathname: string): string {
  let payHost: string | null = null;
  try {
    const o = billingPayOrigin();
    payHost = o === null ? null : new URL(o).host;
  } catch {
    payHost = null;
  }
  if (payHost !== null && host !== null && host.toLowerCase() === payHost && parsePayRef(ref) !== null) return `/${encodeURIComponent(ref)}`;
  return pathname;
}

/** The issuer (phone, bank account) and the mark, for the page (0070); either may be absent. */
function pageExtras(): { issuer: Issuer | null; logoUrl: string | null } {
  const issuer = issuerFromEnv();
  let logoUrl: string | null = null;
  try {
    logoUrl = `${billingOrigin().replace(/\/+$/u, '')}/brand/dalatech-mark.png`;
  } catch {
    logoUrl = null;
  }
  return { issuer: issuer.ok ? issuer.issuer : null, logoUrl };
}

/**
 * The founder's tap. `method` GET renders the confirmation; POST acts, re-verifying the
 * link from the form (it expires, `links.ts`). The pause itself is one database function
 * (`billing_pause`), which keeps the prior channel modes for `billing_resume`.
 */
export async function runActionJob(input: {
  db: () => SupabaseClient; now: Date; method: 'GET' | 'POST'; token: string; kind: 'pause' | 'resume';
  notify: (text: string) => Promise<unknown>;
}): Promise<PageOutcome> {
  let claims;
  try {
    claims = verifyLink(billingLinkSecret(), input.token, input.kind, input.now);
  } catch {
    return actionDonePage('Unavailable', 'Billing is not configured on this deployment.', 503);
  }
  if (claims === null) return actionDonePage('Link expired', 'This link is not valid or has expired. Use the latest message, or scripts/billing/settle.ts.', 404);
  const db = input.db();
  const { data: acc, error } = await db.from('billing_accounts').select('id, display_name, tenant_id, is_test')
    .eq('id', claims.id).maybeSingle();
  if (error) return actionDonePage('Unavailable', `The account could not be read: ${error.message}. Nothing was changed.`, 503);
  if (acc === null) return actionDonePage('Not found', 'No such billing account. Nothing was changed.', 404);
  const client = String((acc as Record<string, unknown>)['display_name'] ?? '');
  if (input.method === 'GET') {
    // What the invoice says NOW, not when the question was sent: a client may have paid since.
    let about = '';
    if (claims.inv !== undefined) {
      const { data: inv, error: invErr } = await db.from('billing_invoices').select('invoice_no, status, amount_mnt, paid_sum_mnt')
        .eq('id', claims.inv).maybeSingle();
      if (invErr) return actionDonePage('Unavailable', `The invoice could not be read: ${invErr.message}. Nothing was changed.`, 503);
      const i = (inv ?? {}) as Record<string, unknown>;
      about = inv === null ? 'The invoice this was about no longer exists.'
        : `Invoice ${String(i['invoice_no'])} is ${String(i['status']).toUpperCase()} now (${String(i['paid_sum_mnt'])} of ${String(i['amount_mnt'])}₮ paid).`
          + (input.kind === 'pause' && i['status'] !== 'open' ? ' It is no longer unpaid, so a pause will be refused.' : '');
    }
    const test = (acc as Record<string, unknown>)['tenant_id'] === null ? ' Test account: no AI staff are linked, so only the record changes.' : '';
    return actionConfirmPage({ kind: input.kind, client, token: input.token, detail: `${about}${test}`.trim() });
  }
  if (input.kind === 'pause') {
    const { data, error: pErr } = await db.rpc('billing_pause', { p_account: claims.id, p_invoice: claims.inv ?? null, p_by: 'founder (Telegram)' });
    if (pErr) {
      const refused = pErr.code === '23514'; // check_violation: the invoice was paid or settled since
      return actionDonePage('Not paused', `${refused ? 'Refused' : 'The pause failed'}: ${pErr.message}. Nothing was changed.`, refused ? 409 : 503);
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r['already_paused'] === true) return actionDonePage('Already paused', `${client} was already paused. Nothing changed.`);
    await input.notify(`⏸ Paused ${client}: ${String(r['channels'])} channel(s) set to off. To undo, use the Resume button that comes with their payment, or: node scripts/billing/settle.ts resume --account ${claims.id} --by <you>`);
    return actionDonePage('Paused', `${client}'s AI staff are paused (${String(r['channels'])} channel(s)).`);
  }
  const { data, error: rErr } = await db.rpc('billing_resume', { p_account: claims.id, p_by: 'founder (Telegram)' });
  if (rErr) return actionDonePage('Not resumed', `The resume failed: ${rErr.message}. Nothing was changed.`, 503);
  const r = (data ?? {}) as Record<string, unknown>;
  if (r['resumed'] !== true) return actionDonePage('Not paused', `${client} is not paused. Nothing changed.`);
  const skipped = Array.isArray(r['skipped']) ? r['skipped'].length : 0;
  await input.notify(`▶️ Resumed ${client}: ${String(r['restored'])} channel(s) restored${skipped > 0 ? `, ${skipped} left off (changed while paused or no longer allowed live — check them)` : ''}.`);
  return actionDonePage('Resumed', `${client}'s AI staff are back (${String(r['restored'])} channel(s) restored${skipped > 0 ? `; ${skipped} left off — see Telegram` : ''}).`);
}
