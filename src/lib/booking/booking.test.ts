/**
 * In-chat booking: the pure parts and the two clients against faithful fakes. The database,
 * the races and the whole conversation run in `scripts/verify/booking-e2e.ts` over a real
 * PostgreSQL and PostgREST.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickQr, QPAY_MCC_CODE } from '../billing/qpay.ts';
import { extractInboundMessages } from '../meta/extract.ts';
import { sendMessage, sendMessageParts } from '../meta/send.ts';
import { localDayStart } from '../time/clock.ts';
import { eventIdForHold, googleCalendar } from './calendar.ts';
import { allServices, bookingEnvMode, customerMode, depositFor, parseBookingConfig, QUICK_REPLY_TITLE_MAX, stylistButton } from './config.ts';
import { branchLabel } from './store.ts';
import { callbackUrl, linkSecret, payUrl, publicOrigin, signHold, verifyHold } from './links.ts';
import { clock, renderBookingPage } from './page.ts';
import { freeStarts, isFree, openDays } from './slots.ts';
import { draftWording, FakeGoogle, FakeQpay, TEST_CALENDARS, testConfig } from './testkit.ts';
import { looksLikeName, sameChoice, typedName, typedPhone, typedTime } from './turn.ts';
import { BOOKING_BLOCK_KEYS, missingBlocks, say, WordingError } from './wording.ts';
import { dayLabel } from './engine.ts';

const TZ = 'Asia/Ulaanbaatar';
const HOURS = [
  { weekday: 0, opens: '11:00:00', closes: '19:00:00', closed: false },
  ...[1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, opens: '10:00:00', closes: '20:00:00', closed: false })),
];
const ub = (date: string, hh: number, mm = 0) => new Date(localDayStart(date, TZ).getTime() + (hh * 60 + mm) * 60_000);
const cfg = () => {
  const p = parseBookingConfig(testConfig());
  assert.ok(p.ok, p.ok ? '' : p.detail);
  return p.config;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('a complete config parses; its timing defaults are the website\'s', () => {
  const c = cfg();
  const bare = { ...testConfig() };
  delete bare['hold_minutes'];
  const d = parseBookingConfig(bare);
  assert.ok(d.ok && d.config.holdMinutes === 5, 'with nothing set, the hold (and its QR) is five minutes');
  assert.equal(c.holdMinutes, 5, 'the time is held exactly as long as the website\'s QR: five minutes');
  assert.equal(c.slotStepMinutes, 60);
  assert.equal(c.testDepositMnt, 100);
  assert.equal(c.levels.find((l) => l.key === 'master')?.depositMnt, 20000);
  assert.equal(c.levels.find((l) => l.key === 'first')?.depositMnt, 10000);
});

test('a config missing anything that touches money or a calendar is refused, never partly on', () => {
  const refuse = (o: Record<string, unknown>, why: RegExp) => {
    const p = parseBookingConfig(testConfig(o));
    assert.equal(p.ok, false);
    assert.match(p.ok ? '' : p.detail, why);
  };
  refuse({ agreement_text: '' }, /agreement_text/);
  refuse({ qpay: undefined }, /qpay/);
  refuse({ qpay: { merchant_id: 'm', mcc_code: '72', bank_accounts: [] } }, /mcc_code/);
  refuse({ levels: [{ key: 'master', label: 'Мастер', deposit_mnt: 0 }] }, /deposit_mnt/);
  refuse({ stylists: [{ name: 'A', level: 'master', gender: 'x', calendar_id: 'c' }] }, /gender/);
  refuse({ stylists: [{ name: 'A', level: 'nope', gender: 'female', calendar_id: 'c' }] }, /not a listed level/);
  refuse({ stylists: [
    { name: 'A', level: 'master', gender: 'female', calendar_id: 'c' },
    { name: 'B', level: 'master', gender: 'female', calendar_id: 'c' },
  ] }, /calendar_id is used twice/);
  refuse({ entry_matchers: [{ mode: 'contains_stem', stems: ['ц'] }] }, /entry_matchers\[0\]/);
  refuse({ entry_matchers: [] }, /entry_matchers/);
  refuse({ service_groups: [{ label: 'Засалт', services: [{ name: 'Маш урт нэртэй үйлчилгээний нэр', minutes: 60 }] }] }, /longer than 20/);
  const labelled = parseBookingConfig(testConfig({ service_groups: [{ label: 'Арчилгаа', services: [{ name: 'CICA нөхөн сэргээх эмчилгээ', label: 'CICA эмчилгээ', minutes: 90 }] }] }));
  assert.ok(labelled.ok && labelled.config.serviceGroups[0]?.services[0]?.label === 'CICA эмчилгээ', 'a long name with a short button label is fine');
  refuse({ stylists: [{ name: 'A', label: 'Хэтэрхий урт нэртэй үсчин хүн', level: 'master', gender: 'female', calendar_id: 'c' }] }, /longer than 20/);
  const long = parseBookingConfig(testConfig({ stylists: [{ name: 'Отгонжаргал', level: 'first', gender: 'female', calendar_id: 'c' }] }));
  assert.ok(long.ok && stylistButton(long.config.stylists[0] as never, long.config.levels[1] as never) === 'Отгонжаргал',
    'a name too long to carry its level shows the name alone');
  refuse({ qr_minutes: 5 }, /qr_minutes/);
  // Children's services: who serves each is the tenant's rule, never guessed; minutes required.
  refuse({ child_services: [{ name: 'Хүүхдийн тайралт', label: 'Охин', minutes: 60 }] }, /child_services\[0\]\.gender/);
  refuse({ child_services: [{ name: 'Хүүхдийн тайралт', label: 'Охин', gender: 'female' }] }, /minutes/);
  refuse({ gender_rule: false, child_services: [{ name: 'Хүүхдийн тайралт', label: 'Охин', gender: 'female', minutes: 60 }] }, /gender_rule/);
  refuse({ child_services: [{ name: 'Энгийн засалт', gender: 'female', minutes: 60 }] }, /listed twice/);
  const kids = parseBookingConfig(testConfig());
  assert.ok(kids.ok && kids.config.childServices.length === 2 && allServices(kids.config).some((x) => x.name === 'Хүүхдийн тайралт (хүү)'));
});

test('off anywhere is off; test anywhere is testers only; a tester in live gets the test deposit', () => {
  const c = cfg();
  assert.deepEqual(customerMode('off', 'live', c, 'psid-tester'), { on: false });
  assert.deepEqual(customerMode('live', 'off', c, 'psid-tester'), { on: false });
  assert.deepEqual(customerMode('test', 'live', c, 'psid-x'), { on: false });
  assert.deepEqual(customerMode('live', 'test', c, 'psid-x'), { on: false });
  assert.deepEqual(customerMode('test', 'test', c, 'psid-tester'), { on: true, isTest: true });
  assert.deepEqual(customerMode('live', 'live', c, 'psid-x'), { on: true, isTest: false });
  assert.deepEqual(customerMode('live', 'live', c, 'psid-tester'), { on: true, isTest: true });
  assert.equal(depositFor(c, 'master', false), 20000);
  assert.equal(depositFor(c, 'first', false), 10000);
  assert.equal(depositFor(c, 'master', true), 100);
  assert.equal(depositFor(c, 'nope', false), null);
});

test('BOOKING_MODE: only exactly test or live is on', () => {
  assert.equal(bookingEnvMode(undefined), 'off');
  assert.equal(bookingEnvMode(''), 'off');
  assert.equal(bookingEnvMode('LIVE'), 'off');
  assert.equal(bookingEnvMode('on'), 'off');
  assert.equal(bookingEnvMode('test'), 'test');
  assert.equal(bookingEnvMode(' live '), 'live');
});

// ---------------------------------------------------------------------------
// Slots: the website's arithmetic
// ---------------------------------------------------------------------------

test('open days skip closed weekdays and closures, on the tenant\'s clock', () => {
  // 2026-10-03 is a Saturday. A closure on Monday the 5th.
  const now = ub('2026-10-03', 9);
  const days = openDays({ now, timezone: TZ, daysAhead: 4, hours: HOURS.filter((h) => h.weekday !== 0), closures: [
    { startsOn: '2026-10-05', endsOn: '2026-10-05', title: 't', message: 'm' },
  ] });
  assert.deepEqual(days.map((d) => d.date), ['2026-10-03', '2026-10-06']);
  const all = openDays({ now, timezone: TZ, daysAhead: 3, hours: HOURS, closures: [] });
  assert.deepEqual(all.map((d) => [d.date, d.weekday]), [['2026-10-03', 6], ['2026-10-04', 0], ['2026-10-05', 1]]);
  assert.equal(all[1]?.opensAt.toISOString(), ub('2026-10-04', 11).toISOString());
});

test('a start is offered only if the whole service fits before closing (PR #73)', () => {
  const now = ub('2026-10-03', 9);
  const [day] = openDays({ now, timezone: TZ, daysAhead: 1, hours: HOURS, closures: [] });
  assert.ok(day !== undefined);
  const four = freeStarts({ day, minutes: 240, stepMinutes: 60, now, minLeadMinutes: 0, busy: [] });
  assert.equal(four.length, 7); // 10:00 … 16:00
  assert.equal(four[four.length - 1]?.toISOString(), ub('2026-10-03', 16).toISOString());
  const one = freeStarts({ day, minutes: 60, stepMinutes: 60, now, minLeadMinutes: 0, busy: [] });
  assert.equal(one.length, 10); // 10:00 … 19:00
});

test('past starts and any overlap with a busy time are dropped', () => {
  const now = ub('2026-10-03', 12, 30);
  const [day] = openDays({ now, timezone: TZ, daysAhead: 1, hours: HOURS, closures: [] });
  assert.ok(day !== undefined);
  const busy = [{ start: ub('2026-10-03', 15, 30), end: ub('2026-10-03', 16) }];
  const starts = freeStarts({ day, minutes: 60, stepMinutes: 60, now, minLeadMinutes: 0, busy }).map((d) => d.getTime());
  assert.deepEqual(starts, [13, 14, 16, 17, 18, 19].map((h) => ub('2026-10-03', h).getTime()));
  assert.equal(isFree(ub('2026-10-03', 15), 30, busy), true);
  assert.equal(isFree(ub('2026-10-03', 15), 31, busy), false);
});

// ---------------------------------------------------------------------------
// What a customer types
// ---------------------------------------------------------------------------

test('a phone is eight digits, whatever the spacing or +976', () => {
  assert.equal(typedPhone('9911 2233'), '99112233');
  assert.equal(typedPhone('9911-2233'), '99112233');
  assert.equal(typedPhone('+976 99112233'), '99112233');
  assert.equal(typedPhone('97699112233'), '99112233');
  assert.equal(typedPhone('9911223'), null);
  assert.equal(typedPhone('утас 99112233'), null);
});

test('a typed time matches a button; a name needs a letter', () => {
  assert.equal(typedTime('14'), '14:00');
  assert.equal(typedTime('9.30'), '09:30');
  assert.equal(typedTime('14 цаг'), '14:00');
  assert.equal(typedTime('14:00'), '14:00');
  assert.equal(typedTime('25'), null);
  assert.equal(typedTime('маргааш 14'), null);
  assert.equal(typedName('  Болд  '), 'Болд');
  assert.equal(typedName('12345'), null);
  assert.equal(typedName('Б'.repeat(61)), null);
  assert.ok(looksLikeName('Болд') && looksLikeName('Б. Сараа'));
  assert.ok(!looksLikeName('Урьдчилгаа хэд вэ?') && !looksLikeName('би маргааш орой ирж болох уу'));
  assert.ok(sameChoice('маргааш', 'Маргааш'));
  assert.ok(sameChoice('Будаг.', 'Будаг'));
  assert.ok(!sameChoice('Будаг авъя', 'Будаг'));
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test('signed links: each purpose opens only itself; a forged one opens nothing', () => {
  const secret = 'x'.repeat(40);
  const hold = '6f1c1a3e-6b0a-4c37-9d4a-1b2c3d4e5f60';
  const pay = signHold(secret, 'pay', hold);
  assert.equal(verifyHold(secret, 'pay', pay), hold);
  assert.equal(verifyHold(secret, 'callback', pay), null);
  assert.equal(verifyHold('y'.repeat(40), 'pay', pay), null);
  assert.equal(verifyHold(secret, 'pay', `${hold}.${'0'.repeat(32)}`), null);
  assert.equal(verifyHold(secret, 'pay', 'nonsense'), null);
  assert.match(payUrl('https://api.example.com', secret, hold), /^https:\/\/api\.example\.com\/book\/6f1c1a3e-[^.]+\.[0-9a-f]{32}$/u);
  assert.match(callbackUrl('https://api.example.com', secret, hold), /\/api\/booking\/qpay\?t=/u);
  assert.equal(linkSecret('short'), null);
  assert.equal(publicOrigin('http://insecure.example.com'), null);
  assert.equal(publicOrigin('https://api.example.com/path'), 'https://api.example.com');
  assert.equal(eventIdForHold(hold), 'dh6f1c1a3e6b0a4c379d4a1b2c3d4e5f60');
  assert.match(eventIdForHold(hold), /^[0-9a-v]{5,1024}$/u);
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test('every block the flow needs has a draft (or a signed line) whose placeholders fit', () => {
  const w = draftWording();
  assert.deepEqual(missingBlocks(w), []);
  assert.equal(w.blocks.size, BOOKING_BLOCK_KEYS.length);
});

test('nothing is signed yet: a database with no booking blocks keeps the flow off', () => {
  assert.equal(missingBlocks({ source: 'signed', blocks: new Map() }).length, BOOKING_BLOCK_KEYS.length);
  assert.throws(() => say({ source: 'signed', blocks: new Map() }, 'booking_pay'), WordingError);
});

test('every button a customer taps fits Meta\'s 20 characters', () => {
  const w = draftWording();
  const c = cfg();
  const cp = (s: string) => [...s].length;
  for (const k of ['booking_gender_female', 'booking_gender_male', 'booking_gender_child', 'booking_day_today', 'booking_day_tomorrow', 'booking_agree', 'booking_cancel'] as const) {
    assert.ok(cp(say(w, k)) <= QUICK_REPLY_TITLE_MAX, k);
  }
  // «{level} — аль ч үсчин» fits for «Мастер» (20) and not for «1-р зэрэг» (23): that «any» button
  // is left out (stylistOffers), never cut. A shorter line is the founder's call.
  assert.equal(cp(say(w, 'booking_any_of_level', { level: 'Мастер' })), 20);
  assert.ok(cp(say(w, 'booking_any_of_level', { level: '1-р зэрэг' })) > QUICK_REPLY_TITLE_MAX);
  // The longest date label: a two-digit month and day and the longest weekday.
  assert.ok(cp(say(w, 'booking_date', { month: '12', day: '28', weekday: 'Мягмар' })) <= QUICK_REPLY_TITLE_MAX);
  for (const s of c.stylists) {
    const level = c.levels.find((l) => l.key === s.level);
    assert.ok(level !== undefined && cp(stylistButton(s, level)) <= QUICK_REPLY_TITLE_MAX);
  }
});

test('«any stylist of a level» is offered only when its approved words fit a button, never cut', async () => {
  const { stylistOffers } = await import('./turn.ts');
  const base = testConfig();
  const two = parseBookingConfig(testConfig({ stylists: [...(base['stylists'] as unknown[]),
    { name: 'Батзаяа', label: 'Батзаяа', level: 'first', gender: 'female', calendar_id: 'c-first-2' }] }));
  assert.ok(two.ok);
  const offers = stylistOffers({ wording: draftWording() } as never, two.config, 'female');
  assert.ok(offers.some((o) => o.v === 'any:master'), '«Мастер — аль ч үсчин» fits (20)');
  assert.ok(!offers.some((o) => o.v === 'any:first'), '«1-р зэрэг — аль ч үсчин» (23) is left out');
  assert.ok(offers.some((o) => o.t === 'Батзаяа · 1-р зэрэг') && offers.every((o) => [...o.t].length <= QUICK_REPLY_TITLE_MAX));
});

test('day labels: today, tomorrow, then «10 сарын 5, Даваа»', () => {
  const w = draftWording();
  const now = ub('2026-10-03', 9);
  assert.equal(dayLabel(w, '2026-10-03', now, TZ), say(w, 'booking_day_today'));
  assert.equal(dayLabel(w, '2026-10-04', now, TZ), say(w, 'booking_day_tomorrow'));
  assert.equal(dayLabel(w, '2026-10-05', now, TZ), say(w, 'booking_date', { month: '10', day: '5', weekday: 'Даваа' }));
  // Late at night in Ulaanbaatar is still the same local day.
  assert.equal(dayLabel(w, '2026-10-03', ub('2026-10-03', 23, 50), TZ), say(w, 'booking_day_today'));
});

test('display name «Brand — Branch» gives the branch label', () => {
  assert.equal(branchLabel('Tara Salon — Яармаг'), 'Яармаг');
  assert.equal(branchLabel('Tara Salon — Парк Од'), 'Парк Од');
  assert.equal(branchLabel('DalaTech'), 'DalaTech');
});

// ---------------------------------------------------------------------------
// The deposit page
// ---------------------------------------------------------------------------

test('the page shows the QR, the bank buttons and the countdown, and refuses unsafe links', () => {
  const w = draftWording();
  const summary = { tenantName: 'Tara Salon — Яармаг', service: 'Будаг', stylist: 'Оюунаа (Мастер)', when: 'Маргааш, 14:00', amountMnt: 20000, isTest: false };
  const out = renderBookingPage({
    kind: 'code', summary, qrImage: Buffer.from('png').toString('base64'), secondsLeft: 299,
    urls: [{ name: 'Khan bank', logo: 'https://qpay.mn/k.png', link: 'khanbank://q?x=1' }, { name: 'Evil', logo: '', link: 'javascript:alert(1)' }],
  }, w);
  assert.equal(out.status, 200);
  assert.match(out.html, /20,000₮/u);
  assert.match(out.html, /khanbank:\/\/q\?x=1/u);
  assert.doesNotMatch(out.html, /javascript:alert/u);
  assert.ok(out.html.includes(say(w, 'billing_page_qr_valid', { time: clock(299) })));
  assert.ok(out.html.includes('Tara Salon — Яармаг'));
  assert.ok(!out.html.includes(say(w, 'booking_test_prefix')));
  const test = renderBookingPage({ kind: 'paid', summary: { ...summary, isTest: true } }, w);
  assert.ok(test.html.includes(say(w, 'booking_page_paid')));
  assert.ok(test.html.includes(say(w, 'booking_test_prefix')));
  const unsigned = renderBookingPage({ kind: 'ended', summary }, { source: 'signed', blocks: new Map() });
  assert.equal(unsigned.status, 503);
});

// ---------------------------------------------------------------------------
// The two clients, against the fakes
// ---------------------------------------------------------------------------

test('Google Calendar: the signed service-account token, busy, insert 409, patch, delete', async () => {
  const g = new FakeGoogle([TEST_CALENDARS.master1]);
  const cal = googleCalendar({ email: g.email, privateKey: g.privateKey }, g.fetch);
  const at = new Date('2026-10-04T06:00:00Z');
  g.websiteBooks(TEST_CALENDARS.master1, at, 60);
  const busy = await cal.busy([TEST_CALENDARS.master1], new Date('2026-10-04T00:00:00Z'), new Date('2026-10-05T00:00:00Z'));
  assert.ok(busy.ok);
  assert.equal(busy.ok && busy.busy.get(TEST_CALENDARS.master1)?.length, 1);
  const id = eventIdForHold('6f1c1a3e-6b0a-4c37-9d4a-1b2c3d4e5f60');
  const ev = { id, summary: 's', description: 'd', start: at, end: new Date(at.getTime() + 3600_000), transparency: 'opaque' as const, privateProps: {} };
  assert.deepEqual(await cal.insert(TEST_CALENDARS.master1, ev), { ok: true });
  assert.deepEqual(await cal.insert(TEST_CALENDARS.master1, ev), { ok: false, outcome: 'exists' });
  assert.deepEqual(await cal.remove(TEST_CALENDARS.master1, id), { ok: true });
  assert.deepEqual(await cal.remove(TEST_CALENDARS.master1, id), { ok: true }); // already gone counts as done
  // A deleted event comes back on patch (status confirmed), as Google's does.
  assert.deepEqual(await cal.patch(TEST_CALENDARS.master1, id, ev), { ok: true });
  assert.equal(g.live(TEST_CALENDARS.master1).length, 2);
  assert.deepEqual(await cal.patch(TEST_CALENDARS.master1, 'dhnothere000', ev), { ok: false, outcome: 'gone' });
  const list = await cal.events(TEST_CALENDARS.master1, at, new Date(at.getTime() + 3600_000), TZ);
  assert.ok(list.ok && list.events.length === 2 && list.events.every((e) => e.blocks));
  // Only one token fetch for the whole port.
  assert.equal(g.calls.filter((c) => c.includes('/token')).length, 1);
});

test('Google Calendar: a calendar Google cannot read is a failure, never an empty one', async () => {
  const g = new FakeGoogle([TEST_CALENDARS.master1]);
  g.brokenCalendars.add(TEST_CALENDARS.master1);
  const cal = googleCalendar({ email: g.email, privateKey: g.privateKey }, g.fetch);
  const busy = await cal.busy([TEST_CALENDARS.master1], new Date(), new Date(Date.now() + 3600_000));
  assert.equal(busy.ok, false);
  const wrongKey = googleCalendar({ email: g.email, privateKey: new FakeGoogle([]).privateKey }, g.fetch);
  const refused = await wrongKey.busy([TEST_CALENDARS.master1], new Date(), new Date(Date.now() + 3600_000));
  assert.equal(refused.ok, false);
});

test('QPay: the tenant\'s merchant and mcc go on the invoice; billing still sends its own 8299', async () => {
  const q = new FakeQpay();
  const merchant = { username: 'qpay-user', password: 'qpay-pass', terminalId: 'DALATECH_AI', merchantId: 'tara-merchant', bankCode: '040000', bankAccount: 'ACC', accountName: 'Holder' };
  const tara = quickQr({ ...merchant, mccCode: '7230' }, q.fetch);
  const t = await tara.token();
  assert.ok(t.ok);
  const inv = await tara.createInvoice(t.ok ? t.token : '', { amountMnt: 20000, description: 'Болд - 99112233', callbackUrl: 'https://x/cb' });
  assert.ok(inv.ok);
  const stored = q.invoices.get(inv.ok ? inv.invoiceId : '');
  assert.equal(stored?.merchantId, 'tara-merchant');
  assert.equal(stored?.mcc, '7230');
  assert.equal(stored?.amount, 20000);
  const billing = quickQr(merchant, q.fetch);
  const inv2 = await billing.createInvoice(t.ok ? t.token : '', { amountMnt: 100, description: 'DalaTech', callbackUrl: 'https://x/cb' });
  assert.equal(q.invoices.get(inv2.ok ? inv2.invoiceId : '')?.mcc, QPAY_MCC_CODE);
  // Paid, then read back through the real reader.
  const pid = q.pay(inv.ok ? inv.invoiceId : '');
  const check = await tara.checkPayment(t.ok ? t.token : '', inv.ok ? inv.invoiceId : '');
  assert.ok(check.ok && check.determined && check.payments.length === 1 && check.payments[0]?.key === `qpay:${pid}` && check.payments[0]?.amountMnt === 20000);
});

// ---------------------------------------------------------------------------
// The wire: quick replies and the pay button
// ---------------------------------------------------------------------------

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (_u: unknown, init: unknown) => {
    bodies.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ recipient_id: 'p', message_id: `mid.${bodies.length}` }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, impl };
}
const base = { pageId: '100000000000001', recipientId: '7654321', token: 'T', graphVersion: 'v21.0' };

test('quick replies go under the message; without them the wire is exactly as before', async () => {
  const a = capture();
  await sendMessage({ ...base, text: 'Сайн уу', fetchImpl: a.impl });
  assert.deepEqual(a.bodies[0], { messaging_type: 'RESPONSE', recipient: { id: '7654321' }, message: { text: 'Сайн уу' } });
  const b = capture();
  await sendMessage({ ...base, text: 'Аль өдөр?', quickReplies: [{ title: 'Маргааш', payload: 'bk:day:0' }], fetchImpl: b.impl });
  assert.deepEqual((b.bodies[0]?.['message'] as Record<string, unknown>)['quick_replies'], [{ content_type: 'text', title: 'Маргааш', payload: 'bk:day:0' }]);
});

test('the pay link becomes a «Төлбөр төлөх» button with the cancel quick reply under it', async () => {
  const c = capture();
  await sendMessageParts({
    ...base, fetchImpl: c.impl, linkButtons: true, linkButtonTitle: 'Төлбөр төлөх',
    text: 'Будаг, Оюунаа (Мастер)\nДоорх товчоор QPay-ээр төлнө үү. https://api.example.com/book/abc.def',
    quickReplies: [{ title: 'Цуцлах', payload: 'bk:cancel' }],
  });
  assert.equal(c.bodies.length, 1);
  const msg = c.bodies[0]?.['message'] as Record<string, unknown>;
  const payload = (msg['attachment'] as Record<string, unknown>)['payload'] as Record<string, unknown>;
  assert.deepEqual(payload['buttons'], [{ type: 'web_url', url: 'https://api.example.com/book/abc.def', title: 'Төлбөр төлөх' }]);
  assert.doesNotMatch(String(payload['text']), /https:/u);
  assert.deepEqual(msg['quick_replies'], [{ content_type: 'text', title: 'Цуцлах', payload: 'bk:cancel' }]);
});

test('a tapped quick reply carries its payload into the inbound message', () => {
  const r = extractInboundMessages({ id: '1', time: 1, messaging: [{
    sender: { id: 'psid-1' }, recipient: { id: '1' }, timestamp: 1788480000000,
    message: { mid: 'mid.9', text: 'Маргааш', quick_reply: { payload: 'bk:day:1' } },
  }] });
  assert.equal(r.messages[0]?.quickReplyPayload, 'bk:day:1');
  const plain = extractInboundMessages({ id: '1', time: 1, messaging: [{
    sender: { id: 'psid-1' }, recipient: { id: '1' }, timestamp: 1788480000000, message: { mid: 'mid.8', text: 'Сайн уу' },
  }] });
  assert.equal('quickReplyPayload' in (plain.messages[0] ?? {}), false);
});

test('branches: same services, deposits, agreement and merchant; never one calendar in two', async () => {
  const { compareBranches } = await import('./branches.ts');
  const base = parseBookingConfig(testConfig());
  assert.ok(base.ok);
  const park = parseBookingConfig(testConfig({ stylists: [{ name: 'Парк', level: 'master', gender: 'female', calendar_id: 'park@group.calendar.google.com' }] }));
  assert.ok(park.ok);
  assert.deepEqual(compareBranches([{ slug: 'a', config: base.config }, { slug: 'b', config: park.config }]), []);
  const cheaper = parseBookingConfig(testConfig({ levels: [{ key: 'master', label: 'Мастер', deposit_mnt: 15000 }, { key: 'first', label: '1-р зэрэг', deposit_mnt: 10000 }] }));
  assert.ok(cheaper.ok);
  const f = compareBranches([{ slug: 'a', config: base.config }, { slug: 'b', config: cheaper.config }]);
  assert.ok(f.some((x) => x.kind === 'drift' && /deposits/u.test(x.detail)));
  assert.ok(f.some((x) => x.kind === 'shared_calendar'));
  // Who serves a children's service is part of the one rule set.
  const swapped = parseBookingConfig(testConfig({ stylists: [{ name: 'Парк', level: 'master', gender: 'female', calendar_id: 'park@group.calendar.google.com' }],
    child_services: [{ name: 'Хүүхдийн тайралт (охин)', label: 'Охин', gender: 'male', minutes: 60 }, { name: 'Хүүхдийн тайралт (хүү)', label: 'Хүү', gender: 'male', minutes: 60 }] }));
  assert.ok(swapped.ok);
  assert.ok(compareBranches([{ slug: 'a', config: base.config }, { slug: 'b', config: swapped.config }]).some((x) => /children/u.test(x.detail)));
});
