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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js'; // guard-ok: scripts/, not src/
import { claim, markFailed, markSent } from '../../src/lib/outbound/claim.ts';
import { usdToNano } from '../../src/lib/money.ts';
import { localDayStart, tenantClock } from '../../src/lib/time/clock.ts';
import { googleCalendar, eventIdForHold } from '../../src/lib/booking/calendar.ts';
import type { BookingAlert, BookingPorts, BookingDeliverArgs } from '../../src/lib/booking/engine.ts';
import { payPageRoute, runPayPage, runQpayCallback, runSweep } from '../../src/lib/booking/jobs.ts';
import { signHold } from '../../src/lib/booking/links.ts';
import { dayLabel } from '../../src/lib/booking/engine.ts';
import { bookingTurn, type TurnResult } from '../../src/lib/booking/turn.ts';
import { allServices, parseBookingConfig } from '../../src/lib/booking/config.ts';
import { draftWording, FakeGoogle, FakeQpay, ruleBranches, taraConfig, taraRules, TEST_CALENDARS, testConfig, testMerchant } from '../../src/lib/booking/testkit.ts';
import { qpayPortFor } from '../../src/lib/booking/live.ts';
import { BOOKING_BLOCK_KEYS, loadBookingWording, missingBlocks, say } from '../../src/lib/booking/wording.ts';
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
// The platform's partner login, as the deployment's environment holds it; the one merchant both
// branches invoice under is registered under it (as on QPay).
process.env['QPAY_USERNAME'] = qpayFake.username;
process.env['QPAY_PASSWORD'] = qpayFake.password;
process.env['QPAY_TERMINAL_ID'] = qpayFake.terminal;
/** The rules file's branches by place: the first is the main test tenant, the second Парк Од (section 20). */
const [BRANCH_1, BRANCH_2] = ruleBranches() as [string, string];
qpayFake.registerMerchant(qpayFake.username, testMerchant(BRANCH_1).merchant_id);
// The flow's wording, read exactly as production reads it: `loadBookingWording` over PostgREST,
// from the `prompt_blocks` rows the seed migrations wrote (set c787decc1f0a, signed 2026-10-04).
// Before the signing this read had no `booking_*` row and the flow refused to start.
section('0. The signed wording, from the database');
const loaded = await loadBookingWording(db);
check(loaded.ok, `prompt_blocks readable${loaded.ok ? '' : `: ${loaded.detail}`}`);
const wording = loaded.ok ? loaded.wording : draftWording();
check(missingBlocks(wording).length === 0, `every one of the flow's ${BOOKING_BLOCK_KEYS.length} blocks is seeded, signed and carries its placeholders (missing: ${missingBlocks(wording).join(', ') || 'none'})`);
const signedFiles = draftWording();
check(BOOKING_BLOCK_KEYS.every((k) => wording.blocks.get(k) === signedFiles.blocks.get(k)), 'each seeded body is its signed file, byte for byte');
check(psql("select count(*) from prompt_blocks where scope = 'platform' and block_key like 'booking\\_%' and (layer is not null or reviewed_at is null or vertical is not null)") === '0',
  'every booking row is layer null (never a prompt section), signed, for every vertical');
type Sent = { outboundId: string; psid: string; body: string; quickReplies: readonly QuickReply[]; linkButtonTitle?: string };
const sent: Sent[] = [];
const alerts: BookingAlert[] = [];
/** Sweeps asked for at a hold's end (QStash in production). */
const scheduled: { at: Date; key: string }[] = [];
let clockShift = 0;
/** Messenger refuses every send while set. */
let failDeliver = false;
const now = () => new Date(Date.now() + clockShift);
google.now = now;

const ports: BookingPorts = {
  db,
  now,
  calendar: googleCalendar({ email: google.email, privateKey: google.privateKey }, google.fetch, now),
  // The production port (`live.ts`): the merchant and the tenant's own account from its row, on the
  // platform's login read from the environment now. Only the far side of the wire is the fake.
  qpayFor: (m) => qpayPortFor(m, qpayFake.fetch),
  wording,
  origin: ORIGIN,
  secret: SECRET,
  deliver: async (a: BookingDeliverArgs) => {
    if (failDeliver) {
      await markFailed(db, { id: a.outboundId, tenantId: a.tenantId, attempts: a.attempts, reason: 'test: Messenger down' });
      return { outcome: 'failed', failure: 'transport', retryable: true, detail: 'test: Messenger down' } as never;
    }
    sent.push({ outboundId: a.outboundId, psid: a.recipientId, body: a.body, quickReplies: a.quickReplies ?? [], ...(a.linkButtonTitle === undefined ? {} : { linkButtonTitle: a.linkButtonTitle }) });
    const m = await markSent(db, { id: a.outboundId, tenantId: a.tenantId, providerMessageId: `mid.out.${sent.length}`, unitCost: usdToNano(0), now: new Date() });
    if (!m.ok) throw new Error(`markSent: ${m.detail}`);
    return { outcome: 'sent', providerMessageId: `mid.out.${sent.length}` };
  },
  graphVersionDefault: () => 'v21.0',
  scheduleSweep: async (at, key) => { scheduled.push({ at, key }); },
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
/** The hours the next customer messages see (one check swaps in a day that closes half an hour from now). */
let hoursNow = HOURS;

/** A branch tenant the chats talk to. `hours` null: the main tenant's `hoursNow`. */
type Tenant = { id: string; channel: string; page: string; hours: typeof HOURS | null };
const MAIN: Tenant = { id: T, channel: CH, page: PAGE, hours: null };
type Chat = { psid: string; conversationId: string; last: TurnResult | null; lastBody: string | null; transcript: string[]; tenant: Tenant };

function newChat(psid = `psid-${randomUUID().slice(0, 8)}`, tenant: Tenant = MAIN): Chat {
  const contact = psql(`insert into contacts (tenant_id, channel_id, external_id) values ('${tenant.id}', '${tenant.channel}', '${psid}') returning id`).split('\n')[0] as string;
  const conv = psql(`insert into conversations (tenant_id, contact_id, channel_id) values ('${tenant.id}', '${contact}', '${tenant.channel}') returning id`).split('\n')[0] as string;
  return { psid, conversationId: conv, last: null, lastBody: null, transcript: [], tenant };
}

/** One customer message through the hook exactly as the reception worker calls it, then the worker's claim and send. */
async function says(chat: Chat, text: string, payload?: string): Promise<TurnResult> {
  const mid = `mid.${randomUUID()}`;
  const tn = chat.tenant;
  const r = await bookingTurn(ports, {
    tenantId: tn.id, channelId: tn.channel, conversationId: chat.conversationId, psid: chat.psid, mid, text,
    ...(payload === undefined ? {} : { quickReplyPayload: payload }), respelled: null, hours: tn.hours ?? hoursNow, closures: [],
  });
  chat.last = r;
  chat.transcript.push(`**Customer:** ${text}${payload === undefined ? '' : ' *(tap)*'}`);
  if (r.handled && r.outboundId !== null) {
    const held = await claim(db, { id: r.outboundId, tenantId: tn.id, now: new Date() });
    if (held.outcome !== 'claimed') throw new Error(`claim: ${held.outcome} ${held.outcome === 'unavailable' ? held.detail : ''}`);
    await ports.deliver({ tenantId: tn.id, channelId: tn.channel, pageId: tn.page, recipientId: chat.psid, outboundId: held.id, body: held.body, attempts: held.attempts,
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
const FEMALE = say(wording, 'booking_gender_female');
const MALE = say(wording, 'booking_gender_male');
const CHILD = say(wording, 'booking_gender_child');
const AGREE = say(wording, 'booking_agree');
const CANCEL = say(wording, 'booking_cancel');
/** Two services of Tara's current list used throughout: 120 and 60 minutes, any stylist of either gender. */
const SVC_120 = 'Үйлчилгээ — Эмчилгээний будаг';
const SVC_60 = 'Үйлчилгээ — Хуйх цэвэрлэгээ';

/** Walk a chat to the agreement for one stylist and time tomorrow. */
async function toAgreement(chat: Chat, opts: { service?: string; group?: string; stylist: string; time: string; name?: string; phone?: string; gender?: string; day?: string }) {
  await says(chat, 'Цаг авъя');
  await taps(chat, opts.gender ?? say(wording, 'booking_gender_female'));
  await taps(chat, opts.group ?? 'Үйлчилгээ');
  await taps(chat, opts.service ?? 'Эмчилгээний будаг');
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
check(a.last?.handled === true && a.lastBody === say(wording, 'booking_ask_gender'), 'a booking message starts the flow with who it is for');
check(JSON.stringify(titles(a)) === JSON.stringify([FEMALE, MALE, CHILD, CANCEL]), 'Эмэгтэй / Эрэгтэй / Хүүхэд, with «Цуцлах»');
await taps(a, FEMALE);
check(a.lastBody === say(wording, 'booking_ask_service_group') && JSON.stringify(titles(a)) === JSON.stringify(['Эмэгтэй засалт', 'Үйлчилгээ', 'Эмэгтэй хими', 'Эмэгтэй будаг', CANCEL]),
  'then the current price list\'s sections for a woman (the men\'s section is not offered)');
await taps(a, 'Үйлчилгээ');
check(JSON.stringify(titles(a)) === JSON.stringify(['Хуйх цэвэрлэгээ', 'Үс оношлогоо', 'Нөхөн сэргээх', 'Үсний тэжээл', 'Үсний спа', 'CICA эмчилгээ', 'Эмчилгээний будаг', CANCEL]), 'the group\'s services');
await taps(a, 'Эмчилгээний будаг');
check(a.lastBody === say(wording, 'booking_ask_stylist') && JSON.stringify(titles(a)) === JSON.stringify(['Oyunaa · SPECIAL', 'Badamaa · Мастер', say(wording, 'booking_any_of_level', { level: '1-р зэрэг' }),
  'Uyanga · 1-р зэрэг', 'Zaya · 1-р зэрэг', 'Chimgee · 1-р зэрэг', 'Otgonjargal', CANCEL]),
  'a woman is offered only the women stylists, by their short Latin names, level by level (none recommended), the man not at all');
await taps(a, 'Oyunaa · SPECIAL');
check(a.lastBody === say(wording, 'booking_ask_when', { service: SVC_120 }) && titles(a).includes(T_MAR),
  'Дали asks when (day and time), with the days that still have a free time as buttons');
// The website books Оюунаа 10:00–12:00 tomorrow: those starts must not be offered.
google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(tomorrow(), 10), 120);
await taps(a, T_MAR);
check(!titles(a).includes('10:00') && !titles(a).includes('11:00') && titles(a).includes('12:00') && titles(a).includes('18:00') && !titles(a).includes('19:00'),
  'times read from the real calendar: the website\'s 10–12 booking is gone, and a 2-hour service is not offered at 19:00');
await taps(a, '14:00');
check(a.lastBody === say(wording, 'booking_ask_name'), 'asks the name');
await says(a, 'Болд');
await says(a, '991122');
check(a.lastBody === say(wording, 'booking_phone_invalid'), 'a phone that is not 8 digits is asked again');
await says(a, '+976 9911 2233');
check((a.lastBody ?? '').includes('Oyunaa (SPECIAL)') && (a.lastBody ?? '').includes(SVC_120)
  && (a.lastBody ?? '').includes('14:00') && (a.lastBody ?? '').includes('20,000₮') && JSON.stringify(titles(a)) === JSON.stringify([AGREE, CANCEL]),
  'before anything is held: the summary (service, stylist, time, SPECIAL 20,000₮ deposit), with «Зөвшөөрч, захиалах»');
check(!/Нөхцөл|буца/u.test(a.lastBody ?? ''), 'the summary states no deposit terms: Дали never says the deposit is non-refundable');
check(psql(`select count(*) from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${a.conversationId}'`) === '0', 'no hold and no QR until the customer says to book');
const agreedAt = sent.length;
await taps(a, AGREE);
const holdA = holdOf(a);
check(holdState(holdA) === 'held', 'agreeing holds the time');
check(a.last?.handled === true && a.last.linkButtonTitle === say(wording, 'billing_pay_button') && /\/book\/[0-9a-f-]{36}\./u.test(a.lastBody ?? ''),
  'the answer carries the «Төлбөр төлөх» button to the signed deposit page');
check((a.lastBody ?? '').includes('20,000₮') && (a.lastBody ?? '').includes('Oyunaa (SPECIAL)') && (a.lastBody ?? '').includes('14:00'), 'it names the deposit (Мастер: 20,000₮), stylist and time');
const evA = google.live(TEST_CALENDARS.oyunaa).find((e) => e.id === eventIdForHold(holdA));
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
check(conf.includes(SVC_120) && conf.includes('Oyunaa (SPECIAL)') && conf.includes('14:00') && conf.includes('Яармаг салбар') && conf.includes('Номин Хайпермаркет'),
  'the confirmation names service, stylist, day, time, branch and address');
const liveA = google.live(TEST_CALENDARS.oyunaa).filter((e) => e.start.getTime() === ubAt(tomorrow(), 14).getTime());
check(liveA.length === 1 && liveA[0]?.summary === `99112233 - ${SVC_120}` && liveA[0]?.description.includes('QPay invoice: ') && liveA[0]?.description.includes('Summary accepted: «'),
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
await toAgreement(b, { stylist: 'Badamaa · Мастер', time: '15:00', name: 'Сараа', phone: '88112233' });
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
check(google.live(TEST_CALENDARS.badamaa).every((e) => e.id !== eventIdForHold(holdB)), 'the calendar hold is removed: the time is free again');
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
check(google.live(TEST_CALENDARS.badamaa).filter((e) => e.start.getTime() === ubAt(tomorrow(), 15).getTime()).length === 1, 'one event at 15:00');

// =====================================================================================
section('4. Late payment: the time was taken → no booking, founder paged, money visible');
// =====================================================================================
const c = newChat();
await toAgreement(c, { stylist: 'Uyanga · 1-р зэрэг', time: '11:00', name: 'Туяа', phone: '95112233' });
await taps(c, AGREE);
const holdC = holdOf(c);
check(c.lastBody?.includes('10,000₮') === true, '1-р зэрэг: the deposit is 10,000₮ (Tara\'s rule)');
const invC = invoicesOf(holdC);
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdC}'`);
await runSweep(ports);
check(holdState(holdC) === 'expired', 'released');
google.websiteBooks(TEST_CALENDARS.uyanga, ubAt(tomorrow(), 11), 60);
const d = newChat();
qpayFake.pay(invC[0] as string, { force: true });
const beforeC = sent.length;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdC));
// The DB had no other hold, so the payment re-took it in the database, then the calendar showed the website's booking.
check(holdState(holdC) === 'paid_unbooked', 'paid, the time is gone: paid_unbooked');
check(alerts.some((x) => x.kind === 'booking.paid_unbooked' && x.body.includes('95112233') && x.body.includes('10,000₮') && /refund/u.test(x.body)),
  'the founder is paged at once with name, phone and amount, to refund or rebook');
check(pushedTo(c, beforeC).some((s) => s.body === say(wording, 'booking_paid_unbooked')), 'the customer is told a person will call');
check(google.live(TEST_CALENDARS.uyanga).filter((e) => e.start.getTime() === ubAt(tomorrow(), 11).getTime()).length === 1, 'still one event at 11:00 (the website\'s)');
void d;

// =====================================================================================
section('5. Paid twice → one booking, the second payment paged for a refund');
// =====================================================================================
const e = newChat();
await toAgreement(e, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Oyunaa · SPECIAL', time: '16:00', name: 'Ану', phone: '99001122' });
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
check(google.live(TEST_CALENDARS.oyunaa).filter((x) => x.start.getTime() === ubAt(tomorrow(), 16).getTime()).length === 1, 'one event, not two');
check(alerts.filter((x) => x.kind === 'booking.excess_payment' && x.body.includes('99001122')).length === 1, 'the extra payment is paged once, for a refund');
check(pushedTo(e, beforeE).filter((s) => s.body === say(wording, 'booking_excess')).length === 1
  && pushedTo(e, beforeE).filter((s) => s.body.includes('16:00')).length === 1, 'the customer gets one confirmation and one line about the double payment');

// A payment twice on ONE invoice (two taps in the bank app) is the same.
const e2 = newChat();
await toAgreement(e2, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '17:00', name: 'Ану', phone: '99001123' });
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
await toAgreement(r1, { stylist: 'Uyanga · 1-р зэрэг', time: '13:00', name: 'Нэг', phone: '91000001' });
await toAgreement(r2, { stylist: 'Uyanga · 1-р зэрэг', time: '13:00', name: 'Хоёр', phone: '91000002' });
await Promise.all([taps(r1, AGREE), taps(r2, AGREE)]);
const held13 = psql(`select count(*) from booking_holds where calendar_id = '${TEST_CALENDARS.uyanga}' and starts_at = '${ubAt(tomorrow(), 13).toISOString()}' and state = 'held'`);
check(held13 === '1', 'exactly one hold on that time');
const winners = [r1, r2].filter((x) => x.last?.handled === true && x.last.linkButtonTitle !== undefined);
const losers = [r1, r2].filter((x) => x.last?.handled === true && x.last.linkButtonTitle === undefined);
check(winners.length === 1 && losers.length === 1, 'one customer gets the pay button, the other does not');
check(losers[0]?.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true && !titles(losers[0] as Chat).includes('13:00') && !titles(losers[0] as Chat).includes('14:00') && titles(losers[0] as Chat).includes('15:00'),
  'the other is told the time was taken and offered only times a 2-hour service still fits (15:00 on)');
check(google.live(TEST_CALENDARS.uyanga).filter((x) => x.start.getTime() === ubAt(tomorrow(), 13).getTime()).length === 1, 'one hold event in the calendar');
check(psql(`select count(*) from booking_invoices i join booking_holds h on h.id = i.hold_id where h.starts_at = '${ubAt(tomorrow(), 13).toISOString()}' and h.calendar_id = '${TEST_CALENDARS.uyanga}'`) === '1',
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
  p_hold: { calendar_id: TEST_CALENDARS.anand, staff_name: 'Anand', level: 'Мастер', service: SVC_120, minutes: 120,
    starts_at: s18.toISOString(), ends_at: new Date(s18.getTime() + 7_200_000).toISOString(), deposit_mnt: 20000,
    customer_name: 'X', customer_phone: '90000000', gender: 'male', agreed_at: new Date().toISOString(), agreement_text: 'a' },
})));
const outcomes = results.map((r) => (r.error ? `error:${r.error.code ?? ''}` : String((r.data as Record<string, unknown>)['outcome'])));
check(outcomes.filter((o) => o === 'held').length === 1 && outcomes.filter((o) => o === 'taken').length === 9, `ten concurrent holds on one time: one held, nine taken (${outcomes.join(',')})`);
// Overlap, not only the same start: 19:00 inside 18:00–20:00.
const overlap = await db.rpc('booking_acquire_hold', {
  p_tenant: T, p_session: psql(`insert into booking_sessions (tenant_id, conversation_id, channel_id, psid, is_test, step) values ('${T}', '${newChat().conversationId}', '${CH}', 'p', false, 'agree') returning id`).split('\n')[0],
  p_expires_at: new Date(Date.now() + 600_000).toISOString(),
  p_hold: { calendar_id: TEST_CALENDARS.anand, staff_name: 'Anand', level: 'Мастер', service: SVC_60, minutes: 60,
    starts_at: ubAt(tomorrow(), 19).toISOString(), ends_at: ubAt(tomorrow(), 20).toISOString(), deposit_mnt: 20000,
    customer_name: 'Y', customer_phone: '90000001', gender: 'male', agreed_at: new Date().toISOString(), agreement_text: 'a' },
});
check(!overlap.error && (overlap.data as Record<string, unknown>)['outcome'] === 'taken', 'an overlapping time (19:00 inside 18:00–20:00) is taken too');

