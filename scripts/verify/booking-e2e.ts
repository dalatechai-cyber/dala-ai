/**
 * In-chat booking end to end, over a REAL PostgREST and PostgreSQL with every migration
 * applied. The QPay Quick QR client and the Google Calendar client are the production ones,
 * talking to faithful fakes of the two services' wire (`src/lib/booking/testkit.ts`);
 * Messenger and Telegram are recorders. Everything else — supabase-js, PostgREST, 0082's
 * plpgsql, the turn engine, the settlement, the pay page, the callback and the sweep — is the
 * production code path.
 *
 *     PGRST_URL=http://127.0.0.1:3001 PGRST_JWT_SECRET=… node scripts/verify/booking-e2e.ts <database> [--transcript <file>]
 *
 * What it proves (each a numbered scenario below): a booking is confirmed once, after QPay
 * says paid, however many callbacks and polls arrive; an unpaid hold is released and the
 * customer told once; a late payment books if the time is free and pages the founder if not;
 * a second payment never makes a second booking and pages the founder; two chats racing for
 * one time, and the website racing a chat, end with one booking; a QPay answer that cannot be
 * read records nothing and pages; test mode is testers only, 100₮, «ТЕСТ»; a customer who
 * changes the subject is let go; nothing at all happens with BOOKING_MODE unset.
 * Spends nothing; reaches no network but localhost.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js'; // guard-ok: scripts/, not src/
import { quickQr } from '../../src/lib/billing/qpay.ts';
import { claim, markSent } from '../../src/lib/outbound/claim.ts';
import { usdToNano } from '../../src/lib/money.ts';
import { localDayStart, tenantClock } from '../../src/lib/time/clock.ts';
import { googleCalendar, eventIdForHold } from '../../src/lib/booking/calendar.ts';
import type { BookingAlert, BookingPorts, BookingDeliverArgs } from '../../src/lib/booking/engine.ts';
import { runPayPage, runQpayCallback, runSweep } from '../../src/lib/booking/jobs.ts';
import { signHold } from '../../src/lib/booking/links.ts';
import { dayLabel } from '../../src/lib/booking/engine.ts';
import { bookingTurn, type TurnResult } from '../../src/lib/booking/turn.ts';
import { draftWording, FakeGoogle, FakeQpay, TEST_CALENDARS, testConfig } from '../../src/lib/booking/testkit.ts';
import { say } from '../../src/lib/booking/wording.ts';
import type { QuickReply } from '../../src/lib/meta/send.ts';

const DB = process.argv[2] ?? 'dala_e2e';
const transcriptAt = process.argv.indexOf('--transcript');
const TRANSCRIPT = transcriptAt === -1 ? null : process.argv[transcriptAt + 1] ?? null;
const URL_ = process.env['PGRST_URL'] ?? 'http://127.0.0.1:3001';
const JWT_SECRET = process.env['PGRST_JWT_SECRET'] ?? 'dala-ci-postgrest-secret-at-least-32-chars';
const SECRET = 'booking-e2e-link-secret-that-is-long-enough';
const ORIGIN = 'https://dala.example.com';
const TZ = 'Asia/Ulaanbaatar';
process.env['BOOKING_MODE'] = 'live';

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
const section = (s: string) => process.stdout.write(`\n${s}\n`);

/**
 * `outbound/claim.ts` PATCHes with `state=in.(draft,failed)` AND `or=(lease_until.is.null,
 * lease_until.lt.<now>)`, `select=id,body,attempts`. Supabase's hosted PostgREST answers it 200
 * with the row (edge log, 2026-10-02T19:35:44Z: every reply this platform sends goes through
 * it). Every upstream PostgREST release tried locally (11.2.2, 12.0.3, 12.2.3, 12.2.12, 13.0.7,
 * 14.1) re-applies the `or` in its outer query over the RETURNING columns and fails with 42703.
 * So, for this harness only, the lease `or` is dropped from a PATCH on `outbound_messages`. The
 * compare-and-set that stops a second send is the `state=in.(draft,failed)` filter, which stays:
 * a message being sent is `sending` and is not claimed again. Only a stale lease on a `failed`
 * row is not exercised here (the reception tests stub it).
 */
export function claimShim(method: string | undefined, rawUrl: string): string {
  if (method !== 'PATCH' || !rawUrl.startsWith('/outbound_messages?')) return rawUrl;
  const u = new URL(rawUrl, 'http://x');
  if (!(u.searchParams.get('or') ?? '').startsWith('(lease_until.')) return rawUrl;
  u.searchParams.delete('or');
  return `${u.pathname}${u.search}`;
}

async function gateway(target: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const rest = claimShim(req.method, (req.url ?? '/').replace(/^\/rest\/v1/u, ''));
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

// --- the world -------------------------------------------------------------------------

const google = new FakeGoogle(Object.values(TEST_CALENDARS));
const qpayFake = new FakeQpay();
const wording = draftWording();
type Sent = { outboundId: string; psid: string; body: string; quickReplies: readonly QuickReply[]; linkButtonTitle?: string };
const sent: Sent[] = [];
const alerts: BookingAlert[] = [];
let clockShift = 0;
const now = () => new Date(Date.now() + clockShift);

const ports: BookingPorts = {
  db,
  now,
  calendar: googleCalendar({ email: google.email, privateKey: google.privateKey }, google.fetch, now),
  qpayFor: (m) => {
    const bank = m.bankAccounts[0];
    return bank === undefined ? null : quickQr({
      username: qpayFake.username, password: qpayFake.password, terminalId: qpayFake.terminal,
      merchantId: m.merchantId, mccCode: m.mccCode, bankCode: bank.bankCode, bankAccount: bank.accountNumber, accountName: bank.accountName,
    }, qpayFake.fetch);
  },
  wording,
  origin: ORIGIN,
  secret: SECRET,
  deliver: async (a: BookingDeliverArgs) => {
    sent.push({ outboundId: a.outboundId, psid: a.recipientId, body: a.body, quickReplies: a.quickReplies ?? [], ...(a.linkButtonTitle === undefined ? {} : { linkButtonTitle: a.linkButtonTitle }) });
    const m = await markSent(db, { id: a.outboundId, tenantId: a.tenantId, providerMessageId: `mid.out.${sent.length}`, unitCost: usdToNano(0), now: new Date() });
    if (!m.ok) throw new Error(`markSent: ${m.detail}`);
    return { outcome: 'sent', providerMessageId: `mid.out.${sent.length}` };
  },
  graphVersionDefault: () => 'v21.0',
  alert: async (a) => { if (!alerts.some((x) => x.dedupKey === a.dedupKey)) alerts.push(a); },
  log: (level, event, fields) => { if (process.env['BOOKING_E2E_LOG'] === '1' || level === 'error') process.stdout.write(`      [${level}] ${event} ${JSON.stringify(fields ?? {})}\n`); },
};

// --- the tenant ------------------------------------------------------------------------

const T = randomUUID();
const CH = randomUUID();
const PAGE = `page-${T.slice(0, 8)}`;
psql(`insert into tenants (id, slug, display_name, vertical, timezone) values ('${T}', 'booking-e2e-${T.slice(0, 8)}', 'Tara Salon — Яармаг', 'salon', '${TZ}')`);
psql(`insert into tenant_channels (id, tenant_id, provider, external_id, auth_flavour, app_slug, status, delivery_mode, token_status, name_confirmed_at)
      values ('${CH}', '${T}', 'facebook_page', '${PAGE}', 'facebook_login', 'dalatech', 'active', 'live', 'active', now())`);
psql(`insert into contact_points (tenant_id, kind, value) values ('${T}', 'address', 'Яармагийн Номин Хайпермаркетын баруун талд')`);
psql(`insert into tenant_booking (tenant_id, mode, booking_url) values ('${T}', 'link', 'https://www.matrixecosalon.org/')`);
const setConfig = (mode: 'off' | 'test' | 'live', overrides: Record<string, unknown> = {}) => psql(
  `insert into booking_config (tenant_id, mode, config) values ('${T}', '${mode}', $json$${JSON.stringify(testConfig(overrides))}$json$::jsonb)
   on conflict (tenant_id) do update set mode = excluded.mode, config = excluded.config`);
setConfig('live');

// 10:00–20:00 every day, so the walk-through does not depend on which weekday it runs
// (Sunday's 11–19 is covered by the unit tests).
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, opens: '10:00:00', closes: '20:00:00', closed: false }));

