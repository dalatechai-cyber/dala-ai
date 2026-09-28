/**
 * The four billing surfaces, as functions the routes adapt (D-156). As with the other
 * workers, **nothing in a route file may branch**: every decision is here, where a test
 * reaches it.
 *
 * - `runBillingWorkerJob` — QStash, hourly. Signature first; `BILLING_MODE` off is a 200
 *   that does nothing; a database that cannot be read is a 503 so QStash retries.
 * - `runQpayCallbackJob` — QPay's `callback_url`. Authenticated by the signed link in its
 *   own URL (QPay does not sign callbacks), and it trusts nothing QPay sends: it asks QPay.
 * - `runPayPageJob` — the client's page. Public; the signed link is the key.
 * - `runActionJob` — the founder's pause/resume. GET confirms, POST acts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { billingLinkSecret, billingOrigin, billingSwitch, founderEmail, qpayConfigFromEnv } from './config.ts';
import {
  runBillingTick, runInvoiceCallback, toInvoice, type Account, type BillingDeps, type TickReport,
} from './engine.ts';
import { linksFor, verifyLink } from './links.ts';
import { actionConfirmPage, actionDonePage, notFoundPage, renderPayPage, type PageOutcome } from './page.ts';
import { quickQr } from './qpay.ts';
import { sendBrevoEmail, sendFounderTelegram } from './send.ts';
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
  return {
    db,
    now,
    mode,
    qpay: quickQr(qpayConfigFromEnv()),
    links: linksFor(billingOrigin(), billingLinkSecret()),
    signed: wording.wording,
    sendEmail: (m) => sendBrevoEmail(m),
    sendTelegram: (m) => sendFounderTelegram(m),
    founderEmail: founderEmail(),
    log,
  };
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

export async function runPayPageJob(input: { db: () => SupabaseClient; now: Date; token: string }): Promise<PageOutcome> {
  let claims;
  try {
    claims = verifyLink(billingLinkSecret(), input.token, 'pay', input.now);
  } catch {
    return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  }
  if (claims === null) return notFoundPage();
  const db = input.db();
  const { data, error } = await db.from('billing_invoices')
    .select('id, account_id, period_key, invoice_no, kind, lines, amount_mnt, period_start, period_end, issued_on, due_on, is_test, status, paid_sum_mnt, paid_at, qpay_invoice_id, qpay_checked_at, created_at, qpay_qr_image, qpay_urls').eq('id', claims.id).maybeSingle();
  if (error) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  if (data === null) return notFoundPage();
  const row = data as Record<string, unknown>;
  const invoice = toInvoice(row);
  if (invoice.status === 'void') return notFoundPage();
  const { data: acc, error: accErr } = await db.from('billing_accounts')
    .select('id, tenant_id, display_name, email, is_test').eq('id', invoice.accountId).maybeSingle();
  if (accErr || acc === null) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  const a = acc as Record<string, unknown>;
  const account: Account = {
    id: String(a['id']), tenantId: typeof a['tenant_id'] === 'string' ? a['tenant_id'] : null,
    displayName: String(a['display_name'] ?? ''), email: null, isTest: a['is_test'] === true,
  };
  const wording = await loadSignedWording(db);
  if (!wording.ok) return actionDonePage('DalaTech', 'Service temporarily unavailable.', 503);
  const urls = Array.isArray(row['qpay_urls']) ? (row['qpay_urls'] as Array<Record<string, unknown>>) : [];
  return renderPayPage({
    invoice, account,
    qrImage: typeof row['qpay_qr_image'] === 'string' ? row['qpay_qr_image'] : '',
    urls: urls.map((u) => ({ name: String(u['name'] ?? ''), logo: String(u['logo'] ?? ''), link: String(u['link'] ?? '') })),
  }, wording.wording);
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