// =====================================================================================
section('7. The website and the chat race → only one wins');
// =====================================================================================
// (a) The website books between the offer and the agreement: the chat sees it and does not hold.
const w1 = newChat();
await toAgreement(w1, { stylist: 'Badamaa · Мастер', time: '12:00', name: 'Вэб', phone: '92000001' });
google.websiteBooks(TEST_CALENDARS.badamaa, ubAt(tomorrow(), 12), 60);
await taps(w1, AGREE);
check(w1.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true && psql(`select count(*) from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${w1.conversationId}'`) === '0',
  'the website booked first: the chat holds nothing and offers other times');
// (b) The website writes in the instant between the chat's hold event and its second look.
const w2 = newChat();
await toAgreement(w2, { stylist: 'Badamaa · Мастер', time: '13:00', name: 'Вэб2', phone: '92000002' });
google.afterInsert = (calId, ev) => {
  if (calId === TEST_CALENDARS.badamaa && ev.start.getTime() === ubAt(tomorrow(), 13).getTime()) google.websiteBooks(calId, ubAt(tomorrow(), 13), 60);
};
await taps(w2, AGREE);
google.afterInsert = null;
const holdW2 = psql(`select h.id from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${w2.conversationId}'`);
check(holdState(holdW2) === 'released' && w2.lastBody?.startsWith(say(wording, 'booking_slot_taken')) === true, 'the website wrote in the gap: the chat yields and says so');
check(google.live(TEST_CALENDARS.badamaa).filter((x) => x.start.getTime() === ubAt(tomorrow(), 13).getTime()).length === 1, 'one event left at 13:00, the website\'s');
check(invoicesOf(holdW2).length === 0, 'no invoice was made for a time the chat did not hold');
// (c) A person writes into a held time by hand; the customer pays anyway → no double booking, founder paged.
const w3 = newChat();
await toAgreement(w3, { stylist: 'Oyunaa · SPECIAL', time: '17:00', name: 'Вэб3', phone: '92000003' });
await taps(w3, AGREE);
const holdW3 = holdOf(w3);
google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(tomorrow(), 17), 60);
qpayFake.pay(invoicesOf(holdW3)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdW3));
check(holdState(holdW3) === 'paid_unbooked' && google.live(TEST_CALENDARS.oyunaa).filter((x) => x.start.getTime() === ubAt(tomorrow(), 17).getTime()).length === 1,
  'paid, but the time was written over: not booked twice; the hold event is gone');
check(alerts.some((x) => x.kind === 'booking.paid_unbooked' && x.body.includes('92000003')), 'the founder is paged to refund or rebook');

// =====================================================================================
section('8. «Аль ч 1-р зэрэг»: the first free one is assigned');
// =====================================================================================
const any = newChat();
google.websiteBooks(TEST_CALENDARS.uyanga, ubAt(tomorrow(), 18), 60);
await toAgreement(any, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: say(wording, 'booking_any_of_level', { level: '1-р зэрэг' }), time: '18:00', name: 'Ням', phone: '93000001' });
check((any.lastBody ?? '').includes(say(wording, 'booking_any_of_level', { level: '1-р зэрэг' })) && (any.lastBody ?? '').includes('10,000₮'), 'the summary says «Аль ч 1-р зэрэг» and its 10,000₮');
await taps(any, AGREE);
const holdAny = holdOf(any);
check(psql(`select calendar_id from booking_holds where id = '${holdAny}'`) === TEST_CALENDARS.zaya, 'Uyanga is busy at 18:00, so Zaya (the next 1-р зэрэг) takes it');

// =====================================================================================
section('9. A QPay answer that cannot be read records nothing and pages');
// =====================================================================================
const u = newChat();
await toAgreement(u, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Uyanga · 1-р зэрэг', time: '16:00', name: 'Уншихгүй', phone: '94000001' });
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
await toAgreement(x, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Uyanga · 1-р зэрэг', time: '17:00', name: 'Болиулах', phone: '96000001' });
await taps(x, AGREE);
const holdX = holdOf(x);
await taps(x, CANCEL);
check(holdState(holdX) === 'released' && x.lastBody === say(wording, 'booking_cancelled'), '«Цуцлах» after the pay button: released, cancelled line');
check(qpayFake.invoices.get(invoicesOf(holdX)[0] as string)?.status === 'CANCELLED' && google.live(TEST_CALENDARS.uyanga).every((ev) => ev.id !== eventIdForHold(holdX)),
  'its invoice cancelled and its calendar hold removed');
const y = newChat();
await says(y, 'цаг авах');
await taps(y, FEMALE);
await taps(y, 'Үйлчилгээ');
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
await toAgreement(tester, { stylist: 'Oyunaa · SPECIAL', time: '12:00', name: 'Тест', phone: '99999999' });
await taps(tester, AGREE);
const holdT = holdOf(tester);
check(tester.lastBody?.startsWith(say(wording, 'booking_test_prefix')) === true && tester.lastBody.includes('100₮'), 'the tester\'s messages are marked ТЕСТ and the deposit is 100₮');
qpayFake.pay(invoicesOf(holdT)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdT));
const testEvent = google.live(TEST_CALENDARS.oyunaa).find((ev) => ev.id === eventIdForHold(holdT));
check(holdState(holdT) === 'booked' && testEvent?.summary === `ТЕСТ – 99999999 - ${SVC_120}`, 'booked as «ТЕСТ – …» in the calendar, as the website\'s test bookings');
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
await toAgreement(k1, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '10:00', name: 'Тасарсан', phone: '97000001' });
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
await taps(k2, FEMALE);
await taps(k2, 'Үйлчилгээ');
await taps(k2, 'Хуйх цэвэрлэгээ');
await taps(k2, 'Uyanga · 1-р зэрэг');
await taps(k2, T_MAR);
await taps(k2, '12:00');
await says(k2, 'Урьдчилгаа хэд вэ?');
check(k2.lastBody === say(wording, 'booking_ask_name') && psql(`select data->>'name' from booking_sessions where conversation_id = '${k2.conversationId}'`) === '',
  'a question is not taken as a name; the name is asked once more');
const k2r = await says(k2, 'Урьдчилгаа хэд вэ? хариулаач');
check(!k2r.handled, 'asked again: the flow steps aside and Дали answers');
const k4 = newChat();
await says(k4, 'Цаг авъя');
await taps(k4, FEMALE);
await taps(k4, 'Үйлчилгээ');
await taps(k4, 'Хуйх цэвэрлэгээ');
await taps(k4, 'Uyanga · 1-р зэрэг');
await taps(k4, T_MAR);
await taps(k4, '12:00');
await says(k4, 'Нараа');
await says(k4, 'дугаар өгөхгүй');
check(k4.lastBody === say(wording, 'booking_phone_invalid'), 'a wrong phone is asked again once');
check(!(await says(k4, 'яагаад утас хэрэгтэй вэ')).handled, 'and then let go, never asked for ever');
const k5 = newChat();
await says(k5, 'Цаг авъя');
await taps(k5, FEMALE);
await taps(k5, 'Үйлчилгээ');
await taps(k5, 'Хуйх цэвэрлэгээ');
await taps(k5, 'Uyanga · 1-р зэрэг');
await taps(k5, T_MAR);
await taps(k5, '12:00');
await says(k5, CANCEL);
check(k5.lastBody === say(wording, 'booking_cancelled'), '«Цуцлах» typed at the name step cancels (it is not a name)');

// (c) A short payment never keeps the time held for ever.
const k6 = newChat();
await toAgreement(k6, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Uyanga · 1-р зэрэг', time: '19:00', name: 'Дутуу', phone: '97000006' });
await taps(k6, AGREE);
const holdK6 = holdOf(k6);
qpayFake.pay(invoicesOf(holdK6)[0] as string, { amount: 50 });
await runQpayCallback(ports, signHold(SECRET, 'callback', holdK6));
check(holdState(holdK6) === 'held' && alerts.some((x) => x.kind === 'booking.short_payment' && x.body.includes('97000006')), 'a short payment is paged and books nothing');
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdK6}'`);
await runSweep(ports);
check(holdState(holdK6) === 'expired' && google.live(TEST_CALENDARS.uyanga).every((e) => e.id !== eventIdForHold(holdK6)), 'and the hold is still released when its time is up');

// (d) A time that has started since it was offered is not held.
const k7 = newChat();
await toAgreement(k7, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '11:00', name: 'Хоцорсон', phone: '97000007' });
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
await toAgreement(k8, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '14:00', name: 'Дахин', phone: '97000008' });
const sessK8 = psql(`select id from booking_sessions where conversation_id = '${k8.conversationId}' and closed_at is null`);
const s14 = ubAt(tomorrow(), 14);
await db.rpc('booking_acquire_hold', { p_tenant: T, p_session: sessK8, p_expires_at: new Date(Date.now() + 600_000).toISOString(), p_hold: {
  calendar_id: TEST_CALENDARS.badamaa, staff_name: 'Badamaa', level: 'Мастер', service: SVC_60, minutes: 60,
  starts_at: s14.toISOString(), ends_at: new Date(s14.getTime() + 3_600_000).toISOString(), deposit_mnt: 20000,
  customer_name: 'Дахин', customer_phone: '97000008', gender: 'female', agreed_at: new Date().toISOString(), agreement_text: 'x' } });
const holdK8 = holdOf(k8);
check(psql(`select calendar_state from booking_holds where id = '${holdK8}'`) === 'none', 'set-up: held in the database, not in the calendar');
await taps(k8, AGREE);
check(google.live(TEST_CALENDARS.badamaa).some((e) => e.id === eventIdForHold(holdK8) && e.transparency === 'opaque')
  && k8.last?.handled === true && k8.last.linkButtonTitle !== undefined, 'the retry puts the hold in the calendar before asking for money');