type Chat = { psid: string; conversationId: string; last: TurnResult | null; lastBody: string | null; transcript: string[] };

function newChat(psid = `psid-${randomUUID().slice(0, 8)}`): Chat {
  const contact = psql(`insert into contacts (tenant_id, channel_id, external_id) values ('${T}', '${CH}', '${psid}') returning id`).split('\n')[0] as string;
  const conv = psql(`insert into conversations (tenant_id, contact_id, channel_id) values ('${T}', '${contact}', '${CH}') returning id`).split('\n')[0] as string;
  return { psid, conversationId: conv, last: null, lastBody: null, transcript: [] };
}

/** One customer message through the hook exactly as the reception worker calls it, then the worker's claim and send. */
async function says(chat: Chat, text: string, payload?: string): Promise<TurnResult> {
  const mid = `mid.${randomUUID()}`;
  const r = await bookingTurn(ports, {
    tenantId: T, channelId: CH, conversationId: chat.conversationId, psid: chat.psid, mid, text,
    ...(payload === undefined ? {} : { quickReplyPayload: payload }), respelled: null, hours: HOURS, closures: [],
  });
  chat.last = r;
  chat.transcript.push(`**Customer:** ${text}${payload === undefined ? '' : ' *(tap)*'}`);
  if (r.handled && r.outboundId !== null) {
    const held = await claim(db, { id: r.outboundId, tenantId: T, now: new Date() });
    if (held.outcome !== 'claimed') throw new Error(`claim: ${held.outcome} ${held.outcome === 'unavailable' ? held.detail : ''}`);
    await ports.deliver({ tenantId: T, channelId: CH, pageId: PAGE, recipientId: chat.psid, outboundId: held.id, body: held.body, attempts: held.attempts,
      graphVersion: 'v21.0', quickReplies: r.quickReplies, ...(r.linkButtonTitle === undefined ? {} : { linkButtonTitle: r.linkButtonTitle }) });
    chat.lastBody = held.body;
    const buttons = r.quickReplies.map((q) => `[${q.title}]`).join(' ');
    chat.transcript.push(`**Дали:** ${held.body.replace(/\n/gu, ' / ')}${r.linkButtonTitle === undefined ? '' : ` [${r.linkButtonTitle} ↗]`}${buttons === '' ? '' : `  ${buttons}`}`);
  } else if (!r.handled) {
    chat.lastBody = null;
    chat.transcript.push(`*(the booking flow steps aside: ${r.reason}; the ordinary Дали answers)*`);
  } else {
    chat.lastBody = null;
  }
  return r;
}

/** Tap the button whose title is `title` on the last reply. */
async function taps(chat: Chat, title: string): Promise<TurnResult> {
  const last = chat.last;
  if (last === null || !last.handled) throw new Error(`no buttons to tap for «${title}»`);
  const q = last.quickReplies.find((x) => x.title === title);
  if (q === undefined) throw new Error(`no «${title}» among ${last.quickReplies.map((x) => x.title).join(', ')}`);
  return says(chat, q.title, q.payload);
}
const titles = (chat: Chat) => (chat.last !== null && chat.last.handled ? chat.last.quickReplies.map((q) => q.title) : []);
/** Messages pushed to a customer outside their own turns (confirmation, release, …). */
const pushedTo = (chat: Chat, since: number) => sent.slice(since).filter((s) => s.psid === chat.psid);
const holdOf = (chat: Chat) => psql(`select h.id from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${chat.conversationId}' order by h.created_at desc limit 1`);
const holdState = (id: string) => psql(`select state from booking_holds where id = '${id}'`);
const invoicesOf = (id: string) => psql(`select qpay_invoice_id from booking_invoices where hold_id = '${id}' and qpay_invoice_id is not null order by created_at`).split('\n').filter((x) => x !== '');
const tomorrow = () => tenantClock(new Date(Date.now() + 24 * 3600_000), TZ).date;
const ubAt = (date: string, hh: number) => new Date(localDayStart(date, TZ).getTime() + hh * 3600_000);
const T_MAR = say(wording, 'booking_day_tomorrow');
const AGREE = say(wording, 'booking_agree');
const CANCEL = say(wording, 'booking_cancel');

/** Walk a chat to the agreement for one stylist and time tomorrow. */
async function toAgreement(chat: Chat, opts: { service?: string; group?: string; stylist: string; time: string; name?: string; phone?: string; gender?: string; day?: string }) {
  await says(chat, 'Цаг авъя');
  await taps(chat, opts.group ?? 'Будаг');
  await taps(chat, opts.service ?? 'Будаг');
  await taps(chat, opts.gender ?? say(wording, 'booking_gender_female'));
  await taps(chat, opts.stylist);
  await taps(chat, opts.day ?? T_MAR);
  await taps(chat, opts.time);
  await says(chat, opts.name ?? 'Болд');
  await says(chat, opts.phone ?? '9911 2233');
}

