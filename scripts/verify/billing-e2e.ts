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
 * founder's summary), the 13th (the pause question; the founder pauses from the page), a
 * WRONG amount (mismatch, no receipt), the rest arrives (paid, receipt, resumed automatically,
 * the founder told once), a failed e-mail retried, a send that never finished reported and not
 * resent, an unreadable QPay answer that records nothing, and the ledger on the 1st of the
 * next month. Spends nothing and reaches no network but localhost.
 */
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js'; // guard-ok: scripts/, not src/
import { PLATFORM_TIMEZONE } from '../../src/config/platform.ts';
import { localDayStart } from '../../src/lib/time/clock.ts';
import { propose } from '../../src/lib/billing/amounts.ts';
import { CODES_PER_HOUR, payPageState, runBillingTick, runInvoiceCallback, type BillingDeps } from '../../src/lib/billing/engine.ts';
import { runActionJob, runPayPageJob } from '../../src/lib/billing/jobs.ts';
import { linksFor, signLink } from '../../src/lib/billing/links.ts';
import { deliverOraEvent, oraSignatureValid, runOraPackInvoiceJob, signOra } from '../../src/lib/billing/ora.ts';
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
/** Codes whose QPay answer carries a payment still in flight (NEW/PENDING). */
const qpayPending = new Set<string>();
const qpayCancelled: string[] = [];
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
    return { ok: true, determined: true, invoiceStatus: null, pending: qpayPending.has(id), payments: (inv?.payments ?? []).map((p) => ({ key: `qpay:${p.id}`, amountMnt: p.amount, paidAt: p.at })) };
  },
  cancelInvoice: async (_t, id) => { qpayCancelled.push(id); return { ok: true }; },
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

/**
 * One hourly run. `live` stands for the whole platform once billing is live: since 0070 the
 * live run never touches a test account, so the founder's test client is served by a test
 * run beside it (as two deployments would), and the scenario keeps walking both clients.
 * `test` alone is exactly `BILLING_MODE=test`.
 */
async function tick(now: Date, mode: 'test' | 'live', signed: Wording = SIGNED) {
  const r = await runBillingTick(deps(now, mode, signed));
  if (!r.ok) { process.stderr.write(`tick failed: ${r.detail}\n`); process.exit(1); }
  if (mode === 'test') return r.report;
  const t = await runBillingTick(deps(now, 'test', signed));
  if (!t.ok) { process.stderr.write(`tick failed: ${t.detail}\n`); process.exit(1); }
  return { ...r.report, issued: r.report.issued + t.report.issued, planned: r.report.planned + t.report.planned, sent: r.report.sent + t.report.sent };
}