// (f) QPay would not cancel an expired hold's invoice: paged, and a payment on it still lands.
const k9 = newChat();
await toAgreement(k9, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '18:00', name: 'Цуцлагдаагүй', phone: '97000009' });
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
await toAgreement(k10, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '11:00', name: 'Хүлээж', phone: '97000010' });
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
await toAgreement(k12, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Badamaa · Мастер', time: '19:00', name: 'Мартагдсан', phone: '97000012', day: D2 });
await taps(k12, AGREE);
const holdK12 = holdOf(k12);
const invK12 = invoicesOf(holdK12)[0] as string;
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdK12}'`);
qpayFake.failCancel = true;
await runSweep(ports);
qpayFake.failCancel = false;
check(holdState(holdK12) === 'expired', 'set-up: expired (its QR not cancelled)');
google.websiteBooks(TEST_CALENDARS.badamaa, ubAt(day2, 19), 60);
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
await toAgreement(k13, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Uyanga · 1-р зэрэг', time: '15:00', name: 'Чимээгүй', phone: '97000013', day: D2 });
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
await toAgreement(k14, { group: 'Үйлчилгээ', service: 'Хуйх цэвэрлэгээ', stylist: 'Uyanga · 1-р зэрэг', time: '17:00', name: 'Тасалдал', phone: '97000014', day: D2 });
await taps(k14, AGREE);
const holdK14 = holdOf(k14);
qpayFake.failChecks = 5;
const k14r = await taps(k14, CANCEL);
qpayFake.failChecks = 0;
check(!k14r.handled && holdState(holdK14) === 'held', 'the hold is kept while QPay is down, and the message goes to Дали');

// =====================================================================================
section('15. Дали asks when; the customer answers in words; the website and the chat see each other');
// =====================================================================================
// Three days ahead: nothing above has touched it.
const day3 = tenantClock(new Date(Date.now() + 72 * 3600_000), TZ).date;
const day4 = tenantClock(new Date(Date.now() + 96 * 3600_000), TZ).date;
const D3 = dayLabel(wording, day3, new Date(), TZ);
const typedDay3 = `${Number(day3.slice(5, 7))} сарын ${Number(day3.slice(8, 10))}-нд`;
/**
 * What Tara's website offers a customer for one stylist and day: its own `/available-slots`
 * (matrix_website routes/calendar.js, read 2026-10-02): one free/busy call over the working
 * day, starts on the hour, Mon–Sat 10–20 and Sun 11–19, a start dropped when its whole
 * appointment overlaps anything busy. Asked of the same calendar the chat writes to.
 */
async function websiteOffers(calendarId: string, date: string, minutes: number): Promise<string[]> {
  const sunday = new Date(`${date}T12:00:00+08:00`).getUTCDay() === 0;
  const [open, close] = sunday ? [11, 19] : [10, 20];
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const r = await google.fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST', headers: { authorization: 'Bearer g-token', 'content-type': 'application/json' },
    body: JSON.stringify({ timeMin: `${date}T${hh(open)}:00+08:00`, timeMax: `${date}T${hh(close)}:00+08:00`, items: [{ id: calendarId }] }),
  });
  const busy = ((await r.json()) as { calendars: Record<string, { busy: { start: string; end: string }[] }> }).calendars[calendarId]?.busy ?? [];
  const out: string[] = [];
  for (let t = open * 60; t <= close * 60 - minutes; t += 60) {
    const start = new Date(`${date}T${hh(t / 60)}:00+08:00`);
    const end = new Date(start.getTime() + minutes * 60_000);
    if (start < new Date()) continue;
    if (!busy.some((b) => start < new Date(b.end) && end > new Date(b.start))) out.push(hh(t / 60));
  }
  return out;
}

/** To the «when» question for one 1-hour service and stylist. */
async function toWhen(chat: Chat, stylist: string, first = 'Цаг авъя') {
  await says(chat, first);
  await taps(chat, FEMALE);
  await taps(chat, 'Үйлчилгээ');
  await taps(chat, 'Хуйх цэвэрлэгээ');
  await taps(chat, stylist);
}

// (a) The day and time in the very first message are checked as soon as the stylist is known.
const p1 = newChat();
await toWhen(p1, 'Badamaa · Мастер', `${typedDay3} 2 цагт цаг авъя`);
check(p1.lastBody === say(wording, 'booking_time_free', { date: D3, time: '14:00' })
  && JSON.stringify(titles(p1)) === JSON.stringify(['11:00', '12:00', '13:00', '14:00', '15:00', '16:00', CANCEL]),
  '«… 2 цагт цаг авъя» in the first message: Дали checks the calendar and says 14:00 is free, with the times around it');
check((await websiteOffers(TEST_CALENDARS.badamaa, day3, 60)).includes('14:00'), 'free/busy, asked the way the website asks it: 14:00 free before anyone books it');
await taps(p1, '14:00');
await says(p1, 'Сэлэнгэ');
await says(p1, '99112244');
check(psql(`select count(*) from booking_holds h join booking_sessions s on s.id = h.session_id where s.conversation_id = '${p1.conversationId}'`) === '0',
  'still nothing held while the customer reads the summary');
await taps(p1, AGREE);
const holdP1 = holdOf(p1);
check(holdState(holdP1) === 'held' && p1.last?.handled === true && p1.last.linkButtonTitle === say(wording, 'billing_pay_button'),
  '«Зөвшөөрч, захиалах»: the time is held and the QR is made at once');
check(!(await websiteOffers(TEST_CALENDARS.badamaa, day3, 60)).includes('14:00'),
  'Messenger holds 14:00: the website\'s free/busy question now sees 14:00 busy, while the customer pays (section 16 runs the website\'s own code)');
qpayFake.pay(invoicesOf(holdP1)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdP1));
check(holdState(holdP1) === 'booked' && !(await websiteOffers(TEST_CALENDARS.badamaa, day3, 60)).includes('14:00'),
  'paid: booked in the calendar, still busy to the website\'s free/busy question');

// (b) An unpaid chat hold gives the time back to the website.
const p2 = newChat();
await toWhen(p2, 'Badamaa · Мастер');
check(p2.lastBody === say(wording, 'booking_ask_when', { service: SVC_60 }), 'no time named yet: Дали asks when');
await says(p2, `${typedDay3} 17 цагт`);
check(p2.lastBody === say(wording, 'booking_time_free', { date: D3, time: '17:00' }), 'typed «… 17 цагт»: 17:00 is free');
await taps(p2, '17:00');
await says(p2, 'Хулан');
await says(p2, '99112255');
await taps(p2, AGREE);
const holdP2 = holdOf(p2);
check(!(await websiteOffers(TEST_CALENDARS.badamaa, day3, 60)).includes('17:00'), 'held in Messenger: busy to the website\'s free/busy question');
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdP2}'`);
await runSweep(ports);
check(holdState(holdP2) === 'expired' && (await websiteOffers(TEST_CALENDARS.badamaa, day3, 60)).includes('17:00'),
  'not paid in time: released, and free again to the website\'s free/busy question');

// (c) A website booking is never offered in Messenger; the nearest free times are.
google.websiteBooks(TEST_CALENDARS.badamaa, ubAt(day3, 11), 60);
const p3 = newChat();
await toWhen(p3, 'Badamaa · Мастер');
await says(p3, `${typedDay3} 11 цагт`);
check(p3.lastBody === say(wording, 'booking_time_not_free', { date: D3, time: '11:00' })
  && !titles(p3).includes('11:00') && !titles(p3).includes('14:00') && titles(p3).includes('10:00') && titles(p3).includes('12:00'),
  'the website booked 11:00 and Messenger booked 14:00: asked for 11, Дали says it is taken and offers the nearest free times');
await says(p3, '18 цаг');
check(p3.lastBody === say(wording, 'booking_time_free', { date: D3, time: '18:00' }) && titles(p3).includes('18:00'),
  'at the times, typing an hour not on the buttons checks that hour on the same day');
await says(p3, 'нөгөөдөр');
check(p3.lastBody === say(wording, 'booking_ask_time', { date: dayLabel(wording, tenantClock(new Date(Date.now() + 48 * 3600_000), TZ).date, new Date(), TZ) }),
  'and another day shows that day\'s free times');

// (d) A day with nothing free: Дали says so and offers the next day that has time.
google.websiteBooks(TEST_CALENDARS.uyanga, ubAt(day3, 10), 600);
const p4 = newChat();
await toWhen(p4, 'Uyanga · 1-р зэрэг');
await says(p4, typedDay3);
check(p4.lastBody === [say(wording, 'booking_day_full', { date: D3 }), say(wording, 'booking_ask_time', { date: dayLabel(wording, day4, new Date(), TZ) })].join('\n'),
  'the stylist is fully booked that day: «… сул цаг алга», and the next day\'s free times');

// (e) Not a day or a time: asked once more, then Дали answers normally.
const p5 = newChat();
await toWhen(p5, 'Badamaa · Мастер');
await says(p5, 'хэзээ ч болно');
check(p5.lastBody === say(wording, 'booking_when_again') && titles(p5).includes(D3), 'not a day or time: asked once more, the day buttons kept');
const p5r = await says(p5, 'Үнэ хэд вэ?');
check(!p5r.handled, 'a second miss: the flow steps aside and the ordinary Дали answers');

// (f) Silent on the offered times: one follow-up, with the times read fresh; never twice.
/** The customer has been quiet `minutes`: the chat's session, its replies and its messages all moved back that far. */
const quietFor = (chat: Chat, minutes: number) => {
  psql(`update booking_sessions set updated_at = updated_at - interval '${minutes} minutes' where conversation_id = '${chat.conversationId}' and closed_at is null`);
  psql(`update outbound_messages set created_at = created_at - interval '${minutes} minutes' where conversation_id = '${chat.conversationId}'`);
};
for (const d of [0, 1, 2, 3, 4, 5, 6]) psql(`insert into business_hours (tenant_id, weekday, opens, closes, closed) values ('${T}', ${d}, '10:00', '20:00', false) on conflict do nothing`);
const p6 = newChat();
await toWhen(p6, 'Badamaa · Мастер');
await says(p6, `${typedDay3} 12 цагт`);
const oldButtons = p6.last !== null && p6.last.handled ? p6.last.quickReplies : [];
const sessionP6 = () => psql(`select id from booking_sessions where conversation_id = '${p6.conversationId}' and closed_at is null`);
const beforeP6 = sent.length;
quietFor(p6, 9);
await runSweep(ports);
check(pushedTo(p6, beforeP6).length === 0, 'nine minutes quiet: no follow-up yet');
quietFor(p6, 11);
google.websiteBooks(TEST_CALENDARS.badamaa, ubAt(day3, 13), 60);
const swept12 = await runSweep(ports);
const follow = pushedTo(p6, beforeP6);
check(follow.length === 1 && (follow[0]?.body ?? '').startsWith(`${say(wording, 'booking_follow_up')}\n`)
  && (follow[0]?.quickReplies ?? []).some((q) => q.title === '12:00') && !(follow[0]?.quickReplies ?? []).some((q) => q.title === '13:00')
  && ((swept12.body['followUps'] as Record<string, number>)['sent'] === 1),
  'ten minutes quiet: «Цаг захиалах уу?» once, with the times read fresh (the website took 13:00 meanwhile)');
quietFor(p6, 11);
await runSweep(ports);
check(pushedTo(p6, beforeP6).length === 1, 'never a second follow-up');
// Old buttons. The customer moves to another day, then taps a button from the first day's list:
// it means 12:00 on THAT day, although the other day also shows a «12:00».
const day2b = tenantClock(new Date(Date.now() + 48 * 3600_000), TZ).date;
await says(p6, 'нөгөөдөр');
check(titles(p6).includes('12:00') && psql(`select data->>'date' from booking_sessions where id = '${sessionP6()}'`) === day2b,
  'set-up: the customer moved to the day after tomorrow, which also offers a «12:00»');
const old12 = oldButtons.find((q) => q.title === '12:00');
await says(p6, '12:00', old12?.payload);
check(p6.lastBody === say(wording, 'booking_ask_name')
  && psql(`select data->>'start' from booking_sessions where id = '${sessionP6()}'`) === ubAt(day3, 12).toISOString(),
  'an old «12:00» button means 12:00 on the day it was offered for, never the same label on the day now shown');
// An old button whose time has gone since: «taken», and the free times nearest it on its day.
const p6b = newChat();
await toWhen(p6b, 'Badamaa · Мастер');
await says(p6b, `${typedDay3} 16 цагт`);
const old16 = (p6b.last !== null && p6b.last.handled ? p6b.last.quickReplies : []).find((q) => q.title === '16:00');
await says(p6b, 'нөгөөдөр');
google.websiteBooks(TEST_CALENDARS.badamaa, ubAt(day3, 16), 60);
await says(p6b, '16:00', old16?.payload);
check((p6b.lastBody ?? '').startsWith(`${say(wording, 'booking_slot_taken')}\n`) && !titles(p6b).includes('16:00')
  && psql(`select data->>'date' from booking_sessions where conversation_id = '${p6b.conversationId}' and closed_at is null`) === day3,
  'an old button for a time taken since: «taken», and that day\'s nearest free times');

// A question with no hour at the times is a miss, not a new offer: asked once, then Дали answers.
const q1 = newChat();
await toWhen(q1, 'Badamaa · Мастер');
await says(q1, `${typedDay3} 17 цагт`);
await says(q1, `${typedDay3} ажиллах уу?`);
check(q1.lastBody === say(wording, 'booking_pick_from_list'), 'at the times, asking about the day already shown adds nothing: asked once to pick');
const q1r = await says(q1, 'Нөгөөдөр ажиллах уу?');
check(!q1r.handled, 'a second question: the flow steps aside and the ordinary Дали answers');
const q3 = newChat();
await toWhen(q3, 'Badamaa · Мастер');
await says(q3, 'Нөгөөдөр болох уу?');
check(q3.lastBody === say(wording, 'booking_ask_time', { date: dayLabel(wording, tenantClock(new Date(Date.now() + 48 * 3600_000), TZ).date, new Date(), TZ) }),
  '«Нөгөөдөр болох уу?» at «when» is answered with that day\'s free times');
const q3r = await says(q3, 'Өөр өдөр болох уу?');
check(!q3r.handled, 'but it counted as a miss: a second non-answer lets the ordinary Дали answer');

// A day that cannot be booked at all is not called «full».
const far = tenantClock(new Date(Date.now() + 20 * 24 * 3600_000), TZ).date;
const q2 = newChat();
await toWhen(q2, 'Badamaa · Мастер');
await says(q2, `${Number(far.slice(5, 7))} сарын ${Number(far.slice(8, 10))}-нд 14 цагт`);
check((q2.lastBody ?? '').startsWith(`${say(wording, 'booking_day_closed', { date: dayLabel(wording, far, new Date(), TZ) })}\n`),
  'a day beyond the days the salon books ahead: «… цаг захиалах боломжгүй», then the nearest day with time');

// Never over a person, never over the customer.
const h1 = newChat();
await toWhen(h1, 'Badamaa · Мастер');
await says(h1, `${typedDay3} 18 цагт`);
psql(`update conversations set thread_control = 'human', thread_control_at = now() where id = '${h1.conversationId}'`);
quietFor(h1, 11);
const h2 = newChat();
await toWhen(h2, 'Badamaa · Мастер');
await says(h2, `${typedDay3} 19 цагт`);
quietFor(h2, 11);
// A photo gets no `messages` row (no text); its answer, the image line, is a reply row as reception writes it.
psql(`insert into outbound_messages (tenant_id, channel_id, conversation_id, kind, body, dedup_key, state) values ('${T}', '${CH}', '${h2.conversationId}', 'reply', 'image line', 'in:mid.photo.${randomUUID()}', 'draft')`);
const h3 = newChat();
await toWhen(h3, 'Badamaa · Мастер');
await says(h3, `${typedDay3} 10 цагт`);
quietFor(h3, 11);
psql(`insert into messages (tenant_id, conversation_id, direction, external_id, body) values ('${T}', '${h3.conversationId}', 'inbound', 'mid.text.${randomUUID()}', 'Хаяг хаана вэ')`);
const h4 = newChat();
await toWhen(h4, 'Badamaa · Мастер');
await says(h4, `${typedDay3} 15 цагт`);
quietFor(h4, 11);
// A sticker gets neither a message row nor a reply: only the dropped-message flag, as inbound/dropped.ts writes it.
psql(`insert into quality_flags (tenant_id, conversation_id, flag, detail) values ('${T}', '${h4.conversationId}', 'inbound_dropped', '{"reason":"sticker"}')`);
const beforeH = sent.length;
await runSweep(ports);
check(pushedTo(h1, beforeH).length === 0 && psql(`select followed_up_at is not null from booking_sessions where conversation_id = '${h1.conversationId}' and closed_at is null`) === 't',
  'staff took the thread (an echo set it to human): no follow-up, and the chat is not looked at again');