// =====================================================================================
section('1. Choose → pay → confirmed once');
// =====================================================================================
const a = newChat();
await says(a, 'Цаг авъя');
check(a.last?.handled === true && a.lastBody === say(wording, 'booking_ask_service_group'), 'a booking message starts the flow with the service groups');
check(JSON.stringify(titles(a)) === JSON.stringify(['Засалт', 'Будаг', CANCEL]), 'groups are buttons, with «Цуцлах»');
await taps(a, 'Будаг');
check(JSON.stringify(titles(a)) === JSON.stringify(['Будаг', 'Оффис колор', CANCEL]), 'the group\'s services');
await taps(a, 'Будаг');
check(a.lastBody === say(wording, 'booking_ask_gender') && titles(a).length === 3, 'who it is for (the gender rule): two choices and cancel');
await taps(a, say(wording, 'booking_gender_female'));
check(JSON.stringify(titles(a)) === JSON.stringify(['Мастер (аль нь ч)', 'Оюунаа · Мастер', 'Бадмаа · Мастер', 'Уянга · 1-р зэрэг', CANCEL]),
  'a woman is offered only the women stylists, «any Мастер» first, the man not at all');
await taps(a, 'Оюунаа · Мастер');
check(titles(a).includes(T_MAR), 'the days with a free time include tomorrow');
// The website books Оюунаа 10:00–12:00 tomorrow: those starts must not be offered.
google.websiteBooks(TEST_CALENDARS.master1, ubAt(tomorrow(), 10), 120);
await taps(a, T_MAR);
check(!titles(a).includes('10:00') && !titles(a).includes('11:00') && titles(a).includes('12:00') && titles(a).includes('18:00') && !titles(a).includes('19:00'),
  'times read from the real calendar: the website\'s 10–12 booking is gone, and a 2-hour service is not offered at 19:00');
await taps(a, '14:00');
check(a.lastBody === say(wording, 'booking_ask_name'), 'asks the name');
await says(a, 'Болд');
await says(a, '991122');
check(a.lastBody === say(wording, 'booking_phone_invalid'), 'a phone that is not 8 digits is asked again');
await says(a, '+976 9911 2233');
check(a.lastBody?.includes(testConfig()['agreement_text'] as string) === true && titles(a)[0] === AGREE, 'shows Tara\'s agreement verbatim with «Зөвшөөрч байна»');
const agreedAt = sent.length;
await taps(a, AGREE);
const holdA = holdOf(a);
check(holdState(holdA) === 'held', 'agreeing holds the time');
check(a.last?.handled === true && a.last.linkButtonTitle === say(wording, 'billing_pay_button') && /\/book\/[0-9a-f-]{36}\./u.test(a.lastBody ?? ''),
  'the answer carries the «Төлбөр төлөх» button to the signed deposit page');
check((a.lastBody ?? '').includes('20,000₮') && (a.lastBody ?? '').includes('Оюунаа (Мастер)') && (a.lastBody ?? '').includes('14:00'), 'it names the deposit (Мастер: 20,000₮), stylist and time');
const evA = google.live(TEST_CALENDARS.master1).find((e) => e.id === eventIdForHold(holdA));
check(evA !== undefined && evA.transparency === 'opaque' && evA.summary.startsWith('HOLD'), 'the stylist\'s calendar holds the time (busy: the website stops offering it)');
const invA = invoicesOf(holdA);
const qinvA = qpayFake.invoices.get(invA[0] as string);
check(invA.length === 1 && qinvA?.amount === 20000 && qinvA.mcc === '7230' && qinvA.merchantId === '00000000-0000-4000-8000-00000000c0de'
  && qinvA.description === 'Болд - 99112233' && qinvA.callbackUrl.startsWith(`${ORIGIN}/api/booking/qpay?t=`), 'one QPay invoice: the tenant\'s merchant, mcc 7230, 20,000₮, «Name - Phone», signed callback');
check(psql(`select count(*) from booking_holds where state in ('booked') and id = '${holdA}'`) === '0', 'nothing is booked before payment');
const page = await runPayPage(ports, { token: signHold(SECRET, 'pay', holdA), method: 'GET', stateOnly: false });
check(page.status === 200 && page.html.includes('khanbank://q?qPay_QRcode=') && page.html.includes('QR код 4:') && page.html.includes('20,000₮'),
  'the deposit page shows the QR, one-tap bank buttons and the 5-minute countdown');
const forged = await runPayPage(ports, { token: `${holdA}.${'0'.repeat(32)}`, method: 'GET', stateOnly: false });
check(forged.status === 404, 'a forged page link opens nothing');
const early = await runQpayCallback(ports, signHold(SECRET, 'callback', holdA));
check(early.status === 200 && early.body['settled'] === 'unpaid' && holdState(holdA) === 'held', 'a callback before payment changes nothing (QPay is asked, the body never read)');
qpayFake.pay(invA[0] as string);
const before = sent.length;
const [c1, c2, poll] = await Promise.all([
  runQpayCallback(ports, signHold(SECRET, 'callback', holdA)),
  runQpayCallback(ports, signHold(SECRET, 'callback', holdA)),
  runPayPage(ports, { token: signHold(SECRET, 'pay', holdA), method: 'GET', stateOnly: true }),
]);
check(c1.status === 200 && c2.status === 200 && poll.status === 200, 'two callbacks and a page poll at once all answer');
check(holdState(holdA) === 'booked', 'QPay said paid: booked');
check(psql(`select count(*) from booking_payments where hold_id = '${holdA}'`) === '1', 'the payment is recorded once');
const confirmations = pushedTo(a, before).filter((s) => s.body.includes(say(wording, 'booking_confirmed', { service: 'x', stylist: 'x', date: 'x', time: 'x', branch: 'x', address: 'x' }).split('\n')[0] as string));
check(confirmations.length === 1, 'the customer is told once');
const conf = confirmations[0]?.body ?? '';
check(conf.includes('Будаг') && conf.includes('Оюунаа (Мастер)') && conf.includes('14:00') && conf.includes('Яармаг салбар') && conf.includes('Номин Хайпермаркет'),
  'the confirmation names service, stylist, day, time, branch and address');
const liveA = google.live(TEST_CALENDARS.master1).filter((e) => e.start.getTime() === ubAt(tomorrow(), 14).getTime());
check(liveA.length === 1 && liveA[0]?.summary === '99112233 - Будаг' && liveA[0]?.description.includes('QPay invoice: ') && liveA[0]?.description.includes('Agreed: «'),
  'one event in the calendar, in the website\'s format («phone - service», agreement and invoice recorded)');
for (let i = 0; i < 3; i += 1) await runQpayCallback(ports, signHold(SECRET, 'callback', holdA));
await runSweep(ports);
check(pushedTo(a, agreedAt).filter((s) => s.body === conf).length === 1 && psql(`select count(*) from booking_payments where hold_id = '${holdA}'`) === '1',
  'three more callbacks and a sweep: still one booking, one payment, one confirmation');
check(psql(`select count(*) from booking_sessions where conversation_id = '${a.conversationId}' and closed_at is null`) === '0', 'the booking chat is closed');
const paidPage = await runPayPage(ports, { token: signHold(SECRET, 'pay', holdA), method: 'GET', stateOnly: false });
check(paidPage.html.includes(say(wording, 'booking_page_paid')), 'the page now says paid');

