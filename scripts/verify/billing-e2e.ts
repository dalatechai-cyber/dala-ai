/**
 * Client billing end to end, over a REAL PostgREST and PostgreSQL with every migration
 * applied (D-156). QPay, Brevo and Telegram are fakes that record what they were asked;
 * everything else — supabase-js, PostgREST, the plpgsql, the engine, the pay page, the pause
 * page — is the production code path.
 *
 *     PGRST_URL=http://127.0.0.1:3001 PGRST_JWT_SECRET=… node scripts/verify/billing-e2e.ts <database>
 *
 * The month it walks through: the 1st (invoices; one live invoice held back because its
 * wording is unsigned, then sent once it is), two runs at once (nothing doubles), the 3rd
 * (reminder), the test client pays (callback: receipt, once), the 6th (reminder after, the
 * founder's summary), the 8th (the pause question; the founder pauses from the page), a
 * WRONG amount (mismatch, no receipt), the rest arrives (paid, receipt, resume offered; the
 * founder resumes), a failed e-mail retried, a send that never finished reported and not
 * resent, an unreadable QPay answer that records nothing, and the ledger on the 1st of the
 * next month. Spends nothing and reaches no network but localhost.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js'; // guard-ok: scripts/, not src/
import { PLATFORM_TIMEZONE } from '../../src/config/platform.ts';
import { localDayStart } from '../../src/lib/time/clock.ts';
import { propose } from '../../src/lib/billing/amounts.ts';
import { runBillingTick, runInvoiceCallback, type BillingDeps } from '../../src/lib/billing/engine.ts';
import { runActionJob, runPayPageJob } from '../../src/lib/billing/jobs.ts';
import { linksFor } from '../../src/lib/billing/links.ts';
import type { QpayCheck, QpayPort } from '../../src/lib/billing/qpay.ts';
import type { EmailMessage, SendOutcome, TelegramMessage } from '../../src/lib/billing/send.ts';
import { phrasesFrom, planSchedules, writeBillingRecord } from '../../src/lib/billing/setup.ts';
import type { Wording } from '../../src/lib/billing/templates.ts';

const DB = process.argv[2] ?? 'dala_e2e';
const URL_ = process.env['PGRST_URL'] ?? 'http://127.0.0.1:3001';
const JWT_SECRET = process.env['PGRST_JWT_SECRET'] ?? 'dala-ci-postgrest-secret-at-least-32-chars';
const LINK_SECRET = 'e2e-link-secret-that-is-long-enough-000';
const ORIGIN = 'https://dala.example.com';
process.env['BILLING_LINK_SECRET'] = LINK_SECRET;

function jwt(role: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg: 'HS256', typ: 'JWT' });
  const body = b({ role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

const psql = (sql: string): string => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-qtA', '-d', DB, '-c', sql], {
  env: { ...process.env, PGHOST: process.env['PGHOST'] ?? '/tmp', PGPORT: process.env['PGPORT'] ?? '5433', PGUSER: process.env['PGUSER'] ?? 'postgres' },
  encoding: 'utf8',
}).trim();

let checks = 0;
function check(cond: unknown, what: string): void {
  if (!cond) {
    process.stderr.write(`FAIL: ${what}\n`);
    process.exit(1);
  }
  checks += 1;
  process.stdout.write(`  ok  ${what}\n`);
}

// --- fakes -------------------------------------------------------------------------------

type QInv = { amount: number; description: string; callbackUrl: string; payments: Array<{ id: string; amount: number; at: Date }> };
const qpayInvoices = new Map<string, QInv>();
let qpayCreates = 0;
let qpayUndetermined = new Set<string>();
const qpay: QpayPort = {
  token: async () => ({ ok: true, token: 't' }),
  createInvoice: async (_t, input) => {
    qpayCreates += 1;
    const id = `Q-${qpayCreates}`;
    qpayInvoices.set(id, { amount: input.amountMnt, description: input.description, callbackUrl: input.callbackUrl, payments: [] });
    return { ok: true, invoiceId: id, qrText: `qr-${id}`, qrImage: 'iVBORw0KGgo=', urls: [{ name: 'Khan', description: '', logo: '', link: `khanbank://q?${id}` }] };
  },
  checkPayment: async (_t, id): Promise<QpayCheck> => {
    if (qpayUndetermined.has(id)) return { ok: true, determined: false, reason: 'a settled payment has no payment_id', invoiceStatus: 'PAID' };
    const inv = qpayInvoices.get(id);
    return { ok: true, determined: true, invoiceStatus: null, payments: (inv?.payments ?? []).map((p) => ({ key: `qpay:${p.id}`, amountMnt: p.amount, paidAt: p.at })) };
  },
  cancelInvoice: async () => ({ ok: true }),
};

const emails: EmailMessage[] = [];
const telegrams: TelegramMessage[] = [];
/** The next e-mail matching `match` gets `outcome` instead of being sent. */
const emailScript: Array<{ match: (m: EmailMessage) => boolean; outcome: 'retry' | 'unknown' }> = [];
async function sendEmail(m: EmailMessage): Promise<SendOutcome> {
  const i = emailScript.findIndex((s) => s.match(m));
  if (i === -1) { emails.push(m); return { outcome: 'sent', providerMessageId: `m${emails.length}` }; }
  const [s] = emailScript.splice(i, 1);
  return { outcome: s!.outcome, detail: `scripted ${s!.outcome}` };
}
async function sendTelegram(m: TelegramMessage): Promise<SendOutcome> {
  telegrams.push(m);
  return { outcome: 'sent', providerMessageId: `t${telegrams.length}` };
}