check(pushedTo(h2, beforeH).length === 0, 'the customer sent a photo and got the image line: no follow-up');
check(pushedTo(h3, beforeH).length === 0, 'the customer wrote something the flow did not take: no follow-up');
check(pushedTo(h4, beforeH).length === 0, 'the customer sent a sticker (no message, no reply, only the dropped flag): no follow-up');

// A follow-up draft left by an earlier run: refused once it is old enough to be nobody's, left
// alone while another run may be sending it. A run's draft moves the session on in the same
// transaction, so the leftover row carries the session's own time.
const fu1 = newChat();
await toWhen(fu1, 'Badamaa · Мастер');
await says(fu1, `${typedDay3} 16 цагт`);
const fu2 = newChat();
await toWhen(fu2, 'Badamaa · Мастер');
await says(fu2, `${typedDay3} 17 цагт`);
quietFor(fu1, 11);
const sessFu1 = psql(`select id from booking_sessions where conversation_id = '${fu1.conversationId}' and closed_at is null`);
const sessFu2 = psql(`select id from booking_sessions where conversation_id = '${fu2.conversationId}' and closed_at is null`);
psql(`insert into outbound_messages (tenant_id, channel_id, conversation_id, kind, body, dedup_key, state, created_at)
      values ('${T}', '${CH}', '${fu1.conversationId}', 'reply', 'old follow-up', 'booking-followup:${sessFu1}', 'draft', (select updated_at from booking_sessions where id = '${sessFu1}'))`);
const beforeFu = sent.length;
await runSweep(ports);
// fu2 goes quiet only now, and its row appears as if another run drafted it a moment ago.
quietFor(fu2, 11);
psql(`insert into outbound_messages (tenant_id, channel_id, conversation_id, kind, body, dedup_key, state)
      values ('${T}', '${CH}', '${fu2.conversationId}', 'reply', 'fresh follow-up', 'booking-followup:${sessFu2}', 'draft')`);
await runSweep(ports);
check(pushedTo(fu1, beforeFu).length === 0 && psql(`select state from outbound_messages where dedup_key = 'booking-followup:${sessFu1}'`) === 'refused'
  && psql(`select followed_up_at is not null from booking_sessions where id = '${sessFu1}'`) === 't',
  'a follow-up an earlier run drafted and never sent: refused (never sent late), the chat marked');
check(pushedTo(fu2, beforeFu).length === 0 && psql(`select state from outbound_messages where dedup_key = 'booking-followup:${sessFu2}'`) === 'draft',
  'one drafted moments ago (another run may be sending it): left alone, not sent twice');

// «Өнөөдөр» half an hour before closing, when a 60-minute service can no longer start: not
// bookable, never «full». Today closes 30 minutes from now (whatever the hour the check runs).
const ubNow = tenantClock(new Date(), TZ);
const closeIn30 = Math.min(23 * 60 + 59, Number(ubNow.time.slice(0, 2)) * 60 + Number(ubNow.time.slice(3, 5)) + 30);
const late = newChat();
await toWhen(late, 'Badamaa · Мастер');
hoursNow = HOURS.map((h) => h.weekday === ubNow.weekday
  ? { ...h, opens: '00:00:00', closes: `${String(Math.floor(closeIn30 / 60)).padStart(2, '0')}:${String(closeIn30 % 60).padStart(2, '0')}:00` } : h);
await says(late, 'өнөөдөр');
hoursNow = HOURS;
check((late.lastBody ?? '').startsWith(`${say(wording, 'booking_day_closed', { date: say(wording, 'booking_day_today') })}\n`),
  '«өнөөдөр» when nothing can still start before closing: «… цаг захиалах боломжгүй», then the next day with time');
const p7 = newChat();
await toWhen(p7, 'Badamaa · Мастер');
await says(p7, `${typedDay3} 18 цагт`);
quietFor(p7, 31);
const beforeP7 = sent.length;
await runSweep(ports);
check(pushedTo(p7, beforeP7).length === 0, 'a chat already idle (over 30 minutes) is not followed up');

// =====================================================================================
section('16. Tara\'s website\'s OWN code, on the same calendar as the chat');
// =====================================================================================
// The website's real `/available-slots` route and its real paid-booking writer
// (`services/bookingWriter.js`), loaded from a matrix_website checkout and pointed at the same
// fake Google Calendar the chat writes to. Only three things are swapped, in this process and
// never on disk: the Google client (the fake), Telegram (collected here), and the four test
// stylists' calendar ids. CI has no website checkout, so CI prints SKIPPED here; run locally:
//   MATRIX_WEBSITE=../matrix_website ./scripts/verify/booking-e2e.sh
const WEBSITE = process.env['MATRIX_WEBSITE'] ?? null;
if (WEBSITE === null) {
  process.stdout.write('  SKIPPED: MATRIX_WEBSITE is not set, so the website\'s own code was not run (CI has no checkout)\n');
} else {
  const req = createRequire(path.join(path.resolve(WEBSITE), 'server.js'));
  const websiteAlerts: string[] = [];
  const g = async (p: string, method: string, body?: unknown) => {
    const r = await google.fetch(`https://www.googleapis.com/calendar/v3${p}`, {
      method, headers: { authorization: 'Bearer g-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`google ${r.status}`), { code: r.status });
    return { data: j };
  };
  const enc = encodeURIComponent;
  const client = {
    freebusy: { query: (a: { requestBody: unknown }) => g('/freeBusy', 'POST', a.requestBody) },
    events: {
      insert: (a: { calendarId: string; requestBody: unknown }) => g(`/calendars/${enc(a.calendarId)}/events`, 'POST', a.requestBody),
      get: (a: { calendarId: string; eventId: string }) => g(`/calendars/${enc(a.calendarId)}/events/${enc(a.eventId)}`, 'GET'),
      patch: (a: { calendarId: string; eventId: string; requestBody: unknown }) => g(`/calendars/${enc(a.calendarId)}/events/${enc(a.eventId)}`, 'PATCH', a.requestBody),
      delete: (a: { calendarId: string; eventId: string }) => g(`/calendars/${enc(a.calendarId)}/events/${enc(a.eventId)}`, 'DELETE'),
      list: (a: Record<string, unknown>) => {
        const q = new URLSearchParams(Object.entries(a).filter(([k, v]) => k !== 'calendarId' && v !== undefined).map(([k, v]) => [k, String(v)]));
        return g(`/calendars/${enc(String(a['calendarId']))}/events?${q.toString()}`, 'GET');
      },
    },
  };
  const stub = (rel: string, exports: unknown) => {
    const id = req.resolve(rel);
    req.cache[id] = { id, filename: id, loaded: true, exports } as unknown as NodeJS.Module;
  };
  stub('./services/googleCalendar.js', { getCalendarClient: async () => client, normalisePrivateKey: (k: string) => k });
  stub('./services/telegram.js', { sendSalonAlert: async (text: string) => { websiteAlerts.push(text); return true; } });
  // The website's own calendar ids are read-only getters now: its real Яармаг ids are made
  // aliases of the test calendars inside the fake, so both sides write to the same calendar.
  const { STYLIST_CONFIG } = req('./config/stylists.js') as { STYLIST_CONFIG: Record<string, { calendarId: string | null }> };
  // Яармаг's stylists as the rules file lists them (by their website id), never a copy here.
  const yaRules = (taraRules()['branches'] as Record<string, { stylists: { website: string }[] }>)[BRANCH_1];
  for (const name of (yaRules?.stylists ?? []).map((x) => x.website)) {
    const real = STYLIST_CONFIG[name]?.calendarId;
    const test = (TEST_CALENDARS as Record<string, string>)[name.toLowerCase()];
    check(test !== undefined, `the e2e has a test calendar for ${name}`);
    if (typeof real === 'string' && real !== '' && test !== undefined) google.aliases.set(real, test);
  }
  // Level-named haircuts (founder, 2026-10-04): the website's own rule and the chat's must name the
  // same level for every service, so a line the chat offers only to 1-р зэрэг the website invoices only for 1-р зэрэг.
  const { requiredLevelFor } = req('./services/bookingRules.js') as { requiredLevelFor?: (services: string[]) => string | null };
  if (typeof requiredLevelFor === 'function') {
    const parsed = parseBookingConfig(taraConfig(BRANCH_1));
    const differ = parsed.ok ? allServices(parsed.config).filter((sv) => (requiredLevelFor([sv.name]) ?? null) !== sv.level).map((sv) => sv.name) : ['(rules unreadable)'];
    check(differ.length === 0, `the website's level rule and the chat's agree on every service's level (${differ.join(', ') || 'all 62'})`);
  } else {
    check(false, 'the website has no requiredLevelFor (services/bookingRules.js): level-named haircuts unchecked there');
  }
  const express = req('express') as () => { use: (p: string, r: unknown) => void; listen: (port: number, host: string, cb: () => void) => http.Server };
  const { ensurePaidBooking } = req('./services/bookingWriter.js') as {
    ensurePaidBooking: (calendar: unknown, booking: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ status: string }>;
  };
  const app = express();
  app.use('/api/calendar', req('./routes/calendar.js'));
  const server: http.Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
  const port = (server.address() as { port: number }).port;
  const websiteSlots = async (stylistId: string, date: string, service: string): Promise<string[]> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/calendar/available-slots?date=${date}&stylistId=${enc(stylistId)}&services=${enc(service)}`);
    return ((await r.json()) as { availableSlots: string[] }).availableSlots;
  };
  const websitePays = (start: Date, phone: string) => ensurePaidBooking(client, {
    stylistId: 'Badamaa', start, customerName: 'Вэб үйлчлүүлэгч', customerPhone: phone, services: [SVC_60],
    invoiceId: `web-${randomUUID()}`, test: false, customerGender: 'female', depositTermsAccepted: true, depositTermsAcceptedAt: new Date(),
  }, { amount: 20000 });
  const blocking = (start: Date) => google.live(TEST_CALENDARS.badamaa)
    .filter((e) => e.transparency === 'opaque' && e.start.getTime() < start.getTime() + 3600_000 && start.getTime() < e.end.getTime());

  // Five days ahead, or six when that is a Sunday: the website keeps Sunday 11–19, these chat
  // hours are 10–20 every day, and (d) compares whole days.
  const ahead5 = tenantClock(new Date(Date.now() + 120 * 3600_000), TZ);
  const day5 = ahead5.weekday === 0 ? tenantClock(new Date(Date.now() + 144 * 3600_000), TZ).date : ahead5.date;
  const typedDay5 = `${Number(day5.slice(5, 7))} сарын ${Number(day5.slice(8, 10))}-нд`;

  // (a) Messenger holds 12:00: the website's own page stops offering it.
  check((await websiteSlots('Badamaa', day5, SVC_60)).includes('12:00'), 'website: 12:00 is offered while nobody has it');
  const p8 = newChat();
  await toWhen(p8, 'Badamaa · Мастер', `${typedDay5} 12 цагт цаг авъя`);
  await taps(p8, '12:00');
  await says(p8, 'Мессенжер');
  await says(p8, '99887766');
  await taps(p8, AGREE);
  const holdP8 = holdOf(p8);
  check(holdState(holdP8) === 'held' && !(await websiteSlots('Badamaa', day5, SVC_60)).includes('12:00'),
    'Messenger holds 12:00 → the website\'s own /available-slots no longer offers 12:00');

  // (b) A website customer who opened the website before the hold pays for 12:00 anyway.
  const web12 = await websitePays(ubAt(day5, 12), '88001122');
  check(web12.status === 'conflict' && blocking(ubAt(day5, 12)).length === 1 && websiteAlerts.some((t) => t.includes('давхцсан') && t.includes('88001122')),
    'the website\'s paid booking at the held 12:00 is refused (no double booking) and the salon is alerted with that customer\'s phone');
  qpayFake.pay(invoicesOf(holdP8)[0] as string);
  await runQpayCallback(ports, signHold(SECRET, 'callback', holdP8));
  check(holdState(holdP8) === 'booked' && blocking(ubAt(day5, 12)).length === 1, 'the Messenger customer pays: booked; still one booking at 12:00');

  // (c) The website books 15:00 first: Messenger never offers it.
  const web15 = await websitePays(ubAt(day5, 15), '88001133');
  check(web15.status === 'booked', 'website: a customer pays for 15:00 and it is booked');
  check(!(await websiteSlots('Badamaa', day5, SVC_60)).includes('15:00') && !(await websiteSlots('Badamaa', day5, SVC_60)).includes('12:00'),
    'website: 12:00 (Messenger) and 15:00 (website) are both gone');
  const p9 = newChat();
  await toWhen(p9, 'Badamaa · Мастер');
  await says(p9, `${typedDay5} 15 цагт`);
  check(p9.lastBody === say(wording, 'booking_time_not_free', { date: dayLabel(wording, day5, new Date(), TZ), time: '15:00' })
    && !titles(p9).includes('15:00') && !titles(p9).includes('12:00') && titles(p9).includes('14:00'),
    'Messenger: asked for 15:00, Дали says it is taken and offers neither 15:00 nor 12:00');

  // (d) Both sides agree, start by start, for the whole day.
  const webSide = await websiteSlots('Badamaa', day5, SVC_60);
  const p10 = newChat();
  await toWhen(p10, 'Badamaa · Мастер');
  await taps(p10, dayLabel(wording, day5, new Date(), TZ));
  const chatTimes = titles(p10).filter((t) => t !== CANCEL);
  check(webSide.length > 0 && JSON.stringify(chatTimes) === JSON.stringify(webSide),
    `the chat and the website offer exactly the same times that day (${webSide.join(', ')})`);

  // (e)–(g) The website's own 5-minute hold (services/bookingHold.js), when the checkout has it with
  // the agreed contract (`sh…` ids, holdPlacedAt). Older checkouts: SKIPPED, said so.
  const holdPath = path.join(path.resolve(WEBSITE), 'services/bookingHold.js');
  const siteHold = existsSync(holdPath) ? req('./services/bookingHold.js') as {
    HOLD_PREFIX?: string;
    placeHold: (calendar: unknown, a: { stylistId: string; start: Date; minutes: number; phone: string; services?: string[]; now?: Date }) => Promise<{ ok: boolean; reason?: string; holdId?: string }>;
  } : null;
  if (siteHold === null || siteHold.HOLD_PREFIX !== 'sh') {
    process.stdout.write(`  SKIPPED (e)–(g): the website checkout has ${siteHold === null ? 'no services/bookingHold.js' : `hold prefix «${String(siteHold.HOLD_PREFIX)}», not the agreed «sh»`}; section 21 proves the chat's side against the contract\n`);
  } else {
    // (e) The website's customer is at the QR for 16:00: Messenger does not offer 16:00.
    const h16 = await siteHold.placeHold(client, { stylistId: 'Badamaa', start: ubAt(day5, 16), minutes: 60, phone: '88001144', services: [SVC_60] });
    const p11 = newChat();
    await toWhen(p11, 'Badamaa · Мастер');
    await says(p11, `${typedDay5} 16 цагт`);
    check(h16.ok && String(h16.holdId).startsWith('sh') && p11.lastBody === say(wording, 'booking_time_not_free', { date: dayLabel(wording, day5, new Date(), TZ), time: '16:00' }),
      'the website\'s own hold on 16:00 (its QR open): Messenger says 16:00 is taken');
    // (f) A website hold whose QR ran out, not deleted yet: free to Messenger.
    const h17 = await siteHold.placeHold(client, { stylistId: 'Badamaa', start: ubAt(day5, 17), minutes: 60, phone: '88001155', services: [SVC_60], now: new Date(Date.now() - 10 * 60_000) });
    const p12 = newChat();
    await toWhen(p12, 'Badamaa · Мастер');
    await says(p12, `${typedDay5} 17 цагт`);
    check(h17.ok && google.live(TEST_CALENDARS.badamaa).some((ev) => ev.id === h17.holdId)
      && p12.lastBody === say(wording, 'booking_time_free', { date: dayLabel(wording, day5, new Date(), TZ), time: '17:00' }),
      'a website hold whose five minutes are over (still in the calendar): Messenger offers that time');
    // (g) Messenger holds 18:00 first: the website's own hold for 18:00 is refused.
    const p13 = newChat();
    await toWhen(p13, 'Badamaa · Мастер');
    await says(p13, `${typedDay5} 18 цагт`);
    await taps(p13, '18:00');
    await says(p13, 'Чат');
    await says(p13, '99887700');
    await taps(p13, AGREE);
    const h18 = await siteHold.placeHold(client, { stylistId: 'Badamaa', start: ubAt(day5, 18), minutes: 60, phone: '88001166', services: [SVC_60] });
    check(holdState(holdOf(p13)) === 'held' && !h18.ok && h18.reason === 'slot-taken',
      'Messenger held 18:00 first: the website\'s own hold for 18:00 is refused (no QR for it)');
  }
  // (h) from-website.ts on this checkout: both branches invoice under the website's ONE merchant
  // and mcc on the platform's login; Парк Од's row differs from Яармаг's only by her bank account,
  // from the website's own PARKOD_QPAY_* names (test values here), and is «not connected» without them.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'from-website-'));
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PARKOD_')));
  const build = (slug: string, extra: Record<string, string> = {}, args: string[] = []): { code: number; qpay: unknown } => {
    const out = path.join(tmp, `${slug}-${Object.keys(extra).length}-${args.length}.sql`);
    try {
      execFileSync('node', ['scripts/booking/from-website.ts', '--website', path.resolve(WEBSITE), '--rules', 'config/booking/tara-salon.json', '--slug', slug, '--out', out, ...args],
        { env: { ...baseEnv, ...extra } as NodeJS.ProcessEnv, stdio: 'pipe' });
    } catch (e) {
      return { code: (e as { status?: number }).status ?? 1, qpay: null };
    }
    const sql = readFileSync(out, 'utf8');
    const json = /\$cfg\$(.*)\$cfg\$/su.exec(sql)?.[1] ?? '{}';
    return { code: 0, qpay: (JSON.parse(json) as Record<string, unknown>)['qpay'] };
  };
  const herBank = { PARKOD_QPAY_BANK_CODE: '050000', PARKOD_QPAY_ACCOUNT_NUMBER: '5555000005', PARKOD_QPAY_ACCOUNT_NAME: 'Test holder' };
  const yaRow = build(BRANCH_1);
  const poNone = build(BRANCH_2);
  const poRow = build(BRANCH_2, herBank);
  const yq = yaRow.qpay as Record<string, unknown> | null;
  const pq = poRow.qpay as Record<string, unknown> | null;
  const noBank = (q: Record<string, unknown> | null) => { const { bank_accounts: _b, ...rest } = q ?? {}; return rest; };
  check(yaRow.code === 0 && yq !== null && /^[0-9a-f-]{36}$/u.test(String(yq['merchant_id'])) && yq['mcc_code'] === '7230' && !('login' in yq)
    && poNone.code === 0 && poNone.qpay === 'not-connected'
    && poRow.code === 0 && pq !== null && JSON.stringify(noBank(pq)) === JSON.stringify(noBank(yq))
    && JSON.stringify(pq['bank_accounts']) === JSON.stringify([{ bank_code: '050000', account_number: '5555000005', account_name: 'Test holder' }]),
    'from-website.ts: Парк Од\'s qpay is Яармаг\'s (the website\'s one merchant, mcc 7230, the platform\'s login) but for her own bank account; «not connected» until all three are given');
  const yaAccount = String(((yq?.['bank_accounts'] ?? []) as Record<string, unknown>[])[0]?.['account_number'] ?? '');
  const poCopy = build(BRANCH_2, { ...herBank, PARKOD_QPAY_ACCOUNT_NUMBER: yaAccount });
  const oldFlag = build(BRANCH_2, herBank, ['--qpay-login', 'PARKOD']);
  check(yaAccount !== '' && (poCopy.code !== 0 || poCopy.qpay === 'not-connected') && oldFlag.code === 2,
    'from-website.ts: Яармаг\'s account given as hers is never written (not connected or refused); the old --qpay-login is refused');
  rmSync(tmp, { recursive: true, force: true });
  server.close();
}

// =====================================================================================
section('17. The QR and the held time: exactly five minutes, everywhere');
// =====================================================================================
const day6 = tenantClock(new Date(Date.now() + 144 * 3600_000), TZ).date;
const D6 = dayLabel(wording, day6, new Date(), TZ);
const typedDay6 = `${Number(day6.slice(5, 7))} сарын ${Number(day6.slice(8, 10))}-нд`;
const POLICY = 'Энэ QR 5 минутын турш хүчинтэй. Энэ хугацаанд таны сонгосон цаг хадгалагдана.';
/** From «when» to the QR, for one 1-hour service with Оюунаа at `hh` on day 6. */
async function toQr(chat: Chat, hh: number, name: string, phone: string, first = 'Цаг авъя', day = day6) {
  await toWhen(chat, 'Oyunaa · SPECIAL', first);
  const typed = `${Number(day.slice(5, 7))} сарын ${Number(day.slice(8, 10))}-нд`;
  if (chat.lastBody === say(wording, 'booking_ask_when', { service: SVC_60 })) await says(chat, `${typed} ${hh} цагт`);
  await taps(chat, `${String(hh).padStart(2, '0')}:00`);
  await says(chat, name);
  await says(chat, phone);
  await taps(chat, AGREE);
}

// (a) The QR is made and the time held for exactly five minutes, said in the message.
const t1 = newChat();
const scheduledBefore = scheduled.length;
await toQr(t1, 12, 'Тав', '99550001');
const holdT1 = holdOf(t1);
const heldFor = Number(psql(`select extract(epoch from expires_at - created_at) from booking_holds where id = '${holdT1}'`));
const qrEnds = psql(`select qr_expires_at = h.expires_at from booking_invoices i join booking_holds h on h.id = i.hold_id where i.hold_id = '${holdT1}'`);
check(holdState(holdT1) === 'held' && Math.abs(heldFor - 300) < 5 && qrEnds === 't',
  'the QR is made: the time is held for five minutes, and the QR ends at the same instant');
check((t1.lastBody ?? '').includes(POLICY), `Дали says it: «${POLICY}»`);
const expiry = new Date(psql(`select to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from booking_holds where id = '${holdT1}'`));
check(scheduled.length === scheduledBefore + 1 && scheduled[scheduled.length - 1]?.key === holdT1
  && Math.abs((scheduled[scheduled.length - 1]?.at.getTime() ?? 0) - expiry.getTime()) < 1000,
  'a sweep is scheduled for the moment the five minutes end (QStash), so the time is released on time, not at the next minute');

// (b) During those five minutes the time is taken everywhere.
const t2 = newChat();
await toWhen(t2, 'Oyunaa · SPECIAL');
await says(t2, `${typedDay6} 12 цагт`);
check(t2.lastBody === say(wording, 'booking_time_not_free', { date: D6, time: '12:00' }) && !titles(t2).includes('12:00'),
  'another Messenger customer asking for 12:00 is told it is taken, and is not offered it');
check(!(await websiteOffers(TEST_CALENDARS.oyunaa, day6, 60)).includes('12:00'), 'the website\'s free/busy sees 12:00 busy (section 16 runs the website\'s own code)');

// (c) Not paid in five minutes: released, and told once, with a button to choose again.
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdT1}'`);
const beforeT1 = sent.length;
await runSweep(ports);
const releasedMsg = pushedTo(t1, beforeT1);
check(holdState(holdT1) === 'expired' && google.live(TEST_CALENDARS.oyunaa).every((e) => e.id !== eventIdForHold(holdT1)),
  'five minutes unpaid: the hold ends and the calendar event is removed');
check((await websiteOffers(TEST_CALENDARS.oyunaa, day6, 60)).includes('12:00'), 'and 12:00 is free again to the website');
check(releasedMsg.length === 1 && (releasedMsg[0]?.body ?? '').startsWith('Уучлаарай, 5 минутын дотор')
  && JSON.stringify((releasedMsg[0]?.quickReplies ?? []).map((q) => q.title)) === JSON.stringify([say(wording, 'booking_choose_again')]),
  'the customer is told once, politely, with a «Цаг сонгох» button');
await runSweep(ports);
check(pushedTo(t1, beforeT1).length === 1, 'never twice');
await says(t1, say(wording, 'booking_choose_again'), releasedMsg[0]?.quickReplies[0]?.payload);
check(t1.lastBody === say(wording, 'booking_ask_gender'), 'tapping «Цаг сонгох» starts a new booking');
await says(t2, '12:00');
check(t2.lastBody === say(wording, 'booking_time_free', { date: D6, time: '12:00' }) && titles(t2).includes('12:00'),
  'and the other customer, asking again, is told 12:00 is free now');

// (d) A late payment, the time still free: booked.
const t3 = newChat();
await toQr(t3, 14, 'Хоцорсон', '99550003');
const holdT3 = holdOf(t3);
const invT3 = invoicesOf(holdT3)[0] as string;
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdT3}'`);
qpayFake.failCancel = true; // the QR could not be cancelled, so it can still be paid
await runSweep(ports);
qpayFake.failCancel = false;
check(holdState(holdT3) === 'expired', 'set-up: expired, its QR still payable');
qpayFake.pay(invT3);
const beforeT3 = sent.length;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdT3));
check(holdState(holdT3) === 'booked' && pushedTo(t3, beforeT3).filter((m) => m.body.includes('баталгаажлаа')).length === 1
  && alerts.some((a) => a.kind === 'booking.late_booked' && a.dedupKey.endsWith(holdT3)),
  'paid after the five minutes, the time still free: booked, confirmed once, and you are told');