// =====================================================================================
section('2. Unpaid → released, customer told once');
// =====================================================================================
const b = newChat();
await toAgreement(b, { stylist: 'Бадмаа · Мастер', time: '15:00', name: 'Сараа', phone: '88112233' });
await taps(b, AGREE);
const holdB = holdOf(b);
const invB = invoicesOf(holdB);
check(holdState(holdB) === 'held' && invB.length === 1, 'held, invoice made');
let swept = await runSweep(ports);
check(holdState(holdB) === 'held', 'the sweep leaves a hold whose time is not up');
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdB}'`);
const beforeB = sent.length;
swept = await runSweep(ports);
check(holdState(holdB) === 'expired' && swept.body['expired'] === 1, 'past its time and unpaid: released');
check(qpayFake.invoices.get(invB[0] as string)?.status === 'CANCELLED', 'its QPay invoice is cancelled, so it can no longer be paid');
check(google.live(TEST_CALENDARS.master2).every((e) => e.id !== eventIdForHold(holdB)), 'the calendar hold is removed: the time is free again');
const expiredLines = pushedTo(b, beforeB);
check(expiredLines.length === 1 && expiredLines[0]?.body.includes('15:00') === true && expiredLines[0]?.body.startsWith('Уучлаарай'), 'the customer is told, politely, once');
await runSweep(ports);
check(pushedTo(b, beforeB).length === 1, 'a second sweep tells nobody again');
const endedPage = await runPayPage(ports, { token: signHold(SECRET, 'pay', holdB), method: 'GET', stateOnly: false });
check(endedPage.html.includes(say(wording, 'booking_page_ended')), 'the page says the time has ended');

// =====================================================================================
section('3. Late payment: the time is still free → booked, founder told');
// =====================================================================================
qpayFake.pay(invB[0] as string, { force: true }); // QPay took the money just before the cancel landed
const beforeL = sent.length;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdB));
check(holdState(holdB) === 'booked', 'the late payment re-takes the free time and books it');
check(psql(`select disposition from booking_payments where hold_id = '${holdB}'`) === 'late_booked', 'recorded as late_booked');
check(pushedTo(b, beforeL).length === 1 && pushedTo(b, beforeL)[0]?.body.includes('15:00') === true, 'the customer gets the confirmation');
check(alerts.some((x) => x.kind === 'booking.late_booked' && x.body.includes('88112233')), 'the founder is told it was late (with the phone)');
check(google.live(TEST_CALENDARS.master2).filter((e) => e.start.getTime() === ubAt(tomorrow(), 15).getTime()).length === 1, 'one event at 15:00');

// =====================================================================================
section('4. Late payment: the time was taken → no booking, founder paged, money visible');
// =====================================================================================
const c = newChat();
await toAgreement(c, { stylist: 'Уянга · 1-р зэрэг', time: '11:00', name: 'Туяа', phone: '95112233' });
await taps(c, AGREE);
const holdC = holdOf(c);
check(c.lastBody?.includes('10,000₮') === true, '1-р зэрэг: the deposit is 10,000₮ (Tara\'s rule)');
const invC = invoicesOf(holdC);
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdC}'`);
await runSweep(ports);
check(holdState(holdC) === 'expired', 'released');
google.websiteBooks(TEST_CALENDARS.first1, ubAt(tomorrow(), 11), 60);
const d = newChat();
qpayFake.pay(invC[0] as string, { force: true });
const beforeC = sent.length;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdC));
// The DB had no other hold, so the payment re-took it in the database, then the calendar showed the website's booking.
check(holdState(holdC) === 'paid_unbooked', 'paid, the time is gone: paid_unbooked');
check(alerts.some((x) => x.kind === 'booking.paid_unbooked' && x.body.includes('95112233') && x.body.includes('10,000₮') && /refund/u.test(x.body)),
  'the founder is paged at once with name, phone and amount, to refund or rebook');
check(pushedTo(c, beforeC).some((s) => s.body === say(wording, 'booking_paid_unbooked')), 'the customer is told a person will call');
check(google.live(TEST_CALENDARS.first1).filter((e) => e.start.getTime() === ubAt(tomorrow(), 11).getTime()).length === 1, 'still one event at 11:00 (the website\'s)');
void d;

// =====================================================================================
section('5. Paid twice → one booking, the second payment paged for a refund');
// =====================================================================================
const e = newChat();
await toAgreement(e, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Оюунаа · Мастер', time: '16:00', name: 'Ану', phone: '99001122' });
await taps(e, AGREE);
const holdE = holdOf(e);
// The first QR runs out; the customer asks for a new one, and pays both.
psql(`update booking_invoices set qr_expires_at = now() - interval '1 second' where hold_id = '${holdE}'`);
const renewed = await runPayPage(ports, { token: signHold(SECRET, 'pay', holdE), method: 'POST', stateOnly: false });
check(renewed.redirect === true, '«Шинэ QR код авах» makes a new code');
const invE = invoicesOf(holdE);
check(invE.length === 2, 'two invoices for one hold');
qpayFake.pay(invE[0] as string, { force: true });
qpayFake.pay(invE[1] as string);
const beforeE = sent.length;
await Promise.all([runQpayCallback(ports, signHold(SECRET, 'callback', holdE)), runQpayCallback(ports, signHold(SECRET, 'callback', holdE))]);
check(holdState(holdE) === 'booked', 'booked');
check(psql(`select string_agg(disposition, ',' order by disposition) from booking_payments where hold_id = '${holdE}'`) === 'applied,excess', 'one payment applied, one excess');
check(google.live(TEST_CALENDARS.master1).filter((x) => x.start.getTime() === ubAt(tomorrow(), 16).getTime()).length === 1, 'one event, not two');
check(alerts.filter((x) => x.kind === 'booking.excess_payment' && x.body.includes('99001122')).length === 1, 'the extra payment is paged once, for a refund');
check(pushedTo(e, beforeE).filter((s) => s.body === say(wording, 'booking_excess')).length === 1
  && pushedTo(e, beforeE).filter((s) => s.body.includes('16:00')).length === 1, 'the customer gets one confirmation and one line about the double payment');

// A payment twice on ONE invoice (two taps in the bank app) is the same.
const e2 = newChat();
await toAgreement(e2, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '17:00', name: 'Ану', phone: '99001123' });
await taps(e2, AGREE);
const holdE2 = holdOf(e2);
const invE2 = invoicesOf(holdE2);
qpayFake.pay(invE2[0] as string);
qpayFake.payAgain(invE2[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdE2));
check(holdState(holdE2) === 'booked' && psql(`select string_agg(disposition, ',' order by disposition) from booking_payments where hold_id = '${holdE2}'`) === 'applied,excess',
  'two payments on one invoice: one booking, one excess');