const count = (sql: string): number => Number(psql(sql));
/** The client opens the pay page (0068): QPay is asked, then a code is shown or made. */
// 0070: in the mode that serves the invoice — live never serves a test invoice.
const modeOf = (invoiceId: string): 'test' | 'live' => (psql(`select is_test from billing_invoices where id = '${invoiceId}'`) === 't' ? 'test' : 'live');
const openPage = (invoiceId: string, renew = false, now: Date = new Date()) => payPageState(deps(now, modeOf(invoiceId)), invoiceId, renew);
/** The newest code made for an invoice. */
const codeOf = (invoiceId: string): string => psql(`select qpay_invoice_id from billing_qpay_codes where invoice_id = '${invoiceId}' order by created_at desc limit 1`);
const codes = (invoiceId: string): number => count(`select count(*) from billing_qpay_codes where invoice_id = '${invoiceId}'`);
/** A second, concurrent session: runs `sql` in its own connection and resolves when it ends. */
const psqlAsync = (sql: string): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
  const p = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '-qtA', '-d', DB, '-c', sql], {
    env: { ...process.env, PGHOST: process.env['PGHOST'] ?? '/tmp', PGPORT: process.env['PGPORT'] ?? '5433', PGUSER: process.env['PGUSER'] ?? 'postgres' },
  });
  let out = '';
  p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  p.stderr.on('data', (d: Buffer) => { out += d.toString(); });
  p.on('close', (code) => resolve({ code, out }));
});
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
  check(qpayCreates === 0 && emails.filter((m) => m.attachment === undefined).length === 1 && emails.some((m) => m.subject.startsWith('DalaTech — 2026 оны 10-р сарын'))
    && emails.every((m) => !m.text.includes('data:image')),
    'the test invoice is e-mailed with its pay link; no QPay code is made until the page is opened');
  // Issued at 00:00 Ulaanbaatar on the 1st, still the 30th in UTC: the invoice is dated the 1st.
  check(psql('select issued_on from billing_invoices where is_test') === '2026-10-01' && at('2026-10-01', 0).toISOString().startsWith('2026-09-30'),
    'an invoice issued just after midnight in Ulaanbaatar carries the Ulaanbaatar date, not the UTC one');
  const testNo = psql('select invoice_no from billing_invoices where is_test');
  check(/^TEST-202610-\d{4}$/u.test(testNo), `test invoices are numbered TEST- (${testNo})`);
  const firstOpen = await openPage(psql('select id from billing_invoices where is_test'));
  check(firstOpen.kind === 'code' && qpayCreates === 1 && [...qpayInvoices.values()][0]?.description === `DalaTech ${testNo}`,
    'opening the pay page makes a QPay code; its description says DalaTech and the invoice number');

  // --- the 1st, live, wording unsigned: held, the founder told once ------------------------
  let e0 = emails.length; let t0 = telegrams.length;
  r = await tick(at('2026-10-01', 1), 'live', UNSIGNED);
  // Only the LIVE client's mail is the question. The page above is opened on the wall clock
  // (QPay's fake counts real time), and opening it plans that day's messages for the TEST
  // invoice: from 2026-10-03 (Ulaanbaatar) its real date fell in the reminder window, so a
  // test reminder went out here and this check, counting every e-mail, was red on main too.
  check(r.issued === 1 && since(emails, e0).filter((m) => m.to === 'owner@salon.mn').length === 0,
    'a live invoice with unsigned wording is issued but NOT sent');
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
  // Each client has exactly one reminder by the 3rd. The test client's may have gone out
  // already, planned by the wall-clock page visit above (see the unsigned-wording check).
  const reminders = (to: string): number => count(`select count(*) from billing_deliveries where kind = 'reminder_before' and status = 'sent' and recipient = '${to}'`);
  check(rem.every((m) => m.subject.startsWith('Сануулга:')) && rem.some((m) => m.to === 'owner@salon.mn')
    && reminders('owner@salon.mn') === 1 && reminders('founder@example.com') === 1, 'on the 3rd both clients get the reminder');

  // --- the test client pays; QPay calls back ------------------------------------------------
  const testId = psql('select id from billing_invoices where is_test');
  await openPage(testId); // the client opens the link to pay: a code alive now
  const testQ = codeOf(testId);
  qpayInvoices.get(testQ)?.payments.push({ id: 'PAY-1', amount: 100, at: at('2026-10-04') });
  e0 = emails.length; t0 = telegrams.length;
  const cb = await runInvoiceCallback(deps(at('2026-10-04'), modeOf(testId)), testId);
  check(cb.ok && psql(`select status from billing_invoices where id = '${testId}'`) === 'paid', 'the callback records the payment: paid');
  check(since(emails, e0).some((m) => m.subject.startsWith('Төлбөр хүлээн авлаа')), 'the client receives the receipt');
  check(since(telegrams, t0).some((m) => m.text.startsWith('✅ Туршилтын харилцагч paid')), 'the founder is told it was paid');
  e0 = emails.length;
  await runInvoiceCallback(deps(new Date(at('2026-10-04').getTime() + 60_000), modeOf(testId)), testId);
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

  // --- the 13th: the pause question (contract 4.9: more than 7 days late); nothing pauses by itself --------------------------------
  t0 = telegrams.length;
  await tick(at('2026-10-12'), 'live');
  check(!since(telegrams, t0).some((m) => m.text.startsWith('⏸')), 'on the 12th (7 days late) nothing is asked yet');
  t0 = telegrams.length;
  await tick(at('2026-10-13'), 'live');
  const ask = since(telegrams, t0).find((m) => m.text.startsWith('⏸ Салон ХХК has not paid'));
  check(ask?.button !== undefined && /8 day\(s\) late/u.test(ask.text), 'on the 13th the founder is asked, with a button');
  check(psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow', '…and nothing is paused by the question itself');
  const token = new URL(ask?.button?.url ?? 'https://x').searchParams.get('t') ?? '';
  const notices: string[] = [];
  const get = await runActionJob({ db: () => db, now: at('2026-10-13'), method: 'GET', token, kind: 'pause', notify: async (t) => { notices.push(t); } });
  check(get.status === 200 && psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow', 'opening the link (GET) only asks to confirm');
  const post = await runActionJob({ db: () => db, now: at('2026-10-13'), method: 'POST', token, kind: 'pause', notify: async (t) => { notices.push(t); } });
  check(post.status === 200 && psql(`select delivery_mode || '/' || comment_delivery_mode from tenant_channels where id = '${CH}'`) === 'off/off', 'confirming (POST) pauses every channel');
  const badKind = await runActionJob({ db: () => db, now: at('2026-10-13'), method: 'POST', token, kind: 'resume', notify: async () => undefined });
  check(badKind.status === 404, 'a pause link cannot resume');

  // --- the pause notice (2026-10-02): the client is told once, with the pay link ---------------
  e0 = emails.length;
  await tick(at('2026-10-13', 12), 'live');
  const notice = since(emails, e0).filter((m) => m.to === 'owner@salon.mn' && m.subject.startsWith('Үйлчилгээ түр зогслоо'));
  check(notice.length === 1 && notice[0]!.text.includes(`${ORIGIN}/pay/`) && notice[0]!.text.includes('360,000₮'),
    'the paused client is e-mailed once, with the amount and the pay link');
  e0 = emails.length;
  await tick(at('2026-10-13', 13), 'live');
  check(since(emails, e0).every((m) => !m.subject.startsWith('Үйлчилгээ түр зогслоо')), '…and only once');

  // --- a wrong amount: mismatch, never a receipt --------------------------------------------
  const liveId = psql('select id from billing_invoices where not is_test');
  await openPage(liveId);
  const liveQ = codeOf(liveId);
  qpayInvoices.get(liveQ)?.payments.push({ id: 'PAY-2', amount: 300000, at: at('2026-10-14') });
  e0 = emails.length; t0 = telegrams.length;
  await runInvoiceCallback(deps(at('2026-10-14'), modeOf(liveId)), liveId);
  check(psql(`select status from billing_invoices where id = '${liveId}'`) === 'mismatch', '300,000₮ against 360,000₮ is a mismatch');
  check(since(emails, e0).length === 0, 'no receipt for a wrong amount');
  check(since(telegrams, t0).some((m) => /payments total 300,000₮ against 360,000₮ \(short by 60,000₮\)/u.test(m.text)), 'the founder is told the exact difference');

  // --- the rest arrives: paid, receipt, resumed automatically -------------------------------
  const links0 = linksFor(ORIGIN, LINK_SECRET);
  // A part-paid invoice is with the founder (the page offers no new code), so the rest comes
  // as a bank transfer the founder records (contract 4.5).
  const rest = await db.rpc('billing_record_payment', {
    p_invoice: liveId, p_payment_key: 'bank:REST-1', p_source: 'bank', p_amount: 60000, p_paid_at: at('2026-10-15').toISOString(),
    p_qpay_invoice_id: null, p_recorded_by: 'operator:Bilguun', p_note: null,
  });
  check(rest.error === null, 'the rest is recorded as a bank transfer');
  e0 = emails.length; t0 = telegrams.length;
  await tick(at('2026-10-15'), 'live');
  check(psql(`select status from billing_invoices where id = '${liveId}'`) === 'paid', 'the rest arrives: the payments sum to exactly 360,000₮, paid');
  check(since(emails, e0).some((m) => m.to === 'owner@salon.mn' && m.subject.startsWith('Төлбөр хүлээн авлаа')), 'the receipt goes');
  // Paid in full while paused for this invoice: resumed AUTOMATICALLY, once (founder, 2026-10-02).
  check(psql(`select delivery_mode || '/' || comment_delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow/shadow',
    'payment of the overdue invoice resumes the client automatically, to the exact prior modes');
  check(psql(`select resumed_by from billing_pauses where account_id = (select account_id from billing_invoices where id = '${liveId}')`).startsWith('auto:'),
    '…recorded as an automatic resume');
  const resumedMsgs = since(telegrams, t0).filter((m) => /Салон ХХК resumed after payment/u.test(m.text));
  check(resumedMsgs.length === 1 && /1 channel\(s\) restored\./u.test(resumedMsgs[0]!.text), 'the founder is told «resumed after payment», once');
  const paidMsg = since(telegrams, t0).find((m) => m.text.startsWith('✅ Салон ХХК paid'));
  check(paidMsg !== undefined && paidMsg.button === undefined && /resumed automatically/u.test(paidMsg.text),
    'the paid message offers no Resume button: there is nothing left to resume');
  t0 = telegrams.length;
  await tick(at('2026-10-15', 11), 'live');
  await runInvoiceCallback(deps(at('2026-10-15', 11), modeOf(liveId)), liveId);
  check(since(telegrams, t0).every((m) => !/resumed after payment/u.test(m.text))
    && count(`select count(*) from billing_events where kind = 'client.resumed' and account_id = (select account_id from billing_invoices where id = '${liveId}')`) === 1,
    '…exactly once: a later run or a late QPay callback resumes nothing and says nothing');
  // The founder's own Resume stays for exceptions; here there is nothing to resume.
  const manualToken = new URL(links0.action('resume', psql(`select account_id from billing_invoices where id = '${liveId}'`), liveId, at('2026-10-15'))).searchParams.get('t') ?? '';
  const resumed = await runActionJob({ db: () => db, now: at('2026-10-15'), method: 'POST', token: manualToken, kind: 'resume', notify: async (t) => { notices.push(t); } });
  check(resumed.status === 200 && resumed.html.includes('not paused') && psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow',
    'the manual Resume still works and, with nothing paused, changes nothing');
  const oldPause = await runActionJob({ db: () => db, now: at('2026-10-16'), method: 'GET', token, kind: 'pause', notify: async () => undefined });
  check(oldPause.html.includes('is PAID now'), 'the old pause link, opened after payment, says the invoice is paid');
  const oldPost = await runActionJob({ db: () => db, now: at('2026-10-16'), method: 'POST', token, kind: 'pause', notify: async () => undefined });
  check(oldPost.status === 409 && psql(`select delivery_mode from tenant_channels where id = '${CH}'`) === 'shadow', '…and pausing with it is refused: a paid client is never paused');

  // --- the pay page ---------------------------------------------------------------------
  const links = linksFor(ORIGIN, LINK_SECRET);
  // 0070: the short address a client is given, `DT-202610-0001-K7QM2X`.
  const shortRef = (id: string): string => links.pay(id, psql(`select invoice_no from billing_invoices where id = '${id}'`)).split('/pay/')[1] ?? '';
  const paidPage = await runPayPageJob({ db: () => db, now: at('2026-10-15'), token: signLink(LINK_SECRET, { k: 'pay', id: liveId, exp: 0 }) });
  // The signed wording is in the database from 0066 on (the unsigned 503 is a unit test).
  check(paidPage.status === 200 && paidPage.html.includes('Төлөгдсөн — 2026.10.15') && paidPage.html.includes('Салон ХХК')
    && !paidPage.html.includes('data:image') && !paidPage.html.includes('TEST —'), 'the live pay page, in the signed Mongolian: paid on 2026.10.15, no QR');
  const testPage = await runPayPageJob({ db: () => db, now: at('2026-10-15'), token: signLink(LINK_SECRET, { k: 'pay', id: testId, exp: 0 }) });
  check(testPage.status === 200 && testPage.html.includes('Төлөгдсөн') && !testPage.html.includes('TEST —') && !testPage.html.includes('data:image'),
    'the test pay page reads the same signed wording, paid, with no QR');
  const forged = await runPayPageJob({ db: () => db, now: at('2026-10-15'), token: 'x.y' });
  check(forged.status === 404, 'a forged link is a 404');

  // --- 0068: a client who opens the link late can always pay ----------------------------------
  const lateQr = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'late-qr', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-19', p_by: 'Bilguun',
  });
  const lqId = String((lateQr.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  await tick(new Date(), 'live');
  check(lateQr.error === null && codes(lqId) === 0, 'an issued invoice holds no QPay code until someone opens it');
  const c0 = qpayCreates;
  const p1 = await openPage(lqId);
  const q1 = codeOf(lqId);
  check(p1.kind === 'code' && qpayCreates === c0 + 1 && codes(lqId) === 1
    && Math.abs((p1.code.expiresAt.getTime() - p1.now.getTime()) / 1000 - 290) < 5, 'opening the page makes a code that counts down from 4:50 (QPay\'s five minutes, less a margin)');
  const p2 = await openPage(lqId);
  check(p2.kind === 'code' && p2.code.qpayInvoiceId === q1 && qpayCreates === c0 + 1, 'a reload shows the same code while it has minutes left');
  const p3 = await openPage(lqId, true);
  check(p3.kind === 'code' && p3.code.qpayInvoiceId === q1 && qpayCreates === c0 + 1, 'the new-code button pressed at once shows the code just made (no double)');
  const later = new Date(Date.now() + 4 * 60_000 + 55_000);
  const p4 = await openPage(lqId, false, later);
  const q2 = codeOf(lqId);
  check(p4.kind === 'code' && q2 !== q1 && codes(lqId) === 2 && qpayCreates === c0 + 2, 'five minutes later the code has expired: opening the link makes a new one');
  check(qpayCancelled.includes(q1) === false, '…and nothing is withdrawn by a visit (only the button withdraws)');
  const p5 = await openPage(lqId, true, new Date(later.getTime() + 5_000));
  const q3 = codeOf(lqId);
  check(p5.kind === 'code' && q3 !== q2 && qpayCancelled.includes(q2), '«Шинэ QR код авах» while that one is still live: a new code, and the one before withdrawn at QPay');
  // The client paid the OLDER code in their bank app before it was withdrawn: it still counts.
  qpayInvoices.get(q2)?.payments.push({ id: 'PAY-OLD-CODE', amount: 100, at: new Date() });
  e0 = emails.length; t0 = telegrams.length;
  await runInvoiceCallback(deps(new Date(later.getTime() + 35_000), modeOf(lqId)), lqId);
  check(psql(`select status || '/' || paid_sum_mnt from billing_invoices where id = '${lqId}'`) === 'paid/100'
    && count(`select count(*) from billing_payments where invoice_id = '${lqId}'`) === 1, 'a payment on an older code is recorded once: paid');
  check(since(emails, e0).some((m) => m.subject.startsWith('Төлбөр хүлээн авлаа')), '…and the receipt goes');
  const c1 = qpayCreates;
  const p6 = await openPage(lqId, true, new Date(later.getTime() + 45_000));
  check(p6.kind === 'settled' && p6.invoice.status === 'paid' && qpayCreates === c1, 'once paid, the page (even the button) shows paid and makes no code');
  await tick(new Date(later.getTime() + 70_000), 'live');
  check(count(`select count(*) from billing_payments where invoice_id = '${lqId}'`) === 1, 'the hourly check asks every code again and still counts it once');
  const lqPage = await runPayPageJob({ db: () => db, now: new Date(), token: shortRef(lqId) });
  check(lqPage.status === 200 && lqPage.html.includes('Төлөгдсөн') && !lqPage.html.includes('data:image'), 'the page served to the client says paid, with no QR');

  // --- 0068: two visits at once (a click and a link preview) withdraw nothing -----------------
  const twin = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'twin-visits', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-19', p_by: 'Bilguun',
  });
  const twinId = String((twin.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  const cancelledBefore = qpayCancelled.length;
  const [v1, v2] = await Promise.all([openPage(twinId), openPage(twinId)]);
  check(v1.kind === 'code' && v2.kind === 'code' && qpayCancelled.length === cancelledBefore,
    'two visits at the same moment each get a live code, and neither withdraws the other\'s');
  // A payment still in flight on a code: the code stays watched past its settling time.
  const pendQ = v1.kind === 'code' ? v1.code.qpayInvoiceId : '';
  qpayPending.add(pendQ);
  await runInvoiceCallback(deps(new Date(Date.now() + 2 * 3_600_000), modeOf(twinId)), twinId);
  check(psql(`select (closed_at is null)::text from billing_qpay_codes where qpay_invoice_id = '${pendQ}'`) === 'true',
    'a code whose answer shows a payment still in flight is not closed, even hours after it expired');
  qpayPending.delete(pendQ);
  qpayInvoices.get(pendQ)?.payments.push({ id: 'PAY-SETTLED-LATE', amount: 100, at: new Date() });
  await runInvoiceCallback(deps(new Date(Date.now() + 3 * 3_600_000), modeOf(twinId)), twinId);
  check(psql(`select status from billing_invoices where id = '${twinId}'`) === 'paid'
    && psql(`select (closed_at is not null)::text from billing_qpay_codes where qpay_invoice_id = '${pendQ}'`) === 'true',
    '…when it settles it is recorded, and only then is the code closed');

  // --- 0068: a hand entry QPay once named never blocks a later real payment -------------------
  const named = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'hand-named', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-19', p_by: 'Bilguun',
  });
  const namedId = String((named.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  await openPage(namedId);
  const nA = codeOf(namedId);
  // The client pressed «Шинэ QR код авах» (code B), but had already paid code A in their bank app.
  await openPage(namedId, true, new Date(Date.now() + 60_000));
  const nB = codeOf(namedId);
  await db.rpc('billing_record_payment', {
    p_invoice: namedId, p_payment_key: 'qpay:HAND-A', p_source: 'qpay', p_amount: 100, p_paid_at: new Date().toISOString(),
    p_qpay_invoice_id: nA, p_recorded_by: 'operator:Bilguun', p_note: null,
  });
  qpayInvoices.get(nA)?.payments.push({ id: 'HAND-A', amount: 100, at: new Date() });
  const closesA = new Date(Date.now() + 3_600_000 + 5 * 60_000); // past A's settling time, not yet B's
  await runInvoiceCallback(deps(closesA, modeOf(namedId)), namedId);
  check(psql(`select (closed_at is not null)::text || '/' || array_to_string(reported_keys, ',') from billing_qpay_codes where qpay_invoice_id = '${nA}'`) === 'true/qpay:HAND-A'
    && psql(`select (closed_at is null)::text from billing_qpay_codes where qpay_invoice_id = '${nB}'`) === 'true',
    'QPay names the hand-recorded payment on its code; that code closes, keeping what QPay named');
  // …and then paid code B too: a real second payment.
  qpayInvoices.get(nB)?.payments.push({ id: 'SECOND-B', amount: 100, at: new Date() });
  t0 = telegrams.length;
  await runInvoiceCallback(deps(new Date(closesA.getTime() + 30_000), modeOf(namedId)), namedId);
  check(psql(`select status || '/' || paid_sum_mnt from billing_invoices where id = '${namedId}'`) === 'mismatch/200'
    && !since(telegrams, t0).some((m) => /recorded by hand/u.test(m.text)),
    'a second payment on the other code is recorded (paid twice, for the founder), not held back by the closed code\'s hand entry');

  // --- 0068: a live invoice gets no code while the code lines are unsigned ----------------
  const liveOpen = await db.rpc('billing_issue_one_off', {
    p_account: live.accountId, p_key: 'live-unsigned-lines', p_lines: [{ label: 'Туршилт', amount_mnt: 1000 }], p_amount: 1000,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-19', p_by: 'Bilguun',
  });
  const liveOpenId = String((liveOpen.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  const envBefore = { ...process.env };
  Object.assign(process.env, {
    BILLING_MODE: 'live', DALA_PUBLIC_URL: ORIGIN, QPAY_USERNAME: 'x', QPAY_PASSWORD: 'x', QPAY_TERMINAL_ID: 'x',
    QPAY_MERCHANT_ID: 'x', QPAY_BANK_CODE: 'x', QPAY_BANK_ACCOUNT: 'x', QPAY_ACCOUNT_NAME: 'x',
  });
  const creates2 = qpayCreates;
  const unsignedPage = await runPayPageJob({ db: () => db, now: new Date(), token: shortRef(liveOpenId) });
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
  check(unsignedPage.status === 503 && codes(liveOpenId) === 0 && qpayCreates === creates2,
    'a live invoice\'s page is unavailable, and makes no QPay code, until the code lines are signed');
  await db.rpc('billing_resolve', { p_invoice: liveOpenId, p_outcome: 'void', p_by: 'Bilguun', p_note: 'e2e: withdrawn' });

  // --- 0068: however the link is opened, at most CODES_PER_HOUR codes an hour ---------------
  const capped = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'cap-test', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-19', p_by: 'Bilguun',
  });
  const capId = String((capped.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  let last = await openPage(capId);
  for (let i = 1; i <= CODES_PER_HOUR; i += 1) last = await openPage(capId, true, new Date(Date.now() + 30_000 + i * 10_000));
  check(codes(capId) === CODES_PER_HOUR && last.kind === 'no_code', `a link opened again and again makes at most ${CODES_PER_HOUR} codes an hour, then offers the button only`);
  await tick(new Date(), 'live'); // its invoice e-mail goes out here, not in the next section's count

  // --- a failed e-mail is retried; an unfinished one is reported, never resent ---------------
  const oneOff = await db.rpc('billing_issue_one_off', {
    p_account: live.accountId, p_key: 'setup-2026-10', p_lines: [{ label: 'Дали — суурилуулалт', amount_mnt: 50000 }], p_amount: 50000,
    p_issued_on: '2026-10-15', p_due_on: '2026-10-20', p_by: 'Bilguun',
  });
  check(oneOff.error === null, 'a one-off setup fee is issued by the founder');
  emailScript.push({ match: (m) => m.text.includes('50,000₮'), outcome: 'retry' });
  e0 = emails.length;
  await tick(new Date(), 'live');
  check(since(emails, e0).every((m) => m.attachment !== undefined) && psql(`select status from billing_deliveries where dedup_key like 'invoice:%' and status not in ('sent', 'cancelled')`) === 'failed', 'a refused send is recorded as failed, to retry');
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
    p_issued_on: '2026-09-15', p_due_on: '2026-09-18', p_by: 'Bilguun',
  });
  check(late.error === null, 'a late test invoice (due a week ago) is issued');
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  await openPage(psql(`select id from billing_invoices where period_key = 'one_off:late-test'`));
  const lateQ = codeOf(psql(`select id from billing_invoices where period_key = 'one_off:late-test'`));
  check(since(telegrams, t0).some((m) => m.text.startsWith('⏸ Туршилтын харилцагч has not paid')), 'an invoice already late is asked about at once, without the reminders it missed');
  qpayUndetermined = new Set([lateQ]);
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(count(`select count(*) from billing_payments p join billing_invoices i on i.id = p.invoice_id where i.period_key = 'one_off:late-test'`) === 0, 'an unreadable QPay answer records nothing');
  check(since(telegrams, t0).some((m) => /could not be read completely/u.test(m.text)), '…and the founder is told');
  qpayUndetermined = new Set();

  // --- a payment settled by hand is never counted again under QPay's id -----------------------
  const hand = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'hand-test', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-18', p_by: 'Bilguun',
  });
  check(hand.error === null, 'a test invoice to settle by hand is issued');
  await tick(new Date(), 'live');
  const handId = psql(`select id from billing_invoices where period_key = 'one_off:hand-test'`);
  await openPage(handId);
  const handQ = codeOf(handId);
  const typed = await db.rpc('billing_record_payment', {
    p_invoice: handId, p_payment_key: 'qpay:TYPED-FROM-APP', p_source: 'qpay', p_amount: 100, p_paid_at: '2026-09-20T04:00:00Z',
    p_qpay_invoice_id: handQ, p_recorded_by: 'operator:Bilguun', p_note: null,
  });
  check(typed.error === null, 'the founder records a QPay payment by hand');
  qpayInvoices.get(handQ)?.payments.push({ id: 'PAY-API-ID', amount: 100, at: new Date('2026-09-20T04:00:00Z') });
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(psql(`select count(*) || '/' || sum(amount_mnt) from billing_payments where invoice_id = '${handId}'`) === '1/100'
    && psql(`select status from billing_invoices where id = '${handId}'`) === 'paid',
    'QPay then reporting it under another id records nothing: still one payment, paid');
  check(since(telegrams, t0).some((m) => /was recorded by hand/u.test(m.text)), '…and the founder is asked whether it is the same payment');

  const same = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'hand-same', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-09-15', p_due_on: '2026-09-18', p_by: 'Bilguun',
  });
  check(same.error === null, 'another test invoice to settle by hand is issued');
  await tick(new Date(), 'live');
  const sameId = psql(`select id from billing_invoices where period_key = 'one_off:hand-same'`);
  await openPage(sameId);
  const sameQ = codeOf(sameId);
  await db.rpc('billing_record_payment', {
    p_invoice: sameId, p_payment_key: 'qpay:PAY-SAME', p_source: 'qpay', p_amount: 100, p_paid_at: '2026-09-20T04:00:00Z',
    p_qpay_invoice_id: sameQ, p_recorded_by: 'operator:Bilguun', p_note: null,
  });
  qpayInvoices.get(sameQ)?.payments.push({ id: 'PAY-SAME', amount: 100, at: new Date('2026-09-20T04:00:00Z') });
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(psql(`select count(*) || '/' || sum(amount_mnt) from billing_payments where invoice_id = '${sameId}'`) === '1/100'
    && !since(telegrams, t0).some((m) => /was recorded by hand/u.test(m.text)),
    'typed under QPay\'s own id, QPay reporting it is the same payment: nothing new, nothing asked');

  // --- money on a withdrawn invoice still reaches the founder ------------------------------
  const lateId = psql(`select id from billing_invoices where period_key = 'one_off:late-test'`);
  await db.rpc('billing_resolve', { p_invoice: lateId, p_outcome: 'void', p_by: 'Bilguun', p_note: 'e2e: withdrawn' });
  qpayInvoices.get(lateQ)?.payments.push({ id: 'PAY-VOID', amount: 100, at: new Date() });
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  check(psql(`select status || '/' || paid_sum_mnt from billing_invoices where id = '${lateId}'`) === 'void/100'
    && since(telegrams, t0).some((m) => /100₮ is recorded on .* which you WITHDREW\. QPay reported 100₮ paid: that money reached the merchant/u.test(m.text)),
    'a QPay payment on a withdrawn invoice is recorded and the founder told the money reached the merchant');
  // A hand-typed entry on a withdrawn invoice is not said to have reached the merchant.
  const handVoid = await db.rpc('billing_issue_one_off', {
    p_account: live.accountId, p_key: 'hand-void', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-10-15', p_due_on: '2026-10-20', p_by: 'Bilguun',
  });
  const handVoidId = String((handVoid.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  await db.rpc('billing_record_payment', { p_invoice: handVoidId, p_payment_key: 'bank:HV-1', p_source: 'bank', p_amount: 50,
    p_paid_at: new Date().toISOString(), p_qpay_invoice_id: null, p_recorded_by: 'operator:Bilguun', p_note: 'e2e' });
  await db.rpc('billing_resolve', { p_invoice: handVoidId, p_outcome: 'void', p_by: 'Bilguun', p_note: 'e2e: withdrawn' });
  t0 = telegrams.length;
  await tick(new Date(), 'live');
  const hv = since(telegrams, t0).find((m) => m.text.includes('which you WITHDREW') && m.text.includes('50₮'));
  check(hv !== undefined && /RECORDED BY HAND/u.test(hv.text) && !/reached the merchant/u.test(hv.text),
    'a hand-recorded payment on a withdrawn invoice is said to be recorded by hand, never that it reached the merchant');

  // --- a hand entry and the automatic check at the same moment: the database decides -------
  // The code guards read first and write second; here both reads see nothing, and only the
  // lock in billing_record_payment keeps the same money from being counted twice.
  const raceInvoice = async (key: string): Promise<{ id: string; q: string }> => {
    const r = await db.rpc('billing_issue_one_off', {
      p_account: test.accountId, p_key: key, p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
      p_issued_on: '2026-09-15', p_due_on: '2026-09-18', p_by: 'Bilguun',
    });
    if (r.error !== null) throw new Error(r.error.message);
    await tick(new Date(), 'live');
    const id = psql(`select id from billing_invoices where period_key = 'one_off:${key}'`);
    await openPage(id);
    return { id, q: codeOf(id) };
  };
  const payRows = (id: string): string => psql(`select count(*) || '/' || coalesce(sum(amount_mnt), 0) from billing_payments where invoice_id = '${id}'`);
  // 1. The founder's entry is in flight (its transaction holds the invoice) while the real
  //    automatic check runs: the check's own read sees nothing, its write waits, then refuses.
  const r1 = await raceInvoice('race-hand-first');
  qpayInvoices.get(r1.q)?.payments.push({ id: 'RACE-API-1', amount: 100, at: new Date() });
  const handTx = psqlAsync(`begin; select billing_record_payment('${r1.id}', 'qpay:RACE-TYPED-1', 'qpay', 100, now(), '${r1.q}', 'operator:Bilguun', null); select pg_sleep(1.5); commit;`);
  await pause(400);
  t0 = telegrams.length;
  const cbRace = await runInvoiceCallback(deps(new Date(Date.now() + 60_000), modeOf(r1.id)), r1.id);
  const handDone = await handTx;
  check(handDone.code === 0 && cbRace.ok && payRows(r1.id) === '1/100',
    'hand entry in flight + automatic check at the same moment: one payment, not two');
  check(since(telegrams, t0).some((m) => /may be the same money/u.test(m.text)), '…the check is refused by the database and the founder is told');
  // 2. The reverse: the automatic record is in flight when the founder's entry arrives.
  const r2 = await raceInvoice('race-auto-first');
  const autoTx = psqlAsync(`begin; select billing_record_payment('${r2.id}', 'qpay:RACE-API-2', 'qpay', 100, now(), '${r2.q}', 'check', null); select pg_sleep(1.5); commit;`);
  await pause(400);
  const typed2 = await db.rpc('billing_record_payment', {
    p_invoice: r2.id, p_payment_key: 'qpay:RACE-TYPED-2', p_source: 'qpay', p_amount: 100, p_paid_at: new Date().toISOString(),
    p_qpay_invoice_id: r2.q, p_recorded_by: 'operator:Bilguun', p_note: null,
  });
  const autoDone = await autoTx;
  check(autoDone.code === 0 && typed2.error !== null && /may be the same money/u.test(typed2.error.message) && payRows(r2.id) === '1/100',
    'automatic record in flight + hand entry at the same moment: the hand entry is refused, one payment');
  // …unless the founder says it is a second payment.
  const second = await db.rpc('billing_record_payment', {
    p_invoice: r2.id, p_payment_key: 'qpay:RACE-TYPED-2', p_source: 'qpay', p_amount: 100, p_paid_at: new Date().toISOString(),
    p_qpay_invoice_id: r2.q, p_recorded_by: 'operator:Bilguun', p_note: null, p_second_payment: true,
  });
  check(second.error === null && payRows(r2.id) === '2/200' && psql(`select status from billing_invoices where id = '${r2.id}'`) === 'mismatch',
    '…a declared second payment is recorded, and the invoice shows paid twice');
  // 3. Ten invoices, both writes fired together through PostgREST, no ordering: one each.
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => raceInvoice(`race-burst-${i}`)));
  await Promise.all(burst.flatMap((r, i) => [
    db.rpc('billing_record_payment', { p_invoice: r.id, p_payment_key: `qpay:BURST-TYPED-${i}`, p_source: 'qpay', p_amount: 100,
      p_paid_at: new Date().toISOString(), p_qpay_invoice_id: r.q, p_recorded_by: 'operator:Bilguun', p_note: null }),
    db.rpc('billing_record_payment', { p_invoice: r.id, p_payment_key: `qpay:BURST-API-${i}`, p_source: 'qpay', p_amount: 100,
      p_paid_at: new Date().toISOString(), p_qpay_invoice_id: r.q, p_recorded_by: 'check', p_note: null }),
  ]));
  check(burst.every((r) => payRows(r.id) === '1/100'), '20 simultaneous writes on 10 invoices: exactly one payment each');

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
  const mails1 = emails.length;
  const spent = await runBillingTick({ ...deps(at('2026-11-01', 2), 'live'), deadline: 1 });
  check(late2.error === null && spent.ok && qpayCreates === creates1 && spent.report.sent === 0
    && spent.report.problems.some((p) => p.startsWith('time budget reached')), 'a run past its time budget starts no QPay call and no send');
  await tick(at('2026-11-01', 3), 'live');
  check(emails.length > mails1 && qpayCreates === creates1, '…and the next run sends it (a run never makes a QPay code)');

  // --- 0070: the branded e-mail, the PDF, the short address; a test account is never live --
  const issuer = { name: 'Б. Билгүүн', phone: '9911 2233', email: 'founder@example.com', bankAccount: '5000123456', bankHolder: 'Б. Билгүүн' };
  const brandedDeps = (now: Date, mode: 'test' | 'live'): BillingDeps => ({
    ...deps(now, mode), issuer: { ok: true, issuer }, logoUrl: `${ORIGIN}/brand/dalatech-wordmark.png`,
  });
  const branded = await db.rpc('billing_issue_one_off', {
    p_account: live.accountId, p_key: 'branded-2026-11', p_lines: [{ label: 'Дали — AI хүлээн авагч', amount_mnt: 250000 }], p_amount: 250000,
    p_issued_on: '2026-11-02', p_due_on: '2026-11-06', p_by: 'Bilguun',
  });
  const brandedId = String((branded.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  const brandedNo = psql(`select invoice_no from billing_invoices where id = '${brandedId}'`);
  e0 = emails.length;
  const bt = await runBillingTick(brandedDeps(at('2026-11-02', 1), 'live'));
  const bm = since(emails, e0).find((m) => m.attachment?.name === `DalaTech-${brandedNo}.pdf`);
  const ref = shortRef(brandedId);
  check(bt.ok && bm !== undefined && bm.attachment?.encoding === 'base64'
    && Buffer.from(bm.attachment.content, 'base64').subarray(0, 5).toString('latin1') === '%PDF-'
    && psql(`select attachment_encoding || '/' || (html_body is not null) from billing_deliveries where dedup_key = 'invoice:${brandedId}'`) === 'base64/true',
    'the branded invoice e-mail carries the PDF invoice (base64 in the outbox, bytes at the provider)');
  check(bm !== undefined && typeof bm.html === 'string' && bm.html.includes('Төлбөр төлөх') && bm.html.includes(`/pay/${ref}`)
    && bm.text.includes(`/pay/${ref}`) && bm.text.includes('5000123456') && !/unsubscribe/iu.test(`${bm.html}${bm.text}`)
    && !bm.text.includes('eyJ'),
    'its button and plain text carry the short address (no signed token anywhere), the Khan Bank account, and no unsubscribe link');
  Object.assign(process.env, {
    BILLING_MODE: 'live', DALA_PUBLIC_URL: ORIGIN, QPAY_USERNAME: 'x', QPAY_PASSWORD: 'x', QPAY_TERMINAL_ID: 'x',
    QPAY_MERCHANT_ID: 'x', QPAY_BANK_CODE: 'x', QPAY_BANK_ACCOUNT: 'x', QPAY_ACCOUNT_NAME: 'x',
  });
  // The page's own status poll: resolves the address without asking QPay (none is reachable here).
  const refPage = await runPayPageJob({ db: () => db, now: new Date(), token: ref.toLowerCase(), stateOnly: true });
  const wrongRef = await runPayPageJob({ db: () => db, now: new Date(), token: `${brandedNo}-ZZZZZZ` });
  const nextNo = `${brandedNo.slice(0, -4)}${String(Number(brandedNo.slice(-4)) + 1).padStart(4, '0')}`;
  const guessed = await runPayPageJob({ db: () => db, now: new Date(), token: `${nextNo}-${ref.slice(-6)}` });
  check(refPage.status === 200 && refPage.html === '{"status":"open"}' && wrongRef.status === 404 && guessed.status === 404,
    'the short address opens the page (any case); a wrong code, or another invoice number with this code, is a plain 404');
  const testOne = await db.rpc('billing_issue_one_off', {
    p_account: test.accountId, p_key: 'never-live', p_lines: [{ label: 'Туршилт', amount_mnt: 100 }], p_amount: 100,
    p_issued_on: '2026-11-02', p_due_on: '2026-11-06', p_by: 'Bilguun',
  });
  const testOneId = String((testOne.data as Record<string, unknown> | null)?.['invoice_id'] ?? '');
  const testLivePage = await runPayPageJob({ db: () => db, now: new Date(), token: shortRef(testOneId) });
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
  const liveOnly = await runBillingTick(brandedDeps(at('2026-11-02', 2), 'live'));
  check(liveOnly.ok && count(`select count(*) from billing_deliveries where invoice_id = '${testOneId}'`) === 0 && testLivePage.status === 404,
    'with billing live, a TEST account\'s invoice is neither sent nor served');
  await runBillingTick(brandedDeps(at('2026-11-02', 3), 'test'));
  check(count(`select count(*) from billing_deliveries where invoice_id = '${testOneId}' and kind = 'invoice' and status = 'sent'`) === 1,
    '…and a test run sends it, branded, as before');

  // --- 0081: Ора's packs — pay, one signed event, credited once ---------------------------
  {
  // Ора's receiver is a fake that applies the rules of Ора's own `ora.billing_apply` (ora
  // repo, db/migrations/0009): the signature over the raw body, `ts` within 15 minutes, an
  // event `id` counted once, an order credited once at its own amount.
  const ORA_SECRET = 'e2e-ora-platform-secret-long-enough-0000';
  const ORA_EVENTS_SECRET = 'e2e-ora-events-secret-long-enough-00000';
  const oraEnvBefore = { ...process.env };
  Object.assign(process.env, {
    BILLING_MODE: 'test', ORA_PLATFORM_SECRET: ORA_SECRET, DALA_PUBLIC_URL: ORIGIN, BILLING_LINK_SECRET: LINK_SECRET,
  });
  delete process.env['BILLING_PAY_ORIGIN'];
  const oraAcc = psql(`insert into billing_accounts (display_name, email, is_test, ora_account) values ('Ора туршилт', 'owner@ora.test', true, true) returning id`);
  const seenIds = new Set<string>();
  const credited = new Map<string, number>();
  const received: Array<{ body: string; sig: string }> = [];
  let oraAnswer: 'ok' | 503 | 422 = 'ok';
  const oraServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const sig = String(req.headers['x-ora-signature'] ?? '');
      const reply = (status: number, body: Record<string, unknown>) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (oraAnswer !== 'ok') return reply(oraAnswer, { error: oraAnswer === 422 ? 'rejected' : 'server_error' });
      received.push({ body: raw, sig });
      if (!oraSignatureValid(ORA_EVENTS_SECRET, raw, sig)) return reply(401, { error: 'bad_signature' });
      const e = JSON.parse(raw) as Record<string, unknown>;
      if (Math.abs(Date.now() - Date.parse(String(e['ts']))) > 15 * 60_000 || e['test'] !== true) return reply(401, { error: 'bad_signature' });
      if (seenIds.has(String(e['id']))) return reply(200, { ok: true, duplicate: true });
      if (e['type'] !== 'pack.paid' || e['amount_mnt'] !== 100 || e['account'] !== oraAcc) return reply(422, { error: 'rejected' });
      seenIds.add(String(e['id']));
      const order = String(e['order']);
      const already = credited.has(order);
      credited.set(order, (credited.get(order) ?? 0) + (already ? 0 : 1));
      return reply(200, { ok: true, outcome: already ? 'already_paid' : 'credited' });
    });
  });
  await new Promise<void>((resolve) => oraServer.listen(0, '127.0.0.1', resolve));
  const oraAddr = oraServer.address();
  const oraUrl = `http://127.0.0.1:${typeof oraAddr === 'object' && oraAddr !== null ? oraAddr.port : 0}/api/billing/webhook`;
  const oraDeps = (): BillingDeps => ({
    ...deps(new Date(), 'test'),
    sendOraEvent: (ev) => deliverOraEvent({ url: oraUrl, secret: ORA_EVENTS_SECRET }, ev, new Date()),
  });
  const packRequest = async (over: Record<string, unknown> = {}, secret = ORA_SECRET, at = new Date()) => {
    const body = JSON.stringify({ v: 1, ts: at.toISOString(), account: oraAcc, order: `ord_${'0'.repeat(31)}1`, amount_mnt: 100, label: 'Ора — туршилтын багц (100₮)', test: true, ...over });
    return runOraPackInvoiceJob({ db: () => db, now: new Date(), rawBody: body, signature: signOra(secret, body) });
  };
  const order = (n: number) => `ord_${String(n).padStart(32, '0')}`;
  const packId = (n: number) => psql(`select id from billing_invoices where period_key = 'one_off:ora-pack-${String(n).padStart(32, '0')}'`);
  const events = (invoiceId: string, status = 'sent') => count(`select count(*) from billing_deliveries where invoice_id = '${invoiceId}' and kind = 'ora_pack_paid' and status = '${status}'`);
  const pay = async (n: number, amount: number, id: string) => {
    const page = await payPageState(oraDeps(), packId(n), false);
    if (page.kind !== 'code') throw new Error(`no code for pack ${n}: ${page.kind}`);
    qpayInvoices.get(codeOf(packId(n)))?.payments.push({ id, amount, at: new Date() });
  };

  const invoices0 = count('select count(*) from billing_invoices');
  const p1 = await packRequest({ order: order(1) });
  const p1again = await packRequest({ order: order(1) });
  check(p1.status === 200 && /^TEST-\d{6}-\d{4}$/u.test(String(p1.body['invoice_no'])) && String(p1.body['pay_url']).startsWith(`${ORIGIN}/pay/${String(p1.body['invoice_no'])}-`)
    && p1again.status === 200 && p1again.body['invoice_no'] === p1.body['invoice_no'] && count('select count(*) from billing_invoices') === invoices0 + 1,
    'Ора asks for a pack invoice: one 100₮ TEST invoice and its pay address; asking again for the same order answers the same invoice');
  check(psql(`select amount_mnt || '|' || (lines->0->>'label') || '|' || due_on::text from billing_invoices where id = '${packId(1)}'`) === `100|Ора — туршилтын багц (100₮)|${psql(`select issued_on::text from billing_invoices where id = '${packId(1)}'`)}`,
    '…at the amount and with the line fixed here, due the day it is asked');
  const forged = await packRequest({ order: order(9) }, 'x'.repeat(40));
  const stale = await packRequest({ order: order(9) }, ORA_SECRET, new Date(Date.now() - 6 * 60_000));
  const big = await packRequest({ order: order(9), amount_mnt: 49000 });
  const notOra = await packRequest({ order: order(9), account: test.accountId });
  const liveAsk = await packRequest({ order: order(9), test: false, amount_mnt: 49000 });
  check(forged.status === 401 && stale.status === 401 && big.status === 422 && big.body['reason'] === 'wrong_amount'
    && notOra.body['reason'] === 'not_an_ora_account' && liveAsk.body['reason'] === 'wrong_mode'
    && count('select count(*) from billing_invoices') === invoices0 + 1,
    'a forged or stale request, 49,000₮ on a test account, an account not marked as Ора\'s and a live request are all refused; no invoice');

  await runBillingTick(oraDeps());
  check(count(`select count(*) from billing_deliveries where invoice_id = '${packId(1)}'`) === 0,
    'an unpaid pack is not e-mailed, copied to the founder, reminded or paused over');

  // QPay notifies twice, at once: the payment is recorded once and Ора receives one event.
  await pay(1, 100, 'ORA-PAY-1');
  const tg0 = telegrams.length; const em0 = emails.length;
  await Promise.all([runInvoiceCallback(oraDeps(), packId(1)), runInvoiceCallback(oraDeps(), packId(1))]);
  check(psql(`select status from billing_invoices where id = '${packId(1)}'`) === 'paid' && events(packId(1)) === 1
    && received.length === 1 && credited.get(order(1)) === 1,
    'paid, with QPay calling back twice at once: one signed pack.paid reaches Ора and the pack is credited once');
  const ev = JSON.parse(received[0]!.body) as Record<string, unknown>;
  check(ev['type'] === 'pack.paid' && ev['order'] === order(1) && ev['amount_mnt'] === 100 && ev['test'] === true && ev['account'] === oraAcc
    && ev['invoice'] === p1.body['invoice_no'] && ev['id'] === `pack.paid:${packId(1)}`
    && psql(`select provider_message_id from billing_deliveries where invoice_id = '${packId(1)}' and kind = 'ora_pack_paid'`) === 'ora:credited',
    '…naming the order, 100₮, test, the account and the invoice; Ора\'s answer (credited) is kept');
  check(since(emails, em0).filter((m) => m.to === 'owner@ora.test' && m.subject.length > 0).length === 1
    && since(telegrams, tg0).filter((m) => m.text.startsWith('✅ Ора туршилт paid')).length === 1,
    '…the owner gets the receipt and the founder the ✅, once each');
  await runBillingTick(oraDeps());
  await runInvoiceCallback({ ...oraDeps(), now: new Date(Date.now() + 60_000) }, packId(1));
  check(received.length === 1 && events(packId(1)) === 1, 'later runs and callbacks send nothing more');
  // The same event delivered again, and a forged one, at Ора's door.
  const replay = await fetch(oraUrl, { method: 'POST', headers: { 'x-ora-signature': received[0]!.sig }, body: received[0]!.body });
  const forgedBody = received[0]!.body.replace(order(1), order(2));
  const forgedEv = await fetch(oraUrl, { method: 'POST', headers: { 'x-ora-signature': received[0]!.sig }, body: forgedBody });
  check(replay.status === 200 && (await replay.json() as Record<string, unknown>)['duplicate'] === true && forgedEv.status === 401
    && credited.get(order(1)) === 1 && !credited.has(order(2)),
    'the same event again is a duplicate and a forged one is refused: still one pack');
    const rcv = received.length; // the two above were posted by this test, not the engine

  // A wrong amount, or no payment at all, never sends anything.
  await packRequest({ order: order(2) });
  await pay(2, 50, 'ORA-PAY-SHORT');
  await runInvoiceCallback(oraDeps(), packId(2));
  await packRequest({ order: order(3) });
  await payPageState(oraDeps(), packId(3), false);
  await runBillingTick(oraDeps());
  check(psql(`select status from billing_invoices where id = '${packId(2)}'`) === 'mismatch'
    && count(`select count(*) from billing_deliveries where kind = 'ora_pack_paid' and invoice_id in ('${packId(2)}', '${packId(3)}')`) === 0
    && received.length === rcv && !credited.has(order(2)) && !credited.has(order(3)),
    'a short payment (mismatch, the founder told) and an abandoned or cancelled payment send Ора nothing');
    const resolved = await db.rpc('billing_resolve', { p_invoice: packId(2), p_outcome: 'paid', p_by: 'Bilguun', p_note: 'e2e: short pack accepted' });
    const tgR = telegrams.length;
    await runBillingTick(oraDeps());
    check(resolved.error === null && psql(`select status from billing_invoices where id = '${packId(2)}'`) === 'paid'
      && count(`select count(*) from billing_deliveries where kind = 'ora_pack_paid' and invoice_id = '${packId(2)}'`) === 0 && !credited.has(order(2))
      && since(telegrams, tgR).some((m) => /is an Ора pack marked paid with 50₮ of 100₮: Ора was NOT told/u.test(m.text)),
      '…and settled by the founder as paid with 50₮, still no pack: the founder is told to refund or settle it in Ора');

  // Ора down: retried with the same id, a fresh signature, until it answers.
  await packRequest({ order: order(4) });
  await pay(4, 100, 'ORA-PAY-4');
  oraAnswer = 503;
  await runInvoiceCallback(oraDeps(), packId(4));
  check(events(packId(4), 'failed') === 1 && credited.get(order(4)) === undefined, 'Ора answering 503: the event waits to be retried');
  oraAnswer = 'ok';
  psql(`update billing_deliveries set next_attempt_at = now() where invoice_id = '${packId(4)}' and kind = 'ora_pack_paid'`);
  await runBillingTick(oraDeps());
  check(events(packId(4)) === 1 && credited.get(order(4)) === 1, '…and the hourly run delivers it: credited once');

  // A payment QPay never called back about (late, or the callback lost): the hourly run finds it.
  await packRequest({ order: order(5) });
  await pay(5, 100, 'ORA-PAY-5');
  await runBillingTick(oraDeps());
  check(events(packId(5)) === 1 && credited.get(order(5)) === 1, 'a payment found by the hourly run, with no callback, is credited once');

  // Ора refusing (422): stopped, the founder told why; never resent by itself.
  await packRequest({ order: order(6) });
  await pay(6, 100, 'ORA-PAY-6');
  oraAnswer = 422;
  const tg1 = telegrams.length;
  await runInvoiceCallback(oraDeps(), packId(6));
  await runBillingTick(oraDeps());
  oraAnswer = 'ok';
  check(events(packId(6), 'failed') === 1 && psql(`select next_attempt_at = 'infinity' from billing_deliveries where invoice_id = '${packId(6)}' and kind = 'ora_pack_paid'`) === 't'
    && since(telegrams, tg1).some((m) => /ora_pack_paid to ora failed for good \(Ора answered HTTP 422 \(rejected\)\)/u.test(m.text)),
    'Ора refusing an event (422) stops it and the founder is told why');
  check(count(`select count(*) from billing_deliveries where kind = 'ora_pack_paid' and not is_test`) === 0
    && count(`select count(*) from billing_invoices where period_key like 'one_off:ora-pack-%' and not is_test`) === 0,
    'nothing about Ора touched a live account');
  oraServer.close();
  for (const k of Object.keys(process.env)) if (!(k in oraEnvBefore)) delete process.env[k];
  Object.assign(process.env, oraEnvBefore);
  }

  process.stdout.write(`\nbilling e2e: ${checks} checks passed\n`);
  proxy.close();
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