// (e) A late payment, the time taken meanwhile: the nearest free times, booked on the same money.
const t4 = newChat();
await toQr(t4, 16, 'Азгүй', '99550004');
const holdT4 = holdOf(t4);
const invT4 = invoicesOf(holdT4)[0] as string;
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdT4}'`);
qpayFake.failCancel = true;
await runSweep(ports);
qpayFake.failCancel = false;
google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(day6, 16), 60);
qpayFake.pay(invT4);
const beforeT4 = sent.length;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdT4));
const offerMsg = pushedTo(t4, beforeT4);
const offered = (offerMsg[0]?.quickReplies ?? []).map((q) => q.title);
check(holdState(holdT4) === 'paid_unbooked' && offerMsg.length === 1
  && (offerMsg[0]?.body ?? '').startsWith(say(wording, 'booking_paid_unbooked_offer', { date: D6, time: '16:00' }))
  && offered.includes('17:00') && offered.includes('15:00') && !offered.includes('16:00'),
  'paid after the five minutes, the website took 16:00 meanwhile: Дали says so and offers the nearest free times');
const pageT4 = alerts.find((a) => a.kind === 'booking.paid_unbooked' && a.dedupKey.includes(holdT4));
check(pageT4 !== undefined && pageT4.body.includes('99550004') && pageT4.body.includes('refund'),
  'you are paged at once on Telegram with the customer\'s name, phone and amount, to refund or rebook');
const q17 = offerMsg[0]?.quickReplies.find((q) => q.title === '17:00');
const beforePick = sent.length;
await says(t4, '17:00', q17?.payload);
check(holdState(holdT4) === 'booked' && psql(`select to_char(starts_at at time zone 'Asia/Ulaanbaatar', 'HH24:MI') from booking_holds where id = '${holdT4}'`) === '17:00'
  && pushedTo(t4, beforePick).filter((m) => m.body.includes('баталгаажлаа') && m.body.includes('17:00')).length === 1,
  'the customer taps 17:00: booked on the deposit already paid, confirmed once');
check(psql(`select count(*) from booking_payments where hold_id = '${holdT4}'`) === '1' && invoicesOf(holdT4).length === 1
  && google.live(TEST_CALENDARS.oyunaa).filter((e) => e.id === eventIdForHold(holdT4) && e.start.getTime() === ubAt(day6, 17).getTime()).length === 1
  && alerts.some((a) => a.kind === 'booking.rebooked' && a.dedupKey.endsWith(holdT4)),
  'one payment, no new QR, one calendar event at 17:00, and you are told it was rebooked (nothing to refund)');

// (f) One hold per customer: a new QR replaces the old hold.
const t5 = newChat();
await toQr(t5, 10, 'Нэг хүн', '99550005');
const holdT5a = holdOf(t5);
const invT5a = invoicesOf(holdT5a)[0] as string;
check(holdState(holdT5a) === 'held', 'set-up: the customer holds 10:00');
await says(t5, 'Өөр цаг авъя');
check(t5.lastBody === say(wording, 'booking_ask_gender') && holdState(holdT5a) === 'held',
  'they start a new booking while the QR is out: a new chat begins; the old time stays held until a new QR is made');
await taps(t5, FEMALE);
await taps(t5, 'Үйлчилгээ');
await taps(t5, 'Хуйх цэвэрлэгээ');
await taps(t5, 'Oyunaa · SPECIAL');
await says(t5, `${typedDay6} 11 цагт`);
await taps(t5, '11:00');
await says(t5, 'Нэг хүн');
await says(t5, '99550005');
await taps(t5, AGREE);
const holdT5b = holdOf(t5);
check(holdT5b !== holdT5a && holdState(holdT5b) === 'held' && holdState(holdT5a) === 'released'
  && qpayFake.invoices.get(invT5a)?.status === 'CANCELLED' && google.live(TEST_CALENDARS.oyunaa).every((e) => e.id !== eventIdForHold(holdT5a)),
  'the new QR replaces the old hold: 10:00 is released, its QR cancelled, its calendar event removed');
check(psql(`select count(*) from booking_holds where tenant_id = '${T}' and psid = '${t5.psid}' and state = 'held'`) === '1',
  'one held time per customer, never two');

// =====================================================================================
section('18. The review\'s cases for the five minutes and the rebook');
// =====================================================================================
/** A paid deposit whose time the website took after the five minutes: the customer gets the offer. */
async function lateAndTaken(chat: Chat, hh: number, name: string, phone: string, failOffer = false, day = day6): Promise<{ hold: string; offer: Sent | undefined }> {
  await toQr(chat, hh, name, phone, 'Цаг авъя', day);
  const h = holdOf(chat);
  const inv = invoicesOf(h)[0] as string;
  psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${h}'`);
  qpayFake.failCancel = true;
  await runSweep(ports);
  qpayFake.failCancel = false;
  google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(day, hh), 60);
  qpayFake.pay(inv);
  const before = sent.length;
  failDeliver = failOffer;
  await runQpayCallback(ports, signHold(SECRET, 'callback', h));
  failDeliver = false;
  return { hold: h, offer: pushedTo(chat, before)[0] };
}
const tap = (msg: Sent | undefined, title: string) => msg?.quickReplies.find((q) => q.title === title);
// Day 6 fills up over sections 17 and 18 (how full depends on the hour the run starts): the cases
// that need a time of their own use day 5, where Оюунаа is untouched.
const day5b = tenantClock(new Date(Date.now() + 120 * 3600_000), TZ).date;