// =====================================================================================
section('6. Two customers race for one time → only one wins');
// =====================================================================================
const r1 = newChat();
const r2 = newChat();
await toAgreement(r1, { stylist: 'Уянга · 1-р зэрэг', time: '13:00', name: 'Нэг', phone: '91000001' });
await toAgreement(r2, { stylist: 'Уянга · 1-р зэрэг', time: '13:00', name: 'Хоёр', phone: '91000002' });
await Promise.all([taps(r1, AGREE), taps(r2, AGREE)]);
const held13 = psql(`select count(*) from booking_holds where calendar_id = '${TEST_CALENDARS.first1}' and starts_at = '${ubAt(tomorrow(), 13).toISOString()}' and state = 'held'`);
check(held13 === '1', 'exactly one hold on that time');
const winners = [r1, r2].filter((x) => x.last?.handled === true && x.last.linkButtonTitle !== undefined);
const losers = [r1, r2].filter((x) => x.last?.handled === true && x.last.linkButtonTitle === undefined);
check(winners.length === 1 && losers.length === 1, 'one customer gets the pay button, the other does not');
check(losers[0]?.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true && !titles(losers[0] as Chat).includes('13:00') && !titles(losers[0] as Chat).includes('14:00') && titles(losers[0] as Chat).includes('15:00'),
  'the other is told the time was taken and offered only times a 2-hour service still fits (15:00 on)');
check(google.live(TEST_CALENDARS.first1).filter((x) => x.start.getTime() === ubAt(tomorrow(), 13).getTime()).length === 1, 'one hold event in the calendar');
check(psql(`select count(*) from booking_invoices i join booking_holds h on h.id = i.hold_id where h.starts_at = '${ubAt(tomorrow(), 13).toISOString()}' and h.calendar_id = '${TEST_CALENDARS.first1}'`) === '1',
  'one invoice: the loser was never asked to pay');

// The database alone, ten at once.
const sessions = [] as string[];
for (let i = 0; i < 10; i += 1) {
  const ch = newChat();
  sessions.push(psql(`insert into booking_sessions (tenant_id, conversation_id, channel_id, psid, is_test, step) values ('${T}', '${ch.conversationId}', '${CH}', '${ch.psid}', false, 'agree') returning id`).split('\n')[0] as string);
}
const s18 = ubAt(tomorrow(), 18);
const results = await Promise.all(sessions.map((sid) => db.rpc('booking_acquire_hold', {
  p_tenant: T, p_session: sid, p_expires_at: new Date(Date.now() + 600_000).toISOString(),
  p_hold: { calendar_id: TEST_CALENDARS.male1, staff_name: 'Ананд', level: 'Мастер', service: 'Будаг', minutes: 120,
    starts_at: s18.toISOString(), ends_at: new Date(s18.getTime() + 7_200_000).toISOString(), deposit_mnt: 20000,
    customer_name: 'X', customer_phone: '90000000', gender: 'male', agreed_at: new Date().toISOString(), agreement_text: 'a' },
})));
const outcomes = results.map((r) => (r.error ? `error:${r.error.code ?? ''}` : String((r.data as Record<string, unknown>)['outcome'])));
check(outcomes.filter((o) => o === 'held').length === 1 && outcomes.filter((o) => o === 'taken').length === 9, `ten concurrent holds on one time: one held, nine taken (${outcomes.join(',')})`);
// Overlap, not only the same start: 19:00 inside 18:00–20:00.
const overlap = await db.rpc('booking_acquire_hold', {
  p_tenant: T, p_session: psql(`insert into booking_sessions (tenant_id, conversation_id, channel_id, psid, is_test, step) values ('${T}', '${newChat().conversationId}', '${CH}', 'p', false, 'agree') returning id`).split('\n')[0],
  p_expires_at: new Date(Date.now() + 600_000).toISOString(),
  p_hold: { calendar_id: TEST_CALENDARS.male1, staff_name: 'Ананд', level: 'Мастер', service: 'Энгийн засалт', minutes: 60,
    starts_at: ubAt(tomorrow(), 19).toISOString(), ends_at: ubAt(tomorrow(), 20).toISOString(), deposit_mnt: 20000,
    customer_name: 'Y', customer_phone: '90000001', gender: 'male', agreed_at: new Date().toISOString(), agreement_text: 'a' },
});
check(!overlap.error && (overlap.data as Record<string, unknown>)['outcome'] === 'taken', 'an overlapping time (19:00 inside 18:00–20:00) is taken too');

// =====================================================================================
section('7. The website and the chat race → only one wins');
// =====================================================================================
// (a) The website books between the offer and the agreement: the chat sees it and does not hold.
const w1 = newChat();
await toAgreement(w1, { stylist: 'Бадмаа · Мастер', time: '12:00', name: 'Вэб', phone: '92000001' });
google.websiteBooks(TEST_CALENDARS.master2, ubAt(tomorrow(), 12), 60);
await taps(w1, AGREE);
check(w1.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true && psql(`select count(*) from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${w1.conversationId}'`) === '0',
  'the website booked first: the chat holds nothing and offers other times');
// (b) The website writes in the instant between the chat's hold event and its second look.
const w2 = newChat();
await toAgreement(w2, { stylist: 'Бадмаа · Мастер', time: '13:00', name: 'Вэб2', phone: '92000002' });
google.afterInsert = (calId, ev) => {
  if (calId === TEST_CALENDARS.master2 && ev.start.getTime() === ubAt(tomorrow(), 13).getTime()) google.websiteBooks(calId, ubAt(tomorrow(), 13), 60);
};
await taps(w2, AGREE);
google.afterInsert = null;
const holdW2 = psql(`select h.id from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${w2.conversationId}'`);
check(holdState(holdW2) === 'released' && w2.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true, 'the website wrote in the gap: the chat yields and says so');
check(google.live(TEST_CALENDARS.master2).filter((x) => x.start.getTime() === ubAt(tomorrow(), 13).getTime()).length === 1, 'one event left at 13:00, the website\'s');
check(invoicesOf(holdW2).length === 0, 'no invoice was made for a time the chat did not hold');
// (c) A person writes into a held time by hand; the customer pays anyway → no double booking, founder paged.
const w3 = newChat();
await toAgreement(w3, { stylist: 'Оюунаа · Мастер', time: '17:00', name: 'Вэб3', phone: '92000003' });
await taps(w3, AGREE);
const holdW3 = holdOf(w3);
google.websiteBooks(TEST_CALENDARS.master1, ubAt(tomorrow(), 17), 60);
qpayFake.pay(invoicesOf(holdW3)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdW3));
check(holdState(holdW3) === 'paid_unbooked' && google.live(TEST_CALENDARS.master1).filter((x) => x.start.getTime() === ubAt(tomorrow(), 17).getTime()).length === 1,
  'paid, but the time was written over: not booked twice; the hold event is gone');
check(alerts.some((x) => x.kind === 'booking.paid_unbooked' && x.body.includes('92000003')), 'the founder is paged to refund or rebook');