function wordingFromDisk(): Wording {
  const blocks = new Map<string, string>();
  for (const dir of ['prompt/drafts/billing', 'prompt/platform']) {
    for (const f of readdirSync(dir).filter((x) => x.startsWith('billing_') && x.endsWith('.mn.txt'))) {
      blocks.set(f.slice(0, -'.mn.txt'.length), readFileSync(`${dir}/${f}`, 'utf8').trim());
    }
  }
  // As the engine would see them once signed.
  return { source: 'signed', blocks };
}

/**
 * `/rest/v1/*` → PostgREST's `/*`, as Supabase's gateway does in production and as
 * `postgrest.ts` does in CI: the genuine client against a genuine PostgREST.
 */
async function gateway(target: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const rest = (req.url ?? '/').replace(/^\/rest\/v1/u, '');
    const upstream = new URL(rest === '' ? '/' : rest, target);
    const up = http.request(upstream, { method: req.method, headers: { ...req.headers, host: upstream.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (err) => { res.writeHead(502); res.end(JSON.stringify({ message: err.message })); });
    req.pipe(up);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  return { url: `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`, close: () => server.close() };
}
const proxy = await gateway(URL_);
const db: SupabaseClient = createClient(proxy.url, jwt('service_role'), { auth: { persistSession: false, autoRefreshToken: false } });
const SIGNED = wordingFromDisk();
const UNSIGNED: Wording = { source: 'signed', blocks: new Map() };
const at = (day: string, hour = 10): Date => new Date(localDayStart(day, PLATFORM_TIMEZONE).getTime() + hour * 3_600_000);

function deps(now: Date, mode: 'test' | 'live', signed: Wording = SIGNED): BillingDeps {
  return {
    db, now, mode, qpay, links: linksFor(ORIGIN, LINK_SECRET), signed,
    sendEmail, sendTelegram, founderEmail: 'founder@example.com',
    log: (level, event, detail) => { if (level === 'error') process.stderr.write(`    [${event}] ${JSON.stringify(detail)}\n`); },
  };
}

async function tick(now: Date, mode: 'test' | 'live', signed: Wording = SIGNED) {
  const r = await runBillingTick(deps(now, mode, signed));
  if (!r.ok) { process.stderr.write(`tick failed: ${r.detail}\n`); process.exit(1); }
  return r.report;
}

const count = (sql: string): number => Number(psql(sql));
const since = <T,>(list: T[], n: number): T[] => list.slice(n);

async function main(): Promise<void> {
  // --- the clients ----------------------------------------------------------------------
  const T = 'e2e00000-0000-4000-8000-000000000001';
  const CH = 'e2e00000-0000-4000-8000-0000000000c1';
  psql(`insert into tenants (id, slug, display_name, vertical, timezone) values ('${T}', 'e2e-salon', 'Туршилтын салон', 'salon', 'Asia/Ulaanbaatar');
        insert into tenant_channels (id, tenant_id, provider, external_id, auth_flavour, app_slug, status, delivery_mode, token_status, comment_delivery_mode)
        values ('${CH}', '${T}', 'facebook_page', 'e2e-page', 'facebook_login', 'dalatech', 'active', 'shadow', 'unprovisioned', 'shadow');`);

  const phrases = phrasesFrom(SIGNED);
  const live = await writeBillingRecord(db, { tenantSlug: 'e2e-salon', isTest: false, displayName: 'Салон ХХК', email: 'owner@salon.mn', contractRef: '01/2026' },
    planSchedules({ staff: [{ label: 'Дали — AI хүлээн авагч', monthlyMnt: 250000 }, { label: 'Нова — Сануулга, SMS', monthlyMnt: 150000 }], annual: false, startMonth: '2026-10', dueDay: 5 }, phrases, '2026-09'));
  const test = await writeBillingRecord(db, { tenantSlug: null, isTest: true, displayName: 'Туршилтын харилцагч', email: 'founder@example.com', contractRef: null },
    planSchedules({ staff: [{ label: 'Туршилт', monthlyMnt: 100 }], annual: false, startMonth: '2026-10', dueDay: 5 }, phrases, '2026-09'));
  check(live.schedules[0]?.amountMnt === 360000, 'two staff are proposed at 360,000₮ (10% multi-staff discount)');
  check(propose([{ label: 'x', monthlyMnt: 250000 }], { annual: true }, phrases).amountMnt === 2500000, 'annual prepay is 10 months');

  let r = await tick(at('2026-10-01'), 'live');
  check(r.issued === 0 && count('select count(*) from billing_invoices') === 0, 'nothing is invoiced before the founder confirms');

  for (const s of [...live.schedules, ...test.schedules]) {
    const { error } = await db.rpc('billing_confirm_schedule', { p_schedule: s.id, p_expected: s.fingerprint, p_by: 'Bilguun' });
    check(error === null, `schedule ${s.kind} ${s.amountMnt} confirmed with its fingerprint`);
  }

  // --- the 1st, test mode: only the test client ------------------------------------------
  r = await tick(at('2026-10-01', 0), 'test');
  check(r.issued === 1 && count(`select count(*) from billing_invoices where is_test`) === 1 && count('select count(*) from billing_invoices where not is_test') === 0,
    'BILLING_MODE=test invoices the test client only');
  check(r.qpayCreated === 1 && emails.filter((m) => m.attachment === undefined).length === 1 && emails.some((m) => m.subject.startsWith('DalaTech — 2026 оны 10-р сарын')),
    'the test invoice has a QPay code and was e-mailed (besides the ledger CSV)');
  const testNo = psql('select invoice_no from billing_invoices where is_test');
  check(/^TEST-202610-\d{4}$/u.test(testNo), `test invoices are numbered TEST- (${testNo})`);
  check([...qpayInvoices.values()][0]?.description === `DalaTech ${testNo}`, 'the QPay description says DalaTech and the invoice number');

  // --- the 1st, live, wording unsigned: held, the founder told once ------------------------
  let e0 = emails.length; let t0 = telegrams.length;
  r = await tick(at('2026-10-01', 1), 'live', UNSIGNED);
  check(r.issued === 1 && since(emails, e0).length === 0, 'a live invoice with unsigned wording is issued but NOT sent');
  check(since(telegrams, t0).some((m) => /was NOT sent: billing_invoice_subject is not signed/u.test(m.text)), 'the founder is told why');
  t0 = telegrams.length;
  await tick(at('2026-10-01', 2), 'live', UNSIGNED);
  check(since(telegrams, t0).every((m) => !/was NOT sent/u.test(m.text)), '…once, not every hour');

  // --- signed: it goes, with the founder's copy ------------------------------------------
  e0 = emails.length; t0 = telegrams.length;
  r = await tick(at('2026-10-01', 3), 'live');
  const liveMail = since(emails, e0).find((m) => m.to === 'owner@salon.mn');
  check(liveMail !== undefined && liveMail.text.includes('360,000₮') && liveMail.text.includes(`${ORIGIN}/pay/`), 'the live client receives the invoice: amount and pay link');
  check(liveMail?.text.includes('2026.10.05') === true && liveMail.text.includes('Хөнгөлөлт: 2 AI ажилтан, 10%'), '…with the due day and the discount line');
  check(since(telegrams, t0).some((m) => m.text.startsWith('🧾 Invoice DT-202610-') && m.text.includes('owner@salon.mn')), 'the founder receives a copy');

  // --- two runs at once: nothing doubles --------------------------------------------------
  e0 = emails.length; t0 = telegrams.length;
  const creates0 = qpayCreates;
  await Promise.all([tick(at('2026-10-01', 4), 'live'), tick(at('2026-10-01', 4), 'live'), tick(at('2026-10-01', 4), 'live')]);
  check(emails.length === e0 && telegrams.length === t0 && qpayCreates === creates0, 'three simultaneous runs send nothing twice and make no second QPay invoice');
  check(count('select count(*) from billing_invoices') === 2, 'still exactly two invoices');

  // --- the 3rd: the reminder before --------------------------------------------------------
  e0 = emails.length;
  await tick(at('2026-10-03'), 'live');
  const rem = since(emails, e0);
  check(rem.length === 2 && rem.every((m) => m.subject.startsWith('Сануулга:')), 'on the 3rd both clients get the reminder');

  // --- the test client pays; QPay calls back ------------------------------------------------
  const testId = psql('select id from billing_invoices where is_test');
  const testQ = psql('select qpay_invoice_id from billing_invoices where is_test');
  qpayInvoices.get(testQ)?.payments.push({ id: 'PAY-1', amount: 100, at: at('2026-10-04') });
  e0 = emails.length; t0 = telegrams.length;
  const cb = await runInvoiceCallback(deps(at('2026-10-04'), 'live'), testId);
  check(cb.ok && psql(`select status from billing_invoices where id = '${testId}'`) === 'paid', 'the callback records the payment: paid');
  check(since(emails, e0).some((m) => m.subject.startsWith('Төлбөр хүлээн авлаа')), 'the client receives the receipt');
  check(since(telegrams, t0).some((m) => m.text.startsWith('✅ Туршилтын харилцагч paid')), 'the founder is told it was paid');
  e0 = emails.length;
  await runInvoiceCallback(deps(new Date(at('2026-10-04').getTime() + 60_000), 'live'), testId);
  await tick(at('2026-10-04', 12), 'live');
  check(emails.length === e0 && count(`select count(*) from billing_payments where invoice_id = '${testId}'`) === 1, 'a repeated callback and the hourly check count it once, and send no second receipt');

  // --- the 6th: reminder after, and the founder's summary ---------------------------------
  e0 = emails.length; t0 = telegrams.length;
  await tick(at('2026-10-06'), 'live');
  check(since(emails, e0).length === 1 && since(emails, e0)[0]?.to === 'owner@salon.mn' && /хэтэрсэн/u.test(since(emails, e0)[0]?.subject ?? ''),
    'on the 6th only the unpaid client is reminded');
  const summary = since(telegrams, t0).find((m) => m.text.startsWith('📊 Billing — October 2026'));
  check(summary !== undefined && /Paid \(0\)/u.test(summary.text) && /Not paid \(1\):\n• Салон ХХК/u.test(summary.text) && /Outstanding: 360,000₮/u.test(summary.text)
    && !summary.text.includes('Туршилт'), "the founder's summary: who has not paid, 360,000₮ outstanding, test clients left out");

  // --- the 8th: the pause question; nothing pauses by itself --------------------------------
  t0 = telegrams.length;
  await tick(at('2026-10-08'), 'live');
  const ask = since(telegrams, t0).find((m) => m.text.startsWith('⏸ Салон ХХК has not paid'));
  check(ask?.button !== undefined && /3 day\(s\) late/u.test(ask.text), 'on the 8th the founder is asked, with a button');
  check(psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow', '…and nothing is paused by the question itself');
  const token = new URL(ask?.button?.url ?? 'https://x').searchParams.get('t') ?? '';
  const notices: string[] = [];
  const get = await runActionJob({ db: () => db, now: at('2026-10-08'), method: 'GET', token, kind: 'pause', notify: async (t) => { notices.push(t); } });
  check(get.status === 200 && psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow', 'opening the link (GET) only asks to confirm');
  const post = await runActionJob({ db: () => db, now: at('2026-10-08'), method: 'POST', token, kind: 'pause', notify: async (t) => { notices.push(t); } });
  check(post.status === 200 && psql(`select delivery_mode || '/' || comment_delivery_mode from tenant_channels where id = '${CH}'`) === 'off/off', 'confirming (POST) pauses every channel');
  const badKind = await runActionJob({ db: () => db, now: at('2026-10-08'), method: 'POST', token, kind: 'resume', notify: async () => undefined });
  check(badKind.status === 404, 'a pause link cannot resume');

  // --- a wrong amount: mismatch, never a receipt --------------------------------------------
  const liveId = psql('select id from billing_invoices where not is_test');
  const liveQ = psql('select qpay_invoice_id from billing_invoices where not is_test');
  qpayInvoices.get(liveQ)?.payments.push({ id: 'PAY-2', amount: 300000, at: at('2026-10-09') });
  e0 = emails.length; t0 = telegrams.length;
  await runInvoiceCallback(deps(at('2026-10-09'), 'live'), liveId);
  check(psql(`select status from billing_invoices where id = '${liveId}'`) === 'mismatch', '300,000₮ against 360,000₮ is a mismatch');
  check(since(emails, e0).length === 0, 'no receipt for a wrong amount');
  check(since(telegrams, t0).some((m) => /payments total 300,000₮ against 360,000₮ \(short by 60,000₮\)/u.test(m.text)), 'the founder is told the exact difference');

  // --- the rest arrives: paid, receipt, resume offered ---------------------------------------
  qpayInvoices.get(liveQ)?.payments.push({ id: 'PAY-3', amount: 60000, at: at('2026-10-10') });
  e0 = emails.length; t0 = telegrams.length;
  await tick(at('2026-10-10'), 'live');
  check(psql(`select status from billing_invoices where id = '${liveId}'`) === 'paid', 'the rest arrives: the payments sum to exactly 360,000₮, paid');
  check(since(emails, e0).some((m) => m.to === 'owner@salon.mn' && m.subject.startsWith('Төлбөр хүлээн авлаа')), 'the receipt goes');
  const paidMsg = since(telegrams, t0).find((m) => m.text.startsWith('✅ Салон ХХК paid'));
  check(paidMsg?.button?.label === 'Resume Салон ХХК', 'the founder is offered a resume button, because the client is paused');
  const resumeToken = new URL(paidMsg?.button?.url ?? 'https://x').searchParams.get('t') ?? '';
  const resumed = await runActionJob({ db: () => db, now: at('2026-10-10'), method: 'POST', token: resumeToken, kind: 'resume', notify: async (t) => { notices.push(t); } });
  check(resumed.status === 200 && psql(`select delivery_mode || '/' || comment_delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow/shadow', 'resume restores the exact prior modes');
  const oldPause = await runActionJob({ db: () => db, now: at('2026-10-11'), method: 'GET', token, kind: 'pause', notify: async () => undefined });
  check(oldPause.html.includes('is PAID now'), 'the old pause link, opened after payment, says the invoice is paid');
  const oldPost = await runActionJob({ db: () => db, now: at('2026-10-11'), method: 'POST', token, kind: 'pause', notify: async () => undefined });
  check(oldPost.status === 409 && psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow', '…and pausing with it is refused: a paid client is never paused');

  // --- the pay page ---------------------------------------------------------------------
  const links = linksFor(ORIGIN, LINK_SECRET);
  const paidPage = await runPayPageJob({ db: () => db, now: at('2026-10-10'), token: links.pay(liveId).split('/pay/')[1] ?? '' });
  check(paidPage.status === 503, 'the live pay page refuses while its wording is unsigned in the database');
  const testPage = await runPayPageJob({ db: () => db, now: at('2026-10-10'), token: links.pay(testId).split('/pay/')[1] ?? '' });
  check(testPage.status === 200 && testPage.html.includes('TEST — the Mongolian wording is not signed') && !testPage.html.includes('data:image'), 'the test pay page renders in English, paid, with no QR');
  const forged = await runPayPageJob({ db: () => db, now: at('2026-10-10'), token: 'x.y' });
  check(forged.status === 404, 'a forged link is a 404');

  // --- a failed e-mail is retried; an unfinished one is reported, never resent ---------------
  const oneOff = await db.rpc('billing_issue_one_off', {
    p_account: live.accountId, p_key: 'setup-2026-10', p_lines: [{ label: 'Дали — суурилуулалт', amount_mnt: 50000 }], p_amount: 50000,
    p_issued_on: '2026-10-10', p_due_on: '2026-10-15', p_by: 'Bilguun',
  });
  check(oneOff.error === null, 'a one-off setup fee is issued by the founder');
  emailScript.push({ match: (m) => m.text.includes('50,000₮'), outcome: 'retry' });
  e0 = emails.length;
  await tick(new Date(), 'live');
  check(since(emails, e0).every((m) => m.attachment !== undefined) && psql(`select status from billing_deliveries where dedup_key like 'invoice:%' and status <> 'sent'`) === 'failed', 'a refused send is recorded as failed, to retry');
  psql(`update billing_deliveries set next_attempt_at = now() - interval '1 second' where status = 'failed'`);
  await tick(new Date(), 'live');
  check(since(emails, e0).some((m) => m.text.includes('50,000₮')), '…and goes out on the retry');

  const unknownKey = `receipt:${psql(`select id from billing_invoices where period_key = 'one_off:setup-2026-10'`)}`;
  psql(`update billing_invoices set status = 'paid', paid_sum_mnt = 50000, paid_at = now() where period_key = 'one_off:setup-2026-10'`);
  emailScript.push({ match: (m) => m.subject.startsWith('Төлбөр хүлээн авлаа') && m.text.includes('50,000₮'), outcome: 'unknown' });
  e0 = emails.length; t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(psql(`select status from billing_deliveries where dedup_key = '${unknownKey}'`) === 'sending', 'a send with no answer stays claimed');
  psql(`update billing_deliveries set claimed_at = now() - interval '11 minutes' where dedup_key = '${unknownKey}'`);
  await tick(new Date(), 'live');
  check(psql(`select status from billing_deliveries where dedup_key = '${unknownKey}'`) === 'unknown' && since(emails, e0).every((m) => m.attachment !== undefined), '…becomes unknown and is NOT sent again');
  check(since(telegrams, t0).some((m) => /may or may not have gone out/u.test(m.text)), 'the founder is told, with the requeue command');

  // --- an unreadable QPay answer records nothing ---------------------------------------------
  const late = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'late-test', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-18', p_due_on: '2026-09-21', p_by: 'Bilguun',
  });
  check(late.error === null, 'a late test invoice (due a week ago) is issued');
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  const lateQ = psql(`select qpay_invoice_id from billing_invoices where period_key = 'one_off:late-test'`);
  check(since(telegrams, t0).some((m) => m.text.startsWith('⏸ Туршилтын харилцагч has not paid')), 'an invoice already late is asked about at once, without the reminders it missed');
  qpayUndetermined = new Set([lateQ]);
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(count(`select count(*) from billing_payments p join billing_invoices i on i.id = p.invoice_id where i.period_key = 'one_off:late-test'`) === 0, 'an unreadable QPay answer records nothing');
  check(since(telegrams, t0).some((m) => /could not be read completely/u.test(m.text)), '…and the founder is told');
  qpayUndetermined = new Set();

  // --- money on a withdrawn invoice still reaches the founder ------------------------------
  const lateId = psql(`select id from billing_invoices where period_key = 'one_off:late-test'`);
  await db.rpc('billing_resolve', { p_invoice: lateId, p_outcome: 'void', p_by: 'Bilguun', p_note: 'e2e: withdrawn' });
  qpayInvoices.get(lateQ)?.payments.push({ id: 'PAY-VOID', amount: 100, at: new Date() });
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(psql(`select status || '/' || paid_sum_mnt from billing_invoices where id = '${lateId}'`) === 'void/100'
    && since(telegrams, t0).some((m) => /paid 100₮ on .* which you WITHDREW/u.test(m.text)), 'a payment on a withdrawn invoice is recorded and the founder told');

  // --- the ledger on the 1st of November -------------------------------------------------
  e0 = emails.length; t0 = telegrams.length;
  await tick(at('2026-11-01', 1), 'live');
  const ledger = since(emails, e0).find((m) => m.attachment?.name === 'dalatech-billing-2026-10.csv');
  const paysInOctober = count(`select count(*) from billing_payments p join billing_invoices i on i.id = p.invoice_id
    where not i.is_test and p.paid_at >= '2026-09-30 16:00+00' and p.paid_at < '2026-10-31 16:00+00'`);
  check(ledger !== undefined && ledger.attachment!.content.split('\r\n').filter((l) => l.startsWith('"')).length === 1 + paysInOctober,
    `the October ledger is e-mailed as CSV (${paysInOctober} payment(s) recorded in October)`);
  check(since(telegrams, t0).some((m) => m.text.startsWith('📒 Bookkeeping — October 2026')), '…and summarised on Telegram');
  check(count(`select count(*) from billing_invoices where period_key like 'monthly_fee:2026-11'`) === 2, 'November is invoiced once for each client');

  // --- a run out of time starts nothing new --------------------------------------------
  const late2 = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'budget-test', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-11-01', p_due_on: '2026-11-05', p_by: 'Bilguun',
  });
  const creates1 = qpayCreates;
  const spent = await runBillingTick({ ...deps(at('2026-11-01', 2), 'live'), deadline: 1 });
  check(late2.error === null && spent.ok && qpayCreates === creates1 && spent.report.sent === 0
    && spent.report.problems.some((p) => p.startsWith('time budget reached')), 'a run past its time budget starts no QPay call and no send');
  await tick(at('2026-11-01', 3), 'live');
  check(qpayCreates === creates1 + 1, '…and the next run does it');

  process.stdout.write(`\nbilling e2e: ${checks} checks passed\n`);
  proxy.close();
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