// (1) Rebooked, then the new time is lost too before it is written: told and paged again.
const rv1 = newChat();
const lr1 = await lateAndTaken(rv1, 18, 'Хоёрдахь', '99660001');
check(holdState(lr1.hold) === 'paid_unbooked' && tap(lr1.offer, '19:00') !== undefined, 'set-up: the offer is out');
google.failWrites = true;
await says(rv1, '19:00', tap(lr1.offer, '19:00')?.payload);
google.failWrites = false;
check(holdState(lr1.hold) === 'paid', 'set-up: moved to 19:00, but the calendar would not take the booking yet');
google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(day6, 19), 60);
const beforeR1 = sent.length;
await runSweep(ports);
const second = pushedTo(rv1, beforeR1);
check(holdState(lr1.hold) === 'paid_unbooked' && second.length === 1
  && (second[0]?.body ?? '').startsWith(say(wording, 'booking_paid_unbooked_offer', { date: D6, time: '19:00' }).slice(0, 20))
  && alerts.filter((a) => a.kind === 'booking.paid_unbooked' && a.dedupKey.includes(lr1.hold)).length === 2,
  'the rebooked time was taken too before it was written: the customer is told again, with times, and you are paged again');

// (2) Paid in time, a person took the time, the customer writes before QPay calls back: the
// rebook offer stays open for their tap.
const rv2 = newChat();
await toQr(rv2, 10, 'Бичсэн', '99660002');
const holdR2 = holdOf(rv2);
psql(`update booking_holds set calendar_state = 'held' where id = '${holdR2}'`);
google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(day6, 10), 60);
qpayFake.pay(invoicesOf(holdR2)[0] as string);
const beforeR2 = sent.length;
await says(rv2, 'Төлсөн');
const offerR2 = pushedTo(rv2, beforeR2).find((m) => m.quickReplies.length > 1);
check(holdState(holdR2) === 'paid_unbooked' && offerR2 !== undefined
  && psql(`select step from booking_sessions where conversation_id = '${rv2.conversationId}' and closed_at is null`) === 'rebook',
  'the customer\'s own message settled it: the offer went out and the chat stays open for the tap');
const firstFree = offerR2?.quickReplies.find((q) => q.payload.startsWith('bk:rebook:'));
await says(rv2, firstFree?.title ?? '', firstFree?.payload);
check(holdState(holdR2) === 'booked', 'and the tap books it');

// (3) Past the half hour the founder was given, a tap no longer books the deposit.
const rv3 = newChat();
const lr3 = await lateAndTaken(rv3, 13, 'Оройтсон', '99660003');
psql(`update booking_holds set ended_at = now() - interval '31 minutes' where id = '${lr3.hold}'`);
const t13 = lr3.offer?.quickReplies.find((q) => q.payload.startsWith('bk:rebook:'));
await says(rv3, t13?.title ?? '', t13?.payload);
check(holdState(lr3.hold) === 'paid_unbooked' && rv3.lastBody === say(wording, 'booking_paid_unbooked'),
  'a tap after the offer\'s half hour books nothing: the founder may have refunded; the customer is told a person will call');
const pageR3 = alerts.find((a) => a.kind === 'booking.paid_unbooked' && a.dedupKey.includes(lr3.hold));
check(pageR3 !== undefined && /until \d{2}:\d{2} Ulaanbaatar time/u.test(pageR3.body), 'the page tells you the offer\'s deadline');

// (4) Two taps at once on the offer: one booking, one confirmation.
const rv4 = newChat();
const lr4 = await lateAndTaken(rv4, 15, 'Давхар', '99660004');
const opt = lr4.offer?.quickReplies.filter((q) => q.payload.startsWith('bk:rebook:')) ?? [];
const beforeR4 = sent.length;
await Promise.all([says(rv4, opt[0]?.title ?? '', opt[0]?.payload), says(rv4, opt[1]?.title ?? '', opt[1]?.payload)]);
check(holdState(lr4.hold) === 'booked' && pushedTo(rv4, beforeR4).filter((m) => m.body.includes('баталгаажлаа')).length === 1
  && psql(`select count(*) from booking_payments where hold_id = '${lr4.hold}'`) === '1',
  'two taps at once: one booking, one confirmation, one payment');

// (5) «Цаг сонгох» tapped in the middle of another booking chat is never a name.
const rv5 = newChat();
await toWhen(rv5, 'Oyunaa · SPECIAL');
await says(rv5, `${typedDay6} 17 цагт`);
await taps(rv5, titles(rv5).find((t) => /^\d{2}:\d{2}$/u.test(t)) ?? '17:00');
check(rv5.lastBody === say(wording, 'booking_ask_name'), 'set-up: at the name step');
await says(rv5, say(wording, 'booking_choose_again'), 'bk:start');
check(rv5.lastBody === say(wording, 'booking_ask_gender')
  && psql(`select count(*) from booking_sessions where conversation_id = '${rv5.conversationId}' and data->>'name' = '${say(wording, 'booking_choose_again')}'`) === '0',
  '«Цаг сонгох» at the name step starts again; it is never stored as a name');

// (6) Paid in the last seconds, the page opened just after: «paid», never «ended».
const rv6 = newChat();
await toQr(rv6, 10, 'Сүүлчийн', '99660006', 'Цаг авъя', day5b);
const holdR6 = holdOf(rv6);
qpayFake.pay(invoicesOf(holdR6)[0] as string);
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdR6}'`);
const pageR6 = await runPayPage(ports, { token: signHold(SECRET, 'pay', holdR6), method: 'GET', stateOnly: false });
check(pageR6.html.includes(say(wording, 'booking_page_paid')) && holdState(holdR6) === 'booked',
  'the page opened just after the five minutes asks QPay first: «paid», and it is booked');

// (7) The offer could not be delivered: retried every minute until it goes out, and you are told
// not to refund before its deadline, then told again when it went out.
const rv7 = newChat();
const lr7 = await lateAndTaken(rv7, 14, 'Хүрээгүй', '99660007', true, day5b);
const undelivered = alerts.find((a) => a.kind === 'booking.paid_unbooked' && a.dedupKey.includes(lr7.hold) && a.dedupKey.endsWith(':undelivered'));
check(lr7.offer === undefined && undelivered !== undefined && undelivered.body.includes('Do not refund'),
  'the offer could not be delivered: you are told not to refund yet, with the deadline');
const beforeRv7 = sent.length;
await runSweep(ports);
const retried = pushedTo(rv7, beforeRv7);
check(retried.length === 1 && retried[0]?.quickReplies.some((q) => q.payload.startsWith('bk:rebook:')) === true
  && alerts.some((a) => a.kind === 'booking.paid_unbooked' && a.dedupKey.includes(lr7.hold) && a.dedupKey.endsWith(':offered')),
  'the next sweep delivers it, and you are told it went out');

// (8) Never delivered before the half hour ran out: no more offers; the customer and you are told.
const rv8 = newChat();
const lr8 = await lateAndTaken(rv8, 16, 'Хоцорсон2', '99660008', true, day5b);
psql(`update booking_holds set ended_at = now() - interval '31 minutes' where id = '${lr8.hold}'`);
const beforeRv8 = sent.length;
await runSweep(ports);
check(pushedTo(rv8, beforeRv8).length === 1
  && pushedTo(rv8, beforeRv8).filter((m) => m.body === say(wording, 'booking_paid_unbooked') && m.quickReplies.length === 0).length === 1
  && alerts.some((a) => a.kind === 'booking.paid_unbooked' && a.dedupKey.includes(lr8.hold) && a.dedupKey.endsWith(':none')),
  'past its half hour no times are offered any more: the customer is told a person will call, and the deposit is yours');

// (9) After «refund it», a second QPay callback (a retry, a second payment) pages nothing more:
// never an «offered» after a «none».
const pagesRv8 = alerts.filter((a) => a.dedupKey.includes(lr8.hold)).length;
await runQpayCallback(ports, signHold(SECRET, 'callback', lr8.hold));
await runSweep(ports);
check(alerts.filter((a) => a.dedupKey.includes(lr8.hold)).length === pagesRv8
  && !alerts.some((a) => a.dedupKey.includes(lr8.hold) && a.dedupKey.endsWith(':offered')),
  'after «refund it», another callback and another sweep page nothing: never «offered» after «none»');

// (10) A channel that does not deliver (switched to shadow meanwhile): «none», the deposit is yours.
const rv10 = newChat();
await toQr(rv10, 18, 'Сүүдэр', '99660010', 'Цаг авъя', day5b);
const holdRv10 = holdOf(rv10);
const invRv10 = invoicesOf(holdRv10)[0] as string;
psql(`update booking_holds set expires_at = now() - interval '1 second' where id = '${holdRv10}'`);
qpayFake.failCancel = true;
await runSweep(ports);
qpayFake.failCancel = false;
google.websiteBooks(TEST_CALENDARS.oyunaa, ubAt(day5b, 18), 60);
qpayFake.pay(invRv10);
psql(`update tenant_channels set delivery_mode = 'shadow' where id = '${CH}'`);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdRv10));
psql(`update tenant_channels set delivery_mode = 'live' where id = '${CH}'`);
check(holdState(holdRv10) === 'paid_unbooked'
  && alerts.some((a) => a.dedupKey.includes(holdRv10) && a.dedupKey.endsWith(':none'))
  && !alerts.some((a) => a.dedupKey.includes(holdRv10) && a.dedupKey.endsWith(':undelivered')),
  'the channel does not deliver: you are told the deposit is yours to refund or book, never «wait for a retry» that cannot come');
check(psql(`select count(*) from booking_sessions where conversation_id = '${rv10.conversationId}' and closed_at is null and step = 'rebook'`) === '0',
  'and no offer is left open behind that page: a later tap cannot book a deposit you may have refunded');

// =====================================================================================
section('19. Who it is for: a man books only the man stylist; «Хүүхэд» leads to the children\'s services');
const man = newChat();
await says(man, 'Цаг авъя');
await taps(man, MALE);
await taps(man, 'Үйлчилгээ');
await taps(man, 'Хуйх цэвэрлэгээ');
check(JSON.stringify(titles(man)) === JSON.stringify(['Anand · Мастер', CANCEL]), 'a man is offered only Anand, the one man stylist');
const manG = newChat();
await says(manG, 'Цаг авъя');
await taps(manG, MALE);
check(JSON.stringify(titles(manG)) === JSON.stringify(['Эрэгтэй засалт', 'Үйлчилгээ', CANCEL]), 'a man: the men\'s section and the services for everyone, no women\'s section');
await taps(manG, 'Эрэгтэй засалт');
check(!titles(manG).includes('Тайралт /SPECIAL/') && titles(manG).includes('Тайралт том хүн') && titles(manG).includes('Гоёлын засалт'),
  'the men\'s SPECIAL haircut is not offered (no man here is SPECIAL); the men\'s styling from the price list is');
const girl = newChat();
await says(girl, 'Цаг авъя');
await taps(girl, CHILD);
check(girl.lastBody === say(wording, 'booking_ask_service') && JSON.stringify(titles(girl)) === JSON.stringify(['Охин', 'Эрэгтэй 0–13 нас', 'Эрэгтэй 14–18 нас', CANCEL]),
  '«Хүүхэд»: the children\'s services, straight away (no service groups)');
await taps(girl, 'Охин');
check(JSON.stringify(titles(girl)) === JSON.stringify(['Oyunaa · SPECIAL', 'Badamaa · Мастер', say(wording, 'booking_any_of_level', { level: '1-р зэрэг' }), 'Uyanga · 1-р зэрэг', 'Zaya · 1-р зэрэг', 'Chimgee · 1-р зэрэг', 'Otgonjargal', CANCEL]),
  'a girl\'s haircut: the women stylists only');
const boy = newChat();
await says(boy, 'Цаг авъя');
await taps(boy, CHILD);
await taps(boy, 'Эрэгтэй 0–13 нас');
check(JSON.stringify(titles(boy)) === JSON.stringify(['Anand · Мастер', CANCEL]), 'a boy\'s haircut: Anand only');
await taps(boy, 'Anand · Мастер');
check(boy.lastBody === say(wording, 'booking_ask_when', { service: 'Эрэгтэй засалт — Тайралт хүүхэд /0–13 нас/' }), 'and on to when, with the children\'s service by its own name');
check(psql(`select data->>'gender' || '/' || (data->>'minutes') from booking_sessions where conversation_id = '${boy.conversationId}' and closed_at is null`) === 'male/30',
  'the boy\'s haircut is recorded as served by a man, with its confirmed 30 minutes (what the hold will carry)');
// The price list's per-level lines: one button, then the level; a level line is served only at that level.
const cut = newChat();
await says(cut, 'Цаг авъя');
await taps(cut, FEMALE);
await taps(cut, 'Эмэгтэй засалт');
check(JSON.stringify(titles(cut)) === JSON.stringify(['Тайралт том хүн', 'Тайралт /чёлк/', 'Хэлбэржүүлэлт', 'Гоёлын засалт', 'Хуримын засалт', CANCEL]), 'the women\'s section: one button per price-list line or family');
await taps(cut, 'Тайралт том хүн');
check(cut.lastBody === say(wording, 'booking_ask_variant', { service: 'Тайралт том хүн' }) && JSON.stringify(titles(cut)) === JSON.stringify(['SPECIAL', 'МАСТЕР', '1-р зэрэг', CANCEL]),
  'then which of its lines, in the price list\'s words');
await taps(cut, 'SPECIAL');
check(JSON.stringify(titles(cut)) === JSON.stringify(['Oyunaa · SPECIAL', CANCEL])
  && psql(`select data->>'minutes' from booking_sessions where conversation_id = '${cut.conversationId}' and closed_at is null`) === '75',
  'the SPECIAL haircut: Oyunaa only, 75 minutes (the confirmed sheet)');
const cut1 = newChat();
await says(cut1, 'Цаг авъя');
await taps(cut1, FEMALE);
await taps(cut1, 'Эмэгтэй засалт');
await taps(cut1, 'Тайралт том хүн');
await taps(cut1, '1-р зэрэг');
check(JSON.stringify(titles(cut1)) === JSON.stringify([say(wording, 'booking_any_of_level', { level: '1-р зэрэг' }), 'Uyanga · 1-р зэрэг', 'Zaya · 1-р зэрэг', 'Chimgee · 1-р зэрэг', 'Otgonjargal', CANCEL]),
  'the 1-р зэрэг haircut: only 1-р зэрэг stylists, Otgonjargal among them (her name alone: with her level it is over 20)');
// Typed, not tapped: her Cyrillic name picks her (an alias in the rules, never shown).
await says(cut1, 'Отгонжаргал');
check(cut1.lastBody === say(wording, 'booking_ask_when', { service: 'Эмэгтэй засалт — Тайралт том хүн /1-р зэрэг/' })
  && psql(`select data->>'stylist' from booking_sessions where conversation_id = '${cut1.conversationId}' and closed_at is null`) === `s:${TEST_CALENDARS.otgonjargal}`,
  'typed «Отгонжаргал» at the stylist question picks Otgonjargal (1-р зэрэг) and goes on to when');