// =====================================================================================
section('8. «Any Мастер»: the first free one is assigned');
// =====================================================================================
const any = newChat();
google.websiteBooks(TEST_CALENDARS.master1, ubAt(tomorrow(), 19), 60);
await toAgreement(any, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Мастер (аль нь ч)', time: '19:00', name: 'Ням', phone: '93000001' });
await taps(any, AGREE);
const holdAny = holdOf(any);
check(psql(`select calendar_id from booking_holds where id = '${holdAny}'`) === TEST_CALENDARS.master2, 'Оюунаа is busy at 19:00, so Бадмаа takes it');

// =====================================================================================
section('9. A QPay answer that cannot be read records nothing and pages');
// =====================================================================================
const u = newChat();
await toAgreement(u, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Уянга · 1-р зэрэг', time: '16:00', name: 'Уншихгүй', phone: '94000001' });
await taps(u, AGREE);
const holdU = holdOf(u);
qpayFake.unreadable.add(invoicesOf(holdU)[0] as string);
const ur = await runQpayCallback(ports, signHold(SECRET, 'callback', holdU));
check(ur.status === 503 && holdState(holdU) === 'held' && psql(`select count(*) from booking_payments where hold_id = '${holdU}'`) === '0', 'nothing recorded, QPay asked to retry');
check(alerts.some((x) => x.kind === 'booking.payment_unreadable'), 'the founder is paged');
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdU}'`);
await runSweep(ports);
check(holdState(holdU) === 'held', 'an unreadable payment is never released by the timer');
qpayFake.unreadable.clear();
await runSweep(ports);
check(holdState(holdU) === 'expired', 'once QPay answers (unpaid), the sweep releases it');

// =====================================================================================
section('10. The customer cancels, or changes the subject');
// =====================================================================================
const x = newChat();
await toAgreement(x, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Уянга · 1-р зэрэг', time: '17:00', name: 'Болиулах', phone: '96000001' });
await taps(x, AGREE);
const holdX = holdOf(x);
await taps(x, CANCEL);
check(holdState(holdX) === 'released' && x.lastBody === say(wording, 'booking_cancelled'), '«Цуцлах» after the pay button: released, cancelled line');
check(qpayFake.invoices.get(invoicesOf(holdX)[0] as string)?.status === 'CANCELLED' && google.live(TEST_CALENDARS.first1).every((ev) => ev.id !== eventIdForHold(holdX)),
  'its invoice cancelled and its calendar hold removed');
const y = newChat();
await says(y, 'цаг авах');
await taps(y, 'Будаг');
await says(y, 'Хаяг хаана вэ?');
check(y.lastBody === say(wording, 'booking_pick_from_list'), 'something else: asked once to choose');
const left = await says(y, 'Хаяг хаана байдаг вэ?');
check(!left.handled && psql(`select close_reason from booking_sessions where conversation_id = '${y.conversationId}'`) === 'left', 'asked again: the flow steps aside and Дали answers');
const z = newChat();
const notBooking = await says(z, 'Будаг хэд вэ?');
check(!notBooking.handled, 'a price question never enters the flow');

// =====================================================================================
section('11. Test mode: testers only, 100₮, «ТЕСТ»');
// =====================================================================================
setConfig('test');
const stranger = newChat();
check(!(await says(stranger, 'Цаг авъя')).handled, 'in test mode a customer who is not a tester gets the ordinary Дали');
const tester = newChat('psid-tester');
await toAgreement(tester, { stylist: 'Оюунаа · Мастер', time: '12:00', name: 'Тест', phone: '99999999' });
await taps(tester, AGREE);
const holdT = holdOf(tester);
check(tester.lastBody?.startsWith(say(wording, 'booking_test_prefix')) === true && tester.lastBody.includes('100₮'), 'the tester\'s messages are marked ТЕСТ and the deposit is 100₮');
qpayFake.pay(invoicesOf(holdT)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdT));
const testEvent = google.live(TEST_CALENDARS.master1).find((ev) => ev.id === eventIdForHold(holdT));
check(holdState(holdT) === 'booked' && testEvent?.summary === 'ТЕСТ – 99999999 - Будаг', 'booked as «ТЕСТ – …» in the calendar, as the website\'s test bookings');
setConfig('live');

// =====================================================================================
section('12. Off is off');
// =====================================================================================
setConfig('off');
const off = newChat();
check(!(await says(off, 'Цаг авъя')).handled, 'a tenant whose row is off: nothing');
setConfig('live');
process.env['BOOKING_MODE'] = '';
const envOff = newChat();
const writesBefore = psql(`select count(*) from booking_sessions where tenant_id = '${T}'`);
check(!(await says(envOff, 'Цаг авъя')).handled && psql(`select count(*) from booking_sessions where tenant_id = '${T}'`) === writesBefore,
  'BOOKING_MODE unset: nothing handled, nothing written');
process.env['BOOKING_MODE'] = 'live';
psql(`update booking_config set config = config - 'qpay' where tenant_id = '${T}'`);
check(!(await says(newChat(), 'Цаг авъя')).handled, 'a config that does not validate: nothing');
setConfig('live');
check(!(await bookingTurn({ ...ports, wording: { source: 'signed', blocks: new Map() } }, {
  tenantId: T, channelId: CH, conversationId: newChat().conversationId, psid: 'p', mid: 'mid.x', text: 'Цаг авъя', respelled: null, hours: HOURS, closures: [],
})).handled, 'any line unsigned: nothing');

// =====================================================================================
section('14. The review\'s cases: nothing stuck, nobody trapped');
// =====================================================================================
// (a) A settle died right after booking: no confirmation was sent. The customer writes again.
const k1 = newChat();
await toAgreement(k1, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '10:00', name: 'Тасарсан', phone: '97000001' });
await taps(k1, AGREE);
const holdK1 = holdOf(k1);
const invK1 = invoicesOf(holdK1)[0] as string;
const payK1 = qpayFake.pay(invK1);
const invRowK1 = psql(`select id from booking_invoices where qpay_invoice_id = '${invK1}'`);
await db.rpc('booking_record_payment', { p_hold: holdK1, p_invoice: invRowK1, p_payment_key: `qpay:${payK1}`, p_amount: 20000, p_paid_at: new Date().toISOString(), p_qpay_invoice_id: invK1 });
await db.rpc('booking_mark_booked', { p_hold: holdK1, p_event_id: eventIdForHold(holdK1) });
check(holdState(holdK1) === 'booked' && pushedTo(k1, 0).every((m) => !m.body.includes('баталгаажлаа')), 'set-up: booked in the database, never confirmed (the crash)');
const beforeK1 = sent.length;
const k1r = await says(k1, 'Хаяг хаана вэ?');
check(pushedTo(k1, beforeK1).filter((m) => m.body.includes('баталгаажлаа')).length === 1, 'the next message brings the missing confirmation, once');
check(!k1r.handled && psql(`select count(*) from booking_sessions where conversation_id = '${k1.conversationId}' and closed_at is null`) === '0',
  'and the message itself goes to the ordinary Дали; the booking chat is closed');
check(!(await says(k1, 'Баярлалаа')).handled && pushedTo(k1, beforeK1).filter((m) => m.body.includes('баталгаажлаа')).length === 1, 'every later message too, with no second confirmation');

// (b) A question at the name step is asked once, then let go; «Цуцлах» typed cancels.
const k2 = newChat();
await says(k2, 'Цаг авъя');
await taps(k2, 'Засалт');
await taps(k2, 'Энгийн засалт');
await taps(k2, say(wording, 'booking_gender_female'));
await taps(k2, 'Уянга · 1-р зэрэг');
await taps(k2, T_MAR);
await taps(k2, '12:00');
await says(k2, 'Урьдчилгаа хэд вэ?');
check(k2.lastBody === say(wording, 'booking_ask_name') && psql(`select data->>'name' from booking_sessions where conversation_id = '${k2.conversationId}'`) === '',
  'a question is not taken as a name; the name is asked once more');
const k2r = await says(k2, 'Урьдчилгаа хэд вэ? хариулаач');
check(!k2r.handled, 'asked again: the flow steps aside and Дали answers');
const k4 = newChat();
await says(k4, 'Цаг авъя');
await taps(k4, 'Засалт');
await taps(k4, 'Энгийн засалт');
await taps(k4, say(wording, 'booking_gender_female'));
await taps(k4, 'Уянга · 1-р зэрэг');
await taps(k4, T_MAR);
await taps(k4, '12:00');
await says(k4, 'Нараа');
await says(k4, 'дугаар өгөхгүй');
check(k4.lastBody === say(wording, 'booking_phone_invalid'), 'a wrong phone is asked again once');
check(!(await says(k4, 'яагаад утас хэрэгтэй вэ')).handled, 'and then let go, never asked for ever');
const k5 = newChat();
await says(k5, 'Цаг авъя');
await taps(k5, 'Засалт');
await taps(k5, 'Энгийн засалт');
await taps(k5, say(wording, 'booking_gender_female'));
await taps(k5, 'Уянга · 1-р зэрэг');
await taps(k5, T_MAR);
await taps(k5, '12:00');
await says(k5, CANCEL);
check(k5.lastBody === say(wording, 'booking_cancelled'), '«Цуцлах» typed at the name step cancels (it is not a name)');

// (c) A short payment never keeps the time held for ever.
const k6 = newChat();
await toAgreement(k6, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Уянга · 1-р зэрэг', time: '19:00', name: 'Дутуу', phone: '97000006' });
await taps(k6, AGREE);
const holdK6 = holdOf(k6);
qpayFake.pay(invoicesOf(holdK6)[0] as string, { amount: 50 });
await runQpayCallback(ports, signHold(SECRET, 'callback', holdK6));
check(holdState(holdK6) === 'held' && alerts.some((x) => x.kind === 'booking.short_payment' && x.body.includes('97000006')), 'a short payment is paged and books nothing');
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdK6}'`);
await runSweep(ports);
check(holdState(holdK6) === 'expired' && google.live(TEST_CALENDARS.first1).every((e) => e.id !== eventIdForHold(holdK6)), 'and the hold is still released when its time is up');

// (d) A time that has started since it was offered is not held.
const k7 = newChat();
await toAgreement(k7, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '11:00', name: 'Хоцорсон', phone: '97000007' });
clockShift = ubAt(tomorrow(), 11).getTime() - Date.now() + 5 * 60_000;
// The customer was typing just before: their session is not idle at the shifted clock.
psql(`update booking_sessions set updated_at = '${new Date(Date.now() + clockShift - 60_000).toISOString()}' where conversation_id = '${k7.conversationId}' and closed_at is null`);
await taps(k7, AGREE);
clockShift = 0;
check(k7.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true
  && psql(`select count(*) from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${k7.conversationId}'`) === '0',
  'agreeing after the start time holds nothing and says the time is gone');

// (e) The first attempt died between the database hold and the calendar: the retry writes it.
const k8 = newChat();
await toAgreement(k8, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '14:00', name: 'Дахин', phone: '97000008' });
const sessK8 = psql(`select id from booking_sessions where conversation_id = '${k8.conversationId}' and closed_at is null`);
const s14 = ubAt(tomorrow(), 14);
await db.rpc('booking_acquire_hold', { p_tenant: T, p_session: sessK8, p_expires_at: new Date(Date.now() + 600_000).toISOString(), p_hold: {
  calendar_id: TEST_CALENDARS.master2, staff_name: 'Бадмаа', level: 'Мастер', service: 'Энгийн засалт', minutes: 60,
  starts_at: s14.toISOString(), ends_at: new Date(s14.getTime() + 3_600_000).toISOString(), deposit_mnt: 20000,
  customer_name: 'Дахин', customer_phone: '97000008', gender: 'female', agreed_at: new Date().toISOString(), agreement_text: 'x' } });
const holdK8 = holdOf(k8);
check(psql(`select calendar_state from booking_holds where id = '${holdK8}'`) === 'none', 'set-up: held in the database, not in the calendar');
await taps(k8, AGREE);
check(google.live(TEST_CALENDARS.master2).some((e) => e.id === eventIdForHold(holdK8) && e.transparency === 'opaque')
  && k8.last?.handled === true && k8.last.linkButtonTitle !== undefined, 'the retry puts the hold in the calendar before asking for money');

// (f) QPay would not cancel an expired hold's invoice: paged, and a payment on it still lands.
const k9 = newChat();
await toAgreement(k9, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '18:00', name: 'Цуцлагдаагүй', phone: '97000009' });
await taps(k9, AGREE);
const holdK9 = holdOf(k9);
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdK9}'`);
qpayFake.failCancel = true;
await runSweep(ports);
qpayFake.failCancel = false;
check(holdState(holdK9) === 'expired' && alerts.some((x) => x.kind === 'booking.invoice_not_cancelled' && x.body.includes('97000009')), 'expired, and the uncancelled QR is paged');
psql(`update booking_holds set ended_at = now() - interval '3 hours' where id = '${holdK9}'`);
qpayFake.pay(invoicesOf(holdK9)[0] as string);
await runSweep(ports);
check(holdState(holdK9) === 'booked', 'a payment hours later on that QR is found by the sweep (no callback needed) and booked');

// (g) The pay page's poll asks QPay at most every 15 s per hold.
const k10 = newChat();
await toAgreement(k10, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '11:00', name: 'Хүлээж', phone: '97000010' });
await taps(k10, AGREE);
const holdK10 = holdOf(k10);
const checksBefore = qpayFake.calls.filter((x) => x.endsWith('/payment/check')).length;
for (let i = 0; i < 5; i += 1) await runPayPage(ports, { token: signHold(SECRET, 'pay', holdK10), method: 'GET', stateOnly: true });
check(qpayFake.calls.filter((x) => x.endsWith('/payment/check')).length - checksBefore === 1, 'five polls in a row: one QPay check');