// A level-named haircut never goes to another level, typed either: «Отгонжаргал» typed for the МАСТЕР line is not taken.
const cutS = newChat();
await says(cutS, 'Цаг авъя');
await taps(cutS, FEMALE);
await taps(cutS, 'Эмэгтэй засалт');
await taps(cutS, 'Тайралт том хүн');
await taps(cutS, 'МАСТЕР');
check(JSON.stringify(titles(cutS)) === JSON.stringify(['Badamaa · Мастер', CANCEL]), 'the МАСТЕР haircut: Badamaa only (no 1-р зэрэг, no «Аль ч»)');
await says(cutS, 'Отгонжаргал');
check(cutS.lastBody === say(wording, 'booking_pick_from_list')
  && psql(`select step || '/' || coalesce(data->>'stylist', 'none') from booking_sessions where conversation_id = '${cutS.conversationId}' and closed_at is null`) === 'stylist/none',
  'typed «Отгонжаргал» for the МАСТЕР haircut is not taken: she is 1-р зэрэг');
await says(cutS, 'Бадмаа');
check(cutS.lastBody === say(wording, 'booking_ask_when', { service: 'Эмэгтэй засалт — Тайралт том хүн /МАСТЕР/' }), 'typed «Бадмаа» (an approved spelling) picks Badamaa');
const adultAfterChild = newChat();
await says(adultAfterChild, 'Цаг авъя');
await taps(adultAfterChild, CHILD);
await says(adultAfterChild, 'Хуйх цэвэрлэгээ');
check(adultAfterChild.lastBody === say(wording, 'booking_pick_from_list'), 'an adult service typed on the children\'s list is not taken');

// =====================================================================================
section('20. Two branches: Парк Од is her own tenant, with her own calendars and her own bank account (Яармаг\'s merchant and login)');
// =====================================================================================
const T2 = randomUUID();
const CH2 = randomUUID();
const PAGE2 = `page-${T2.slice(0, 8)}`;
const PARK_ADDRESS = 'Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот';
psql(`insert into tenants (id, slug, display_name, vertical, timezone) values ('${T2}', 'park-od-e2e-${T2.slice(0, 8)}', 'Tara Salon — Парк Од', 'salon', '${TZ}')`);
psql(`insert into tenant_channels (id, tenant_id, provider, external_id, auth_flavour, app_slug, status, delivery_mode, token_status, name_confirmed_at)
      values ('${CH2}', '${T2}', 'facebook_page', '${PAGE2}', 'facebook_login', 'dalatech', 'active', 'live', 'active', now())`);
psql(`insert into contact_points (tenant_id, kind, value) values ('${T2}', 'address', '${PARK_ADDRESS}')`);
psql(`insert into tenant_booking (tenant_id, mode, booking_url) values ('${T2}', 'link', 'https://www.matrixecosalon.org/')`);
// Парк Од's hours (founder): Monday–Saturday 10:00–20:00, Sunday 11:00–19:00.
const PARK_HOURS = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, opens: d === 0 ? '11:00:00' : '10:00:00', closes: d === 0 ? '19:00:00' : '20:00:00', closed: false }));
const PARK: Tenant = { id: T2, channel: CH2, page: PAGE2, hours: PARK_HOURS };
const setPark = (config: Record<string, unknown>) => psql(
  `insert into booking_config (tenant_id, mode, config) values ('${T2}', 'live', $json$${JSON.stringify(config)}$json$::jsonb)
   on conflict (tenant_id) do update set mode = excluded.mode, config = excluded.config`);
const parkSessions = () => psql(`select count(*) from booking_sessions where tenant_id = '${T2}'`);
const PARK_Q = testMerchant(BRANCH_2);
const YA_Q = testMerchant(BRANCH_1);
const PARK_BANK = PARK_Q.bank_accounts[0] as { bank_code: string; account_number: string; account_name: string };
const YA_BANK = YA_Q.bank_accounts[0] as { bank_code: string; account_number: string; account_name: string };

// (a) Today's row (from-website.ts): every calendar and the QPay «not connected» (her account not given yet).
setPark(taraConfig(BRANCH_2, { qpay: 'not-connected' }, { calendars: false }));
const pn = newChat(undefined, PARK);
const pnr = await says(pn, 'Цаг авъя');
const pnt = await says(newChat('psid-tester', PARK), 'Цаг авъя');
check(!pnr.handled && pnr.reason === 'not_connected' && !pnt.handled && parkSessions() === '0',
  'Парк Од not connected: no booking offered there, not even to a tester; the ordinary Дали answers; nothing written');
// (b) Calendars connected, her bank account not there yet: still nothing (never Яармаг's account instead).
setPark(taraConfig(BRANCH_2, { qpay: 'not-connected' }));
const pn2 = await says(newChat(undefined, PARK), 'Цаг авъя');
check(!pn2.handled && pn2.reason === 'not_connected' && parkSessions() === '0', 'calendars connected, her bank account still missing: still not offered');
// One calendar still missing is enough to keep the branch off.
setPark(taraConfig(BRANCH_2, { stylists: (taraConfig(BRANCH_2)['stylists'] as Record<string, unknown>[]).map((x, i) => (i === 6 ? { ...x, calendar_id: 'not-connected' } : x)) }));
const pn3 = await says(newChat(undefined, PARK), 'Цаг авъя');
check(!pn3.handled && pn3.reason === 'not_connected', 'one stylist\'s calendar still missing (Tuchku): the branch stays off');

// (c) Connected: Яармаг's merchant (already registered under the platform's login; nothing new on
// QPay's side, founder 2026-10-04) with her own bank account.
check(PARK_Q.merchant_id === YA_Q.merchant_id && PARK_BANK.account_number !== YA_BANK.account_number, 'her row: Яармаг\'s merchant, her own account');
setPark(taraConfig(BRANCH_2));
const pk = newChat(undefined, PARK);
await says(pk, 'Цаг авъя');
check(JSON.stringify(titles(pk)) === JSON.stringify([FEMALE, MALE, CHILD, CANCEL]), 'Парк Од connected: the booking starts, who it is for first');
await taps(pk, FEMALE);
check(JSON.stringify(titles(pk)) === JSON.stringify(['Эмэгтэй засалт', 'Үйлчилгээ', 'Эмэгтэй хими', 'Эмэгтэй будаг', CANCEL]), 'the same price list as Яармаг');
await taps(pk, 'Эмэгтэй засалт');
await taps(pk, 'Тайралт том хүн');
check(JSON.stringify(titles(pk)) === JSON.stringify(['SPECIAL', 'МАСТЕР', CANCEL]), 'no 1-р зэрэг line at Парк Од: nobody there is 1-р зэрэг');
await taps(pk, 'МАСТЕР');
check(JSON.stringify(titles(pk)) === JSON.stringify([say(wording, 'booking_any_of_level', { level: 'Мастер' }), 'Saraa · Мастер', 'Tomoo · Мастер', 'Bulgaa · Мастер', 'Enhuush · Мастер', 'Chimegee · Мастер', CANCEL]),
  'her Мастер stylists by their short names, «Аль ч Мастер»; never «Аль ч 1-р зэрэг»');
await taps(pk, 'Saraa · Мастер');
await taps(pk, T_MAR);
await taps(pk, '14:00');
await says(pk, 'Номин');
await says(pk, '88990011');
check((pk.lastBody ?? '').includes('Saraa (Мастер)') && (pk.lastBody ?? '').includes('20,000₮') && !/Нөхцөл|буца/u.test(pk.lastBody ?? ''), 'the summary: Saraa (Мастер), 20,000₮, no deposit terms');
const parkQBefore = qpayFake.invoices.size;
await taps(pk, AGREE);
const holdPk = holdOf(pk);
const invPk = qpayFake.invoices.get(invoicesOf(holdPk)[0] as string);
check(holdState(holdPk) === 'held' && psql(`select calendar_id || '/' || minutes || '/' || deposit_mnt from booking_holds where id = '${holdPk}'`) === `${TEST_CALENDARS.saraa}/60/20000`,
  'held on Saraa\'s own calendar, 60 minutes, 20,000₮');
check(qpayFake.invoices.size === parkQBefore + 1 && invPk?.merchantId === YA_Q.merchant_id && invPk.bankAccount === PARK_BANK.account_number
  && invPk.bankCode === PARK_BANK.bank_code && invPk.accountName === PARK_BANK.account_name && invPk.amount === 20000 && invPk.mcc === '7230',
  'the QPay invoice: Яармаг\'s merchant, mcc 7230, HER payout account (bank_accounts), 20,000₮');
/** An invoice body without what is this booking's own (amount, «Name - Phone», its signed callback). */
const invoiceShape = (b: Record<string, unknown> | undefined) => {
  const { amount: _a, description: _d, callback_url: _c, ...rest } = b ?? {};
  return rest;
};
const withoutBank = (b: Record<string, unknown>) => { const { bank_accounts: _b, ...rest } = b; return rest; };
check(qinvA !== undefined && invPk !== undefined && qinvA.login === invPk.login
  && JSON.stringify(Object.keys(invPk.body)) === JSON.stringify(Object.keys(qinvA.body))
  && JSON.stringify(withoutBank(invoiceShape(invPk.body))) === JSON.stringify(withoutBank(invoiceShape(qinvA.body)))
  && JSON.stringify(invPk.body['bank_accounts']) !== JSON.stringify(qinvA.body['bank_accounts']) && qinvA.bankAccount === YA_BANK.account_number,
  'Парк Од\'s invoice is Яармаг\'s exactly (same login, merchant, mcc, fields) but for bank_accounts: each branch is paid into its own account');
qpayFake.pay(invoicesOf(holdPk)[0] as string);
const beforePk = sent.length;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdPk));
const confPk = pushedTo(pk, beforePk).find((m) => m.body.includes('баталгаажлаа'))?.body ?? '';
check(holdState(holdPk) === 'booked' && confPk.includes('Парк Од салбар') && confPk.includes(PARK_ADDRESS) && confPk.includes('Saraa (Мастер)')
  && google.live(TEST_CALENDARS.saraa).some((ev) => ev.start.getTime() === ubAt(tomorrow(), 14).getTime() && ev.description.includes('Branch: Tara Salon — Парк Од')),
  'paid: booked in Saraa\'s calendar; the confirmation names «Парк Од салбар» and her address');

/** Walk a Парк Од chat to the summary for one service of «Үйлчилгээ» with one stylist. */
async function parkSummary(chat: Chat, stylist: string, time: string, phone: string) {
  await says(chat, 'Цаг авъя');
  await taps(chat, FEMALE);
  await taps(chat, 'Үйлчилгээ');
  await taps(chat, 'Хуйх цэвэрлэгээ');
  await taps(chat, stylist);
  await taps(chat, T_MAR);
  await taps(chat, time);
  await says(chat, 'Сүх');
  await says(chat, phone);
}
// (d) The platform's login taken out of the environment while her QR is out: the payment cannot be
// read; one alert episode for the tenant, no secret in it; back in: read and booked.
const pl5 = newChat(undefined, PARK);
await parkSummary(pl5, 'Bulgaa · Мастер', '16:00', '88990019');
await taps(pl5, AGREE);
const holdPl5 = holdOf(pl5);
const savedLogin = ['QPAY_USERNAME', 'QPAY_PASSWORD', 'QPAY_TERMINAL_ID'].map((k) => [k, process.env[k]] as const);
for (const [k] of savedLogin) delete process.env[k];
qpayFake.pay(invoicesOf(holdPl5)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdPl5));
await runQpayCallback(ports, signHold(SECRET, 'callback', holdPl5));
const loginAlerts = alerts.filter((al) => al.kind === 'booking.qpay_login_missing' && al.dedupKey === `booking.qpay_login_missing:${T2}`);
check(holdState(holdPl5) === 'held' && psql(`select count(*) from booking_payments where hold_id = '${holdPl5}'`) === '0'
  && loginAlerts.length === 1 && loginAlerts[0]?.repeat === 'on_change' && !(loginAlerts[0]?.body ?? '').includes(qpayFake.password),
  'the QPay login gone from the environment while her QR is out: nothing recorded, one alert episode, no secret in it');
for (const [k, v] of savedLogin) process.env[k] = v;
await runQpayCallback(ports, signHold(SECRET, 'callback', holdPl5));
check(holdState(holdPl5) === 'booked', 'the login back: the payment is read and the time booked');

// (e) Never another branch's money: Парк Од's row naming Яармаг's bank account is refused before QPay.
setPark(taraConfig(BRANCH_2, { qpay: { ...PARK_Q, bank_accounts: YA_Q.bank_accounts } }));
const px = newChat(undefined, PARK);
await parkSummary(px, 'Enhuush · Мастер', '13:00', '88990016');
const beforePx = qpayFake.calls.length;
await taps(px, AGREE);
check(px.lastBody === say(wording, 'booking_unavailable', { booking_url: 'https://www.matrixecosalon.org/' }) && qpayFake.calls.length === beforePx
  && invoicesOf(holdOf(px)).length === 0 && alerts.some((al) => al.kind === 'booking.account_shared' && al.tenantId === T2),
  'Парк Од\'s row with Яармаг\'s bank account: refused before QPay is asked, and you are paged');
setPark(taraConfig(BRANCH_2));

// Her settings broken while a QR is out: the payment is still read and recorded (money first);
// only the booking waits, and it is made once the settings are fixed.
const pu = newChat(undefined, PARK);
await parkSummary(pu, 'Saraa · Мастер', '17:00', '88990020');
await taps(pu, AGREE);
const holdPu = holdOf(pu);
psql(`update booking_config set config = config - 'levels' where tenant_id = '${T2}'`);
qpayFake.pay(invoicesOf(holdPu)[0] as string);
await runQpayCallback(ports, signHold(SECRET, 'callback', holdPu));
check(holdState(holdPu) === 'paid' && psql(`select count(*) from booking_payments where hold_id = '${holdPu}'`) === '1'
  && alerts.some((al) => al.kind === 'booking.config_unusable' && al.tenantId === T2),
  'settings unusable: the payment is still read and recorded (paid), nothing booked on them, and you are paged');
setPark(taraConfig(BRANCH_2));
await runSweep(ports);
check(holdState(holdPu) === 'booked', 'settings fixed: the next sweep books it');

// (f) Who it is for, at Парк Од: a man and a boy book only Tuchku; a girl the women; every deposit 20,000₮.
const pm = newChat(undefined, PARK);
await says(pm, 'Цаг авъя');
await taps(pm, MALE);
check(JSON.stringify(titles(pm)) === JSON.stringify(['Эрэгтэй засалт', 'Үйлчилгээ', CANCEL]), 'a man at Парк Од: the men\'s section and the services for everyone');
await taps(pm, 'Эрэгтэй засалт');
await taps(pm, 'Тайралт том хүн');
check(JSON.stringify(titles(pm)) === JSON.stringify(['Tuchku · Мастер', CANCEL]), 'a man: Tuchku only');
const pb = newChat(undefined, PARK);
await says(pb, 'Цаг авъя');
await taps(pb, CHILD);
await taps(pb, 'Эрэгтэй 14–18 нас');
check(JSON.stringify(titles(pb)) === JSON.stringify(['Tuchku · Мастер', CANCEL]), 'a boy: Tuchku only');
await taps(pb, 'Tuchku · Мастер');
await taps(pb, T_MAR);
await taps(pb, titles(pb).find((t) => /^\d{2}:\d{2}$/u.test(t)) ?? '');
await says(pb, 'Бат');
await says(pb, '88990017');
check((pb.lastBody ?? '').includes('Tuchku (Мастер)') && (pb.lastBody ?? '').includes('20,000₮'), 'a boy\'s deposit is his stylist\'s level\'s: 20,000₮');
const pg = newChat(undefined, PARK);
await says(pg, 'Цаг авъя');
await taps(pg, CHILD);
await taps(pg, 'Охин');
check(JSON.stringify(titles(pg)) === JSON.stringify(['Boloroo · SPECIAL', say(wording, 'booking_any_of_level', { level: 'Мастер' }), 'Saraa · Мастер', 'Tomoo · Мастер', 'Bulgaa · Мастер', 'Enhuush · Мастер', 'Chimegee · Мастер', CANCEL]),
  'a girl: the women of Парк Од, Boloroo (SPECIAL) first by level, nobody recommended');