// (h) Late, the time taken, and the settle died before telling anyone: the sweep tells.
// Tomorrow is full by now: these three use the day after.
const day2 = tenantClock(new Date(Date.now() + 48 * 3600_000), TZ).date;
const D2 = dayLabel(wording, day2, new Date(), TZ);
const k12 = newChat();
await toAgreement(k12, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Бадмаа · Мастер', time: '19:00', name: 'Мартагдсан', phone: '97000012', day: D2 });
await taps(k12, AGREE);
const holdK12 = holdOf(k12);
const invK12 = invoicesOf(holdK12)[0] as string;
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdK12}'`);
qpayFake.failCancel = true;
await runSweep(ports);
qpayFake.failCancel = false;
check(holdState(holdK12) === 'expired', 'set-up: expired (its QR not cancelled)');
google.websiteBooks(TEST_CALENDARS.master2, ubAt(day2, 19), 60);
const payK12 = qpayFake.pay(invK12);
const invRowK12 = psql(`select id from booking_invoices where qpay_invoice_id = '${invK12}'`);
// What a settle that died right after recording would have left: the payment, the invoice paid, nobody told.
const recK12 = await db.rpc('booking_record_payment', { p_hold: holdK12, p_invoice: invRowK12, p_payment_key: `qpay:${payK12}`, p_amount: 20000, p_paid_at: new Date().toISOString(), p_qpay_invoice_id: invK12 });
psql(`update booking_invoices set state = 'paid' where id = '${invRowK12}'`);
// …and the settle saw the website's booking and marked it unbooked, then died before telling.
await db.rpc('booking_mark_unbooked', { p_hold: holdK12, p_reason: 'the time was taken' });
check(!recK12.error && holdState(holdK12) === 'paid_unbooked', 'set-up: the late payment is recorded, the time is gone, nobody told');
const beforeK12 = sent.length;
await runSweep(ports);
await runSweep(ports);
check(alerts.some((x) => x.kind === 'booking.paid_unbooked' && x.body.includes('97000012')), 'the sweep pages the founder');
check(pushedTo(k12, beforeK12).filter((m) => m.body === say(wording, 'booking_paid_unbooked')).length === 1, 'and tells the customer, once');
check(psql(`select notified_at is not null from booking_holds where id = '${holdK12}'`) === 't', 'and marks it told, so it stops');

// (i) Booked, confirmation never sent, the customer never writes again: the sweep confirms.
const k13 = newChat();
await toAgreement(k13, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Уянга · 1-р зэрэг', time: '15:00', name: 'Чимээгүй', phone: '97000013', day: D2 });
await taps(k13, AGREE);
const holdK13 = holdOf(k13);
const invK13 = invoicesOf(holdK13)[0] as string;
const payK13 = qpayFake.pay(invK13);
const invRowK13 = psql(`select id from booking_invoices where qpay_invoice_id = '${invK13}'`);
await db.rpc('booking_record_payment', { p_hold: holdK13, p_invoice: invRowK13, p_payment_key: `qpay:${payK13}`, p_amount: 10000, p_paid_at: new Date().toISOString(), p_qpay_invoice_id: invK13 });
await db.rpc('booking_mark_booked', { p_hold: holdK13, p_event_id: eventIdForHold(holdK13) });
psql(`update booking_invoices set state = 'paid' where id = '${invRowK13}'`);
const beforeK13 = sent.length;
await runSweep(ports);
await runSweep(ports);
check(pushedTo(k13, beforeK13).filter((m) => m.body.includes('баталгаажлаа')).length === 1, 'the sweep sends the missing confirmation, once');

// (j) «Цуцлах» while QPay cannot be read: the time is kept, and Дали answers (no silence).
const k14 = newChat();
await toAgreement(k14, { group: 'Засалт', service: 'Энгийн засалт', stylist: 'Уянга · 1-р зэрэг', time: '17:00', name: 'Тасалдал', phone: '97000014', day: D2 });
await taps(k14, AGREE);
const holdK14 = holdOf(k14);
qpayFake.failChecks = 5;
const k14r = await taps(k14, CANCEL);
qpayFake.failChecks = 0;
check(!k14r.handled && holdState(holdK14) === 'held', 'the hold is kept while QPay is down, and the message goes to Дали');

// =====================================================================================
section('13. Every customer message got at most one reply; nothing was confirmed unpaid');
// =====================================================================================
check(psql(`select count(*) from (select dedup_key from outbound_messages where tenant_id = '${T}' group by dedup_key having count(*) > 1) d`) === '0', 'no reply key twice');
check(psql(`select count(*) from booking_holds where tenant_id = '${T}' and state = 'booked' and not exists (select 1 from booking_payments p where p.hold_id = booking_holds.id and p.disposition in ('applied','late_booked'))`) === '0',
  'every booked hold has a payment that paid it');
check(psql(`select count(*) from (select calendar_id, starts_at from booking_holds where tenant_id = '${T}' and state in ('held','paid','booked') group by 1, 2 having count(*) > 1) d`) === '0',
  'no calendar and start held twice');

if (TRANSCRIPT !== null) {
  const block = (title: string, chat: Chat, extra: string[] = []) => [`## ${title}`, '', ...chat.transcript.map((l) => `- ${l}`), ...extra, ''];
  const pushed = (chat: Chat) => sent.filter((s) => s.psid === chat.psid && !chat.transcript.some((l) => l.includes(s.body.replace(/\n/gu, ' / ')))).map((s) => `- **Дали (by itself, later):** ${s.body.replace(/\n/gu, ' / ')}`);
  const out = [
    '# In-chat booking — what the customer reads (generated)',
    '',
    `Generated by \`scripts/verify/booking-e2e.ts --transcript\` with the DRAFT wording and test data (stylists, calendars and the merchant are test values). Every line here is unsigned. [Buttons] are Messenger quick replies; «… ↗» is the link button.`,
    '',
    ...block('1. Book and pay', a, pushed(a)),
    ...block('2. Not paid in time', b, pushed(b)),
    ...block('4. Paid after the time was taken', c, pushed(c)),
    ...block('5. Paid twice', e, pushed(e)),
    ...block('6. Two customers, one time (the one who lost)', losers[0] as Chat),
    ...block('10. Changing the subject', y),
    ...block('11. Test mode', tester, pushed(tester)),
  ].join('\n');
  writeFileSync(TRANSCRIPT, `${out}\n`);
  process.stdout.write(`\ntranscript written to ${TRANSCRIPT}\n`);
}

proxy.close();
process.stdout.write(`\nbooking e2e: ${checks} checks passed\n`);