await taps(pg, 'Boloroo · SPECIAL');
await taps(pg, T_MAR);
await taps(pg, titles(pg).find((t) => /^\d{2}:\d{2}$/u.test(t)) ?? '');
await says(pg, 'Сараа');
await says(pg, '88990018');
check((pg.lastBody ?? '').includes('Boloroo (SPECIAL)') && (pg.lastBody ?? '').includes('20,000₮'), 'a girl with Boloroo (SPECIAL): 20,000₮');
check(psql(`select count(*) from booking_holds where tenant_id = '${T2}' and deposit_mnt <> 20000 and not is_test`) === '0', 'no Парк Од hold carries anything but 20,000₮');
// Typed names at Парк Од: her approved spellings (founder, 2026-10-04) pick her own hairdresser;
// Яармаг's «Чимгээ» (Chimgee) is not hers and picks nobody (Парк Од's is Chimegee, «Чимэгээ»).
const ptyped = newChat(undefined, PARK);
await says(ptyped, 'Цаг авъя');
await taps(ptyped, CHILD);
await taps(ptyped, 'Охин');
const ptypedStylist = () => psql(`select step || '/' || coalesce(data->>'stylist', 'none') from booking_sessions where conversation_id = '${ptyped.conversationId}' and closed_at is null`);
await says(ptyped, 'Чимгээ');
check(ptyped.lastBody === say(wording, 'booking_pick_from_list') && ptypedStylist() === 'stylist/none',
  'at Парк Од, typed «Чимгээ» (Яармаг\'s Chimgee) picks nobody');
await says(ptyped, 'Төмөө');
check(ptypedStylist() === `when/s:${TEST_CALENDARS.tomoo}`, 'at Парк Од, typed «Төмөө» (an approved spelling) picks Tomoo');

// (g) Minutes from the confirmed sheet, and Парк Од's own hours.
const pt = newChat(undefined, PARK);
await says(pt, 'Цаг авъя');
await taps(pt, FEMALE);
await taps(pt, 'Эмэгтэй будаг');
await taps(pt, 'TARA BLEND');
check(JSON.stringify(titles(pt)) === JSON.stringify(['Богино', 'Дунд', 'Урт', CANCEL]), 'TARA BLEND: then the hair length');
await taps(pt, 'Урт');
await taps(pt, 'Boloroo · SPECIAL');
await taps(pt, T_MAR);
const tomorrowSunday = tenantClock(new Date(Date.now() + 24 * 3600_000), TZ).weekday === 0;
const lastBlend = tomorrowSunday ? '14:00' : '15:00';
check(titles(pt).includes(lastBlend) && !titles(pt).some((t) => t > lastBlend && /^\d{2}:\d{2}$/u.test(t))
  && psql(`select data->>'minutes' from booking_sessions where conversation_id = '${pt.conversationId}' and closed_at is null`) === '300',
  `TARA BLEND long is 300 minutes: the last start offered is ${lastBlend}, five hours before closing`);
// Every day, not only on days that have a Sunday 1–6 days ahead: on a Sunday the next one is 7
// days away, past the 7 days offered (today and six), and this check used to be skipped silently.
// Then the chat runs one day later on the engine's clock, so the coming Sunday is six days ahead.
clockShift = tenantClock(new Date(), TZ).weekday === 0 ? 24 * 3600_000 : 0;
const sunday = [1, 2, 3, 4, 5, 6].map((n) => tenantClock(new Date(now().getTime() + n * 24 * 3600_000), TZ)).find((d) => d.weekday === 0);
check(sunday !== undefined, 'a Sunday is among the days offered');
{
  const ps = newChat(undefined, PARK);
  // On the shifted clock the session's last write (the database's real time) would read as a
  // day idle; as in section 14 (d), it is kept as fresh as the customer's typing.
  const fresh = (): void => {
    if (clockShift !== 0) psql(`update booking_sessions set updated_at = '${new Date(now().getTime() - 60_000).toISOString()}' where conversation_id = '${ps.conversationId}' and closed_at is null`);
  };
  await says(ps, 'Цаг авъя');
  for (const title of [FEMALE, 'Үйлчилгээ', 'Хуйх цэвэрлэгээ', 'Chimegee · Мастер', dayLabel(wording, sunday?.date ?? '', now(), TZ)]) {
    fresh();
    await taps(ps, title);
  }
  const times = titles(ps).filter((t) => /^\d{2}:\d{2}$/u.test(t));
  check(times[0] === '11:00' && times[times.length - 1] === '18:00', 'Парк Од on Sunday: 11:00–19:00 (a 60-minute service from 11:00 to 18:00)');
}
clockShift = 0;

// =====================================================================================
section('21. Website holds (`sh…`, its 5-minute QR) and chat holds (`dh…`) on one calendar');
// =====================================================================================
// The website's contract (matrix_website services/bookingHold.js), written by the fake exactly as
// the contract says; section 16 (e)–(g) runs the website's own code where the checkout has it.
async function chimgeeTimes(chat: Chat) {
  await says(chat, 'Цаг авъя');
  await taps(chat, FEMALE);
  await taps(chat, 'Үйлчилгээ');
  await taps(chat, 'Хуйх цэвэрлэгээ');
  await taps(chat, 'Chimgee · 1-р зэрэг');
  await taps(chat, T_MAR);
}
const wh12 = google.websiteHolds(TEST_CALENDARS.chimgee, ubAt(tomorrow(), 12), 60, '8811 2200', new Date(Date.now() + 5 * 60_000));
const hq1 = newChat();
await chimgeeTimes(hq1);
check(/^sh[0-9a-f]{40}$/u.test(wh12.id) && titles(hq1).includes('11:00') && !titles(hq1).includes('12:00'), 'a website customer at the QR for 12:00 (its hold live): Messenger does not offer 12:00');
wh12.privateProps['holdExpiresAt'] = new Date(Date.now() - 1000).toISOString();
const hq2 = newChat();
await chimgeeTimes(hq2);
check(titles(hq2).includes('12:00'), 'its five minutes over, the hold not deleted yet: 12:00 is free to Messenger');
await taps(hq2, '12:00');
await says(hq2, 'Нэгдүгээр');
await says(hq2, '88112201');
await taps(hq2, AGREE);
check(holdState(holdOf(hq2)) === 'held' && google.live(TEST_CALENDARS.chimgee).some((ev) => ev.id === wh12.id),
  'Messenger holds 12:00 over the expired website hold (still in the calendar): an expired hold never wins');
// A website hold PLACED before ours reaches the calendar between our look and our write: we yield.
const hq3 = newChat();
await chimgeeTimes(hq3);
await taps(hq3, '13:00');
await says(hq3, 'Хоёрдугаар');
await says(hq3, '88112202');
google.afterInsert = (calId, ev) => {
  if (calId === TEST_CALENDARS.chimgee && ev.id.startsWith('dh') && ev.start.getTime() === ubAt(tomorrow(), 13).getTime()) {
    google.websiteHolds(calId, ev.start, 60, '88112299', new Date(Date.now() + 5 * 60_000), new Date(ev.created.getTime() - 1));
  }
};
await taps(hq3, AGREE);
google.afterInsert = null;
check(holdState(holdOf(hq3)) === 'released' && (hq3.lastBody ?? '').startsWith(say(wording, 'booking_slot_taken')) && invoicesOf(holdOf(hq3)).length === 0
  && !google.live(TEST_CALENDARS.chimgee).some((ev) => ev.id === eventIdForHold(holdOf(hq3))),
  'a website hold placed just before ours: Messenger yields (hold and event removed, no QR) and offers other times');
// A website hold placed just AFTER ours: ours stands (by the contract, the website re-reads and yields).
const hq4 = newChat();
await chimgeeTimes(hq4);
await taps(hq4, '15:00');
await says(hq4, 'Гуравдугаар');
await says(hq4, '88112203');
google.afterInsert = (calId, ev) => {
  if (calId === TEST_CALENDARS.chimgee && ev.id.startsWith('dh') && ev.start.getTime() === ubAt(tomorrow(), 15).getTime()) {
    google.websiteHolds(calId, ev.start, 60, '88112298', new Date(Date.now() + 5 * 60_000), new Date(ev.created.getTime() + 1));
  }
};
await taps(hq4, AGREE);
google.afterInsert = null;
check(holdState(holdOf(hq4)) === 'held' && invoicesOf(holdOf(hq4)).length === 1, 'a website hold placed just after ours: ours stands, the QR is made (the website yields to the earlier hold)');
const allIds = [...google.calendars.values()].flatMap((m) => [...m.keys()]).filter((id) => id.startsWith('dh'));
check(allIds.length > 0 && allIds.every((id) => /^dh[0-9a-f]{32}$/u.test(id) && /^[0-9a-v]+$/u.test(id)),
  `every event id Messenger wrote is \`dh\` + 32 hex: valid base32hex, never a website \`sh\`/\`qb\` id (${allIds.length} ids)`);

section('22. In-chat booking switched off or not set up: a calm page with the branch\'s phone (founder, 2026-10-04)');
// =====================================================================================
// The pay page of a hold made above, opened while the ports cannot be built: over the real
// PostgREST, the branch's phone is found through the hold, and nothing is made or changed.
{
  psql(`insert into contact_points (tenant_id, kind, value) values ('${T}', 'phone', '76001888, 91005498')`);
  const savedSecret = process.env['BOOKING_LINK_SECRET'];
  process.env['BOOKING_LINK_SECRET'] = SECRET;
  const invoicesBefore = psql('select count(*) from booking_invoices');
  const holdsBefore = psql(`select string_agg(id || state, ',' order by id) from booking_holds`);
  for (const [detail, method] of [['BOOKING_MODE is off', 'GET'], ['booking is not configured: SUPABASE_SECRET_BOOKING', 'POST']] as const) {
    const off = await payPageRoute(async () => ({ ok: false, detail }), { token: signHold(SECRET, 'pay', holdB), method, stateOnly: false }, () => db);
    check(off.status === 503 && off.redirect === undefined && off.html.includes('Онлайн захиалга одоогоор боломжгүй байна. Цаг захиалах бол <a href="tel:+97676001888">76001888</a>')
      && off.html.includes('tel:+97691005498') && !off.html.includes('data:image'),
      `${detail} (${method}): 503, the calm page with the branch's phones, no QR`);
  }
  // (a) only when the branch's website booking is KNOWN to work: its own booking link, then the phones.
  const site = await payPageRoute(async () => ({ ok: false, detail: 'BOOKING_MODE is off' }), { token: signHold(SECRET, 'pay', holdB), method: 'GET', stateOnly: false }, () => db, async () => true);
  const siteUrl = psql(`select booking_url from tenant_booking where tenant_id = '${T}'`);
  check(site.status === 503 && siteUrl.startsWith('https://') && site.html.includes(`Цагаа эндээс захиална уу: <a href="${siteUrl}">${siteUrl}</a> Эсвэл <a href="tel:+97676001888">76001888</a>`),
    `website booking known to work: line (a), the branch's own booking link (${siteUrl}), then its phones`);
  const forged = await payPageRoute(async () => ({ ok: false, detail: 'BOOKING_MODE is off' }), { token: signHold('another-secret-that-is-long-enough-000', 'pay', holdB), method: 'GET', stateOnly: false }, () => db);
  check(forged.status === 503 && !forged.html.includes('href="tel:') && forged.html.includes('Messenger-ээр бичнэ үү'), 'a link that does not check names no phone: line (c)');
  check(psql('select count(*) from booking_invoices') === invoicesBefore && psql(`select string_agg(id || state, ',' order by id) from booking_holds`) === holdsBefore,
    'no QR made and no held time changed while booking cannot run');
  if (savedSecret === undefined) delete process.env['BOOKING_LINK_SECRET']; else process.env['BOOKING_LINK_SECRET'] = savedSecret;
}

section('13. Every customer message got at most one reply; nothing was confirmed unpaid');
// =====================================================================================
// Both branches.
check(psql(`select count(*) from (select tenant_id, dedup_key from outbound_messages where tenant_id in ('${T}', '${T2}') group by 1, 2 having count(*) > 1) d`) === '0', 'no reply key twice');
check(psql(`select count(*) from booking_holds where tenant_id in ('${T}', '${T2}') and state = 'booked' and not exists (select 1 from booking_payments p where p.hold_id = booking_holds.id and p.disposition in ('applied','late_booked'))`) === '0',
  'every booked hold has a payment that paid it');
check(psql(`select count(*) from (select calendar_id, starts_at from booking_holds where tenant_id in ('${T}', '${T2}') and state in ('held','paid','booked') group by 1, 2 having count(*) > 1) d`) === '0',
  'no calendar and start held twice');
check(psql(`select count(*) from booking_holds h1 join booking_holds h2 on h1.calendar_id = h2.calendar_id and h1.tenant_id <> h2.tenant_id where h1.tenant_id in ('${T}', '${T2}')`) === '0',
  'no calendar was ever held by both branches');

if (TRANSCRIPT !== null) {
  const block = (title: string, chat: Chat, extra: string[] = []) => [`## ${title}`, '', ...chat.transcript.map((l) => `- ${l}`), ...extra, ''];
  const pushed = (chat: Chat) => sent.filter((s) => s.psid === chat.psid && !chat.transcript.some((l) => l.includes(s.body.replace(/\n/gu, ' / ')))).map((s) => `- **Дали (by itself, later):** ${s.body.replace(/\n/gu, ' / ')}`);
  const out = [
    '# In-chat booking — what the customer reads (generated)',
    '',
    `Generated by \`scripts/verify/booking-e2e.ts --transcript\` with the signed wording (set c787decc1f0a, signed by Bilguun 2026-10-04, read from the database) and Tara's real booking rules (config/booking/tara-salon.json: the 2026-10-01 price list, the confirmed minutes, the founder's stylists and deposits); calendars, merchants and customers are test values. [Buttons] are Messenger quick replies; «… ↗» is the link button.`,
    '',
    ...block('1. Book and pay', a, pushed(a)),
    ...block('2. Not paid in time', b, pushed(b)),
    ...block('4. Paid after the time was taken', c, pushed(c)),
    ...block('5. Paid twice', e, pushed(e)),
    ...block('6. Two customers, one time (the one who lost)', losers[0] as Chat),
    ...block('10. Changing the subject', y),
    ...block('11. Test mode', tester, pushed(tester)),
    ...block('15. Asked when, in words; booked; the website no longer offers the time', p1, pushed(p1)),
    ...block('15. A time the website booked', p3),
    ...block('15. Quiet on the offered times: the one follow-up', p6, pushed(p6)),
    ...block('19. A haircut priced by level (the SPECIAL line)', cut),
    ...block('19. A boy\'s haircut', boy),
    ...block('20. Парк Од: book and pay (Яармаг\'s merchant, her own bank account)', pk, pushed(pk)),
    ...block('20. Парк Од: a girl with Boloroo', pg),
    ...block('20. Парк Од: TARA BLEND, long hair (300 minutes)', pt),
  ].join('\n');
  writeFileSync(TRANSCRIPT, `${out}\n`);
  process.stdout.write(`\ntranscript written to ${TRANSCRIPT}\n`);
}

proxy.close();
process.stdout.write(`\nbooking e2e: ${checks} checks passed\n`);
