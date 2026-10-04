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
import { eventIdForHold, googleCalendar, isExpiredWebsiteHold, otherBlocking, withoutExpiredHolds, type CalendarEvent } from './calendar.ts';
import { allServices, bookingEnvMode, choiceKey, customerMode, depositFor, parseBookingConfig, QUICK_REPLY_TITLE_MAX, stylistButton } from './config.ts';
import { platformQpayLogin, qpayPortFor } from './live.ts';
import { branchLabel } from './store.ts';
import { callbackUrl, linkSecret, payUrl, publicOrigin, signHold, verifyHold } from './links.ts';
import { clock, renderBookingPage } from './page.ts';
import { freeStarts, isFree, openDays } from './slots.ts';
import { draftWording, FakeGoogle, FakeQpay, ruleBranches, taraConfig, taraRules, TEST_CALENDARS, testConfig } from './testkit.ts';

/** The rules file's two branches by place (first: Яармаг, second: Парк Од), never by a slug literal. */
const [YA, PO] = ruleBranches() as [string, string];
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
  // The founder's deposits (2026-10-03).
  assert.deepEqual(c.levels.map((l) => [l.key, l.label, l.depositMnt]), [['special', 'SPECIAL', 20000], ['master', 'Мастер', 20000], ['first', '1-р зэрэг', 10000]]);
});

test('Tara\'s rules: the current price list with the 62 confirmed minutes, nothing old, both branches alike', async () => {
  const { compareBranches } = await import('./branches.ts');
  const ya = parseBookingConfig(taraConfig(YA));
  const po = parseBookingConfig(taraConfig(PO));
  assert.ok(ya.ok && po.ok);
  const all = allServices(ya.config);
  assert.equal(all.length, 62, 'every service of the 2026-10-01 price list, once');
  const min = (n: string) => all.find((s) => s.name === n)?.minutes;
  assert.equal(min('Эмэгтэй засалт — Тайралт том хүн /SPECIAL/'), 75);
  assert.equal(min('Эмэгтэй засалт — Тайралт том хүн /МАСТЕР/'), 60);
  assert.equal(min('Эмэгтэй засалт — Тайралт том хүн /1-р зэрэг/'), 60);
  assert.equal(min('Эмэгтэй засалт — Тайралт хүүхэд'), 45);
  assert.equal(min('Эмэгтэй засалт — Тайралт /чёлк/'), 15);
  assert.equal(min('Эмэгтэй будаг — TARA BLEND (Урт)'), 300);
  // The website's old menu is gone from the booking: never mixed in.
  for (const old of ['Оффис колор', 'Омбре / Колор', 'CMC тэжээл', 'Энгийн засалт', 'Будаг', 'Хими арчилгаа']) {
    assert.ok(!all.some((s) => s.name === old || s.label === old), `${old} is not bookable`);
  }
  assert.deepEqual(ya.config.childServices.map((s) => [s.label, s.gender, s.minutes]), [['Охин', 'female', 45], ['Эрэгтэй 0–13 нас', 'male', 30], ['Эрэгтэй 14–18 нас', 'male', 45]]);
  // Names: the founder's short Latin names, by branch; Otgonjargal back at Яармаг, 1-р зэрэг (2026-10-04).
  assert.deepEqual(ya.config.stylists.map((s) => `${s.label}:${s.level}:${s.gender}`), ['Oyunaa:special:female', 'Badamaa:master:female', 'Uyanga:first:female', 'Zaya:first:female', 'Chimgee:first:female', 'Otgonjargal:first:female', 'Anand:master:male']);
  assert.deepEqual(po.config.stylists.map((s) => `${s.label}:${s.level}:${s.gender}`), ['Boloroo:special:female', 'Saraa:master:female', 'Tomoo:master:female', 'Bulgaa:master:female', 'Enhuush:master:female', 'Chimegee:master:female', 'Tuchku:master:male']);
  // Every name a customer sees is Latin; Cyrillic only as a typed alias, never shown.
  for (const s of [...ya.config.stylists, ...po.config.stylists]) assert.match(`${s.name} ${s.label}`, /^[A-Za-z ]+$/u); // ascii-safe: proves the shown names are Latin only (Cyrillic must NOT match)
  // Typed-only aliases: the founder's approved «Үсчдийн нэр» spellings (2026-10-04), «Отгоо» and
  // Парк Од's included, exactly as approved (PR #284's drafts: file 2 and file 3 §4b).
  type Typed = { stylists: { label: string; aliases: string[] }[] };
  const aliasesOf = (c: Typed) => Object.fromEntries(c.stylists.map((s) => [s.label, s.aliases]));
  assert.deepEqual(aliasesOf(ya.config)['Otgonjargal'], ['Отгонжаргал', 'Отгоо', 'Otgonzargal']);
  assert.deepEqual(aliasesOf(po.config), {
    Boloroo: ['Болороо', 'Болор'], Saraa: ['Сараа'], Tomoo: ['Томоо', 'Төмөө'], Bulgaa: ['Булгаа'],
    Enhuush: ['Энхүүш'], Chimegee: ['Чимэгээ'], Tuchku: ['Тучку', 'Түчкү'],
  });
  // «No typed name picks two stylists» is checked per branch: each branch is its own tenant and
  // config, so a typed name only ever picks within that branch. Across the branches no name or
  // alias is shared either: «Чимгээ» is Яармаг's Chimgee, never Парк Од's Chimegee («Чимэгээ»).
  const typedKeys = (c: Typed) => new Set(c.stylists.flatMap((s) => [s.label, ...s.aliases]).map(choiceKey));
  const poKeys = typedKeys(po.config);
  assert.deepEqual([...typedKeys(ya.config)].filter((k) => poKeys.has(k)), [], 'no typed name is in both branches');
  // Level words: «1-р зэргийн үсчин», never «1-р зэрэг үсчин», anywhere in the rules or the drafts.
  assert.ok(!/зэрэг үсчин/u.test(JSON.stringify(taraRules())));
  for (const [k, v] of draftWording().blocks) assert.ok(!/зэрэг үсчин/u.test(v), k);
  assert.equal(po.config.branchLabel, 'Парк Од');
  // Two branches: one rule set, their own calendars and payout accounts (one merchant).
  assert.deepEqual(compareBranches([{ slug: YA, config: ya.config }, { slug: PO, config: po.config }]), []);
});

test('a config missing anything that touches money or a calendar is refused, never partly on', () => {
  const refuse = (o: Record<string, unknown>, why: RegExp) => {
    const p = parseBookingConfig(testConfig(o));
    assert.equal(p.ok, false);
    assert.match(p.ok ? '' : p.detail, why);
  };
  // Дали states no deposit terms in chat: a row still carrying the sentence is refused, not ignored.
  refuse({ agreement_text: 'Урьдчилгаа төлбөр …' }, /agreement_text is gone/);
  refuse({ qpay: undefined }, /qpay/);
  refuse({ qpay: { merchant_id: 'm', mcc_code: '72', bank_accounts: [] } }, /mcc_code/);
  refuse({ qpay: { merchant_id: 'not-connected', mcc_code: '7230', bank_accounts: [] } }, /never a partial qpay/);
  refuse({ qpay: { merchant_id: 'm', mcc_code: '7230', bank_accounts: [] } }, /exactly one account/);
  refuse({ qpay: { merchant_id: 'm', mcc_code: '7230', bank_accounts: [{ bank_code: '1', account_number: '2', account_name: 'x' }], login: 'PARKOD' } }, /qpay\.login is not a setting/);
  refuse({ levels: [{ key: 'master', label: 'Мастер', deposit_mnt: 0 }] }, /deposit_mnt/);
  refuse({ stylists: [{ name: 'A', level: 'master', gender: 'x', calendar_id: 'c' }] }, /gender/);
  refuse({ stylists: [{ name: 'A', level: 'nope', gender: 'female', calendar_id: 'c' }] }, /not a listed level/);
  refuse({ stylists: [{ name: 'A', level: 'master', gender: 'female' }] }, /calendar_id/);
  // A typed name must pick one stylist: an alias that is another stylist's name or alias is refused.
  refuse({ stylists: [{ name: 'Zaya', level: 'master', gender: 'female', calendar_id: 'c1', aliases: ['Заяа'] }, { name: 'Zayaa', level: 'master', gender: 'female', calendar_id: 'c2', aliases: ['заяа'] }] }, /would name both/);
  refuse({ stylists: [{ name: 'Zaya', level: 'master', gender: 'female', calendar_id: 'c1', aliases: ['Uyanga'] }, { name: 'Uyanga', level: 'master', gender: 'female', calendar_id: 'c2' }] }, /would name both/);
  refuse({ stylists: [{ name: 'Zaya', level: 'master', gender: 'female', calendar_id: 'c1', aliases: [''] }] }, /aliases/);
  // Compared as the flow compares typed text: quotes and end punctuation do not make a new name.
  refuse({ stylists: [{ name: 'Zaya', level: 'master', gender: 'female', calendar_id: 'c1', aliases: ['Заяа'] }, { name: 'Uyanga', level: 'master', gender: 'female', calendar_id: 'c2', aliases: ['«Заяа»'] }] }, /would name both/);
  refuse({ stylists: [{ name: 'Zaya', level: 'master', gender: 'female', calendar_id: 'c1', aliases: ['«»'] }] }, /only punctuation/);
  refuse({ stylists: [
    { name: 'A', level: 'master', gender: 'female', calendar_id: 'c' },
    { name: 'B', level: 'master', gender: 'female', calendar_id: 'c' },
  ] }, /calendar_id is used twice/);
  refuse({ entry_matchers: [{ mode: 'contains_stem', stems: ['ц'] }] }, /entry_matchers\[0\]/);
  refuse({ entry_matchers: [] }, /entry_matchers/);
  refuse({ service_groups: [{ label: 'Үйлчилгээ', services: [{ name: 'Маш урт нэртэй үйлчилгээний нэр', minutes: 60 }] }] }, /longer than 20/);
  refuse({ service_groups: [{ label: 'Үйлчилгээ', services: [{ name: 'A', minutes: 60, level: 'nope' }] }] }, /not a listed level/);
  refuse({ service_groups: [{ label: 'Үйлчилгээ', audience: 'child', services: [{ name: 'A', minutes: 60 }] }] }, /audience/);
  refuse({ service_groups: [{ label: 'Үйлчилгээ', services: [{ name: 'A', minutes: 60 }, { name: 'B', label: 'A', minutes: 60 }] }] }, /two buttons read «A»/);
  refuse({ service_groups: [{ label: 'Үйлчилгээ', services: [{ name: 'A', label: 'Урт', family: 'Хими', minutes: 60 }, { name: 'B', label: 'Урт', family: 'Хими', minutes: 60 }] }] }, /two «Урт»/);
  refuse({ service_groups: [{ label: 'Үйлчилгээ', services: [{ name: 'A', family: 'Маш урт нэртэй гэр бүлийн нэр', minutes: 60 }] }] }, /family/);
  const labelled = parseBookingConfig(testConfig({ service_groups: [{ label: 'Үйлчилгээ', services: [{ name: 'Үйлчилгээ — CICA үсний гүний эмчилгээ', label: 'CICA эмчилгээ', minutes: 90 }] }] }));
  assert.ok(labelled.ok && labelled.config.serviceGroups[0]?.services[0]?.label === 'CICA эмчилгээ', 'a long name with a short button label is fine');
  refuse({ stylists: [{ name: 'A', label: 'Хэтэрхий урт нэртэй үсчин хүн', level: 'master', gender: 'female', calendar_id: 'c' }] }, /longer than 20/);
  const long = parseBookingConfig(testConfig({ stylists: [{ name: 'Oyunchimeg', level: 'first', gender: 'female', calendar_id: 'c' }] }));
  assert.ok(long.ok && stylistButton(long.config.stylists[0] as never, long.config.levels[2] as never) === 'Oyunchimeg',
    'a name too long to carry its level shows the name alone');
  refuse({ qr_minutes: 5 }, /qr_minutes/);
  // Children's services: who serves each is the tenant's rule, never guessed; minutes required.
  refuse({ child_services: [{ name: 'Хүүхэд', label: 'Охин', minutes: 60 }] }, /child_services\[0\]\.gender/);
  refuse({ child_services: [{ name: 'Хүүхэд', label: 'Охин', gender: 'female' }] }, /minutes/);
  refuse({ gender_rule: false, child_services: [{ name: 'Хүүхэд', label: 'Охин', gender: 'female', minutes: 60 }] }, /gender_rule|audience/);
  refuse({ child_services: [{ name: 'Үйлчилгээ — Хуйх цэвэрлэгээ', label: 'Охин', gender: 'female', minutes: 60 }] }, /listed twice/);
});

test('«not connected»: a branch being prepared parses, books nobody, and never borrows', () => {
  const none = parseBookingConfig(taraConfig(PO, { qpay: 'not-connected' }, { calendars: false }));
  assert.ok(none.ok, none.ok ? '' : none.detail);
  assert.equal(none.config.qpay, null);
  assert.ok(none.config.stylists.every((s) => s.calendarId === null));
  assert.equal(none.config.notConnected.length, 8, 'seven calendars and the payout account');
  for (const env of ['test', 'live'] as const) {
    assert.deepEqual(customerMode(env, 'live', none.config, 'psid-tester'), { on: false }, 'not even a tester');
  }
  // One calendar missing is enough.
  const one = parseBookingConfig(taraConfig(PO, { stylists: (taraConfig(PO)['stylists'] as Record<string, unknown>[]).map((s, i) => (i === 3 ? { ...s, calendar_id: 'not-connected' } : s)) }));
  assert.ok(one.ok && one.config.notConnected.join() === 'Bulgaa\'s calendar');
  assert.deepEqual(customerMode('live', 'live', one.config, 'psid-x'), { on: false });
  const ready = parseBookingConfig(taraConfig(PO));
  assert.ok(ready.ok && ready.config.notConnected.length === 0);
  assert.deepEqual(customerMode('live', 'live', ready.config, 'psid-x'), { on: true, isTest: false });
});

test('QPay login: every tenant invoices on the platform\'s one login (no per-tenant login)', () => {
  const env = { QPAY_USERNAME: 'p', QPAY_PASSWORD: 'pp', QPAY_TERMINAL_ID: 'DALATECH_AI' };
  assert.deepEqual(platformQpayLogin(env), { ok: true, login: { username: 'p', password: 'pp', terminalId: 'DALATECH_AI' } });
  assert.deepEqual(platformQpayLogin({ QPAY_USERNAME: 'p' }), { ok: false, missing: ['QPAY_PASSWORD', 'QPAY_TERMINAL_ID'] });
  const po = parseBookingConfig(taraConfig(PO));
  assert.ok(po.ok && po.config.qpay !== null);
  assert.equal(qpayPortFor(po.config.qpay, undefined, {}), null, 'no platform login: no port, never anything else');
});

test('Парк Од\'s QPay invoice is Яармаг\'s exactly, but for bank_accounts (same merchant, mcc and login; founder 2026-10-04)', async () => {
  const q = new FakeQpay();
  const env = { QPAY_USERNAME: q.username, QPAY_PASSWORD: q.password, QPAY_TERMINAL_ID: q.terminal };
  const ya = parseBookingConfig(taraConfig(YA));
  const po = parseBookingConfig(taraConfig(PO));
  assert.ok(ya.ok && po.ok && ya.config.qpay !== null && po.config.qpay !== null);
  q.registerMerchant(q.username, ya.config.qpay.merchantId);
  /** Every request one branch's port sends for one token and one invoice, as sent. */
  const wire = async (m: NonNullable<typeof ya.config.qpay>) => {
    const sentReqs: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const spy: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      sentReqs.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return q.fetch(input, init);
    };
    const port = qpayPortFor(m, spy, env);
    assert.ok(port !== null);
    const t = await port.token();
    assert.ok(t.ok);
    const inv = await port.createInvoice(t.token, { amountMnt: 20000, description: 'Номин - 88990011', callbackUrl: 'https://api.example.com/api/booking/qpay?t=x' });
    assert.ok(inv.ok);
    return sentReqs;
  };
  const a = await wire(ya.config.qpay);
  const b = await wire(po.config.qpay);
  assert.equal(a.length, 2);
  assert.deepEqual(b[0], a[0], 'the token request: the same login and terminal');
  assert.equal(b[1]?.url, a[1]?.url);
  assert.equal(b[1]?.auth, a[1]?.auth);
  const { bank_accounts: aBank, ...aRest } = a[1]?.body ?? {};
  const { bank_accounts: bBank, ...bRest } = b[1]?.body ?? {};
  assert.deepEqual(bRest, aRest, 'merchant_id, mcc_code, amount, currency, description, callback: identical');
  assert.equal(aRest['merchant_id'], ya.config.qpay.merchantId);
  assert.notDeepEqual(bBank, aBank, 'only the bank account differs');
  const pb = po.config.qpay.bankAccounts[0];
  assert.deepEqual(bBank, [{ account_bank_code: pb?.bankCode, account_number: pb?.accountNumber, account_name: pb?.accountName, is_default: true }]);
});

test('website holds: an expired one is free, a live one busy; the earlier of two holds wins', () => {
  const at = new Date('2026-10-04T06:00:00Z');
  const hour = new Date(at.getTime() + 3600_000);
  const now = new Date('2026-10-04T01:00:00Z');
  const ev = (id: string, created: number, hold: CalendarEvent['hold'], start = at, end = hour): CalendarEvent =>
    ({ id, cancelled: false, blocks: true, start, end, created: new Date(created), hold });
  const site = (expiresAt: Date | null, placed: number | null = null) => ({ kind: 'website' as const, expiresAt, placedAt: placed === null ? null : new Date(placed) });
  const soon = new Date(now.getTime() + 60_000);
  const expired = ev('sh1', 1, site(new Date(now.getTime() - 1)));
  const live = ev('sh2', 1, site(soon));
  const unreadable = ev('sh3', 1, site(null));
  assert.ok(isExpiredWebsiteHold(expired, now) && !isExpiredWebsiteHold(live, now) && !isExpiredWebsiteHold(unreadable, now));
  const from = new Date('2026-10-04T00:00:00Z');
  const to = new Date('2026-10-05T00:00:00Z');
  assert.deepEqual(withoutExpiredHolds([{ start: at, end: hour }], [expired], now, from, to), [], 'an expired website hold is free');
  // Free/busy merged an expired hold with a booking that overlaps it: the booking stays busy.
  const booking = ev('qb1', 2, null, new Date(at.getTime() + 1800_000), new Date(hour.getTime() + 1800_000));
  const merged = withoutExpiredHolds([{ start: at, end: booking.end }], [expired, booking], now, from, to);
  assert.deepEqual(merged.map((i) => [i.start.toISOString(), i.end.toISOString()]), [[booking.start.toISOString(), booking.end.toISOString()]]);
  assert.equal(withoutExpiredHolds([{ start: at, end: hour }], [live], now, from, to).length, 1, 'a live website hold is busy');
  // Our hold (created at 10) against others in its time.
  const ours = ev('dhours', 10, { kind: 'chat' });
  assert.equal(otherBlocking([ours, ev('sh9', 5, site(soon))], 'dhours', at, hour, now).length, 1, 'an earlier website hold wins: we yield');
  assert.equal(otherBlocking([ours, ev('sh9', 11, site(soon))], 'dhours', at, hour, now).length, 0, 'a later website hold yields to ours');
  assert.equal(otherBlocking([ours, ev('sh9', 10, site(soon))], 'dhours', at, hour, now).length, 1, 'a tie: we yield (never two winners)');
  // «Placed» is the website's holdPlacedAt (rewritten on a renewal), not the event's created.
  assert.equal(otherBlocking([ours, ev('sh9', 5, site(soon, 11))], 'dhours', at, hour, now).length, 0, 'created earlier, but placed (renewed) after ours: it yields');
  assert.equal(otherBlocking([ours, ev('sh9', 11, site(soon, 5))], 'dhours', at, hour, now).length, 1, 'placed before ours: we yield');
  assert.equal(otherBlocking([ours, ev('qb9', 11, null)], 'dhours', at, hour, now).length, 1, 'a booking always wins, whenever it was written');
  assert.equal(otherBlocking([ours, expired], 'dhours', at, hour, now).length, 0, 'an expired website hold never wins');
  assert.equal(otherBlocking([{ ...ours, created: null }, ev('sh9', 11, site(null))], 'dhours', at, hour, now).length, 1, 'our own time unknown: we yield');
  // Every id this platform writes is a valid Google event id (base32hex: 0-9 and a-v only).
  assert.match(eventIdForHold('6f1c1a3e-6b0a-4c37-9d4a-1b2c3d4e5f60'), /^[0-9a-v]{5,1024}$/u);
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
  assert.equal(depositFor(c, 'special', false), 20000);
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
  // «Аль ч Мастер», «Аль ч 1-р зэрэг» (founder, 2026-10-03): both fit.
  for (const l of c.levels) assert.ok(cp(say(w, 'booking_any_of_level', { level: l.label })) <= QUICK_REPLY_TITLE_MAX, l.label);
  // The longest date label: a two-digit month and day and the longest weekday.
  assert.ok(cp(say(w, 'booking_date', { month: '12', day: '28', weekday: 'Мягмар' })) <= QUICK_REPLY_TITLE_MAX);
  for (const s of c.stylists) {
    const level = c.levels.find((l) => l.key === s.level);
    assert.ok(level !== undefined && cp(stylistButton(s, level)) <= QUICK_REPLY_TITLE_MAX);
  }
});

test('stylist buttons: by level, no level recommended, «Аль ч {level}» only where two may serve; never 1-р зэрэг at Парк Од', async () => {
  const { stylistOffers } = await import('./turn.ts');
  const w = { wording: draftWording() } as never;
  const ya = parseBookingConfig(taraConfig(YA));
  const po = parseBookingConfig(taraConfig(PO));
  assert.ok(ya.ok && po.ok);
  const t = (c: typeof ya, g: 'female' | 'male', level: string | null = null) => stylistOffers(w, (c as { ok: true; config: never }).config, g, level).map((o) => o.t);
  // «Otgonjargal · 1-р зэрэг» is longer than Meta's 20: her button is her name alone.
  assert.deepEqual(t(ya, 'female'), ['Oyunaa · SPECIAL', 'Badamaa · Мастер', 'Аль ч 1-р зэрэг', 'Uyanga · 1-р зэрэг', 'Zaya · 1-р зэрэг', 'Chimgee · 1-р зэрэг', 'Otgonjargal']);
  assert.deepEqual(t(ya, 'female', 'first'), ['Аль ч 1-р зэрэг', 'Uyanga · 1-р зэрэг', 'Zaya · 1-р зэрэг', 'Chimgee · 1-р зэрэг', 'Otgonjargal'], 'the 1-р зэрэг haircut: 1-р зэрэг only, Otgonjargal included');
  assert.deepEqual(t(ya, 'female', 'master'), ['Badamaa · Мастер'], 'the МАСТЕР haircut: never a 1-р зэрэг stylist');
  assert.deepEqual(t(ya, 'male'), ['Anand · Мастер'], 'a man: the branch\'s man only');
  assert.deepEqual(t(po, 'female'), ['Boloroo · SPECIAL', 'Аль ч Мастер', 'Saraa · Мастер', 'Tomoo · Мастер', 'Bulgaa · Мастер', 'Enhuush · Мастер', 'Chimegee · Мастер']);
  assert.deepEqual(t(po, 'male'), ['Tuchku · Мастер']);
  assert.ok(!t(po, 'female').some((x) => x.includes('1-р зэрэг')), 'Парк Од has no 1-р зэрэг: never offered there');
  assert.deepEqual(t(po, 'female', 'first'), [], 'a 1-р зэрэг price line has nobody at Парк Од');
  assert.deepEqual(t(ya, 'female', 'special'), ['Oyunaa · SPECIAL'], 'a SPECIAL price line: SPECIAL only');
  assert.deepEqual(t(ya, 'male', 'special'), [], 'no man is SPECIAL: the men\'s SPECIAL line has nobody');
  // The «any» button says the level and nothing else: no ranking, no «best», no recommendation.
  for (const o of [...t(ya, 'female'), ...t(po, 'female')]) assert.ok(!o.startsWith('Аль ч') || /^Аль ч (SPECIAL|Мастер|1-р зэрэг)$/u.test(o));
  assert.ok([...t(ya, 'female'), ...t(po, 'female')].every((x) => [...x].length <= QUICK_REPLY_TITLE_MAX));
  // A level label too long for «Аль ч …» loses only that button; its stylists stay.
  const long = parseBookingConfig(taraConfig(YA, { levels: [{ key: 'special', label: 'SPECIAL', deposit_mnt: 20000 }, { key: 'master', label: 'Мастер', deposit_mnt: 20000 }, { key: 'first', label: 'Нэгдүгээр зэргийн', deposit_mnt: 10000 }] }));
  assert.ok(long.ok);
  const lo = stylistOffers(w, long.config, 'female', null);
  assert.ok(!lo.some((o) => o.v === 'any:first') && lo.some((o) => o.v === `s:${TEST_CALENDARS.zaya}`));
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
  const g = new FakeGoogle([TEST_CALENDARS.oyunaa]);
  const cal = googleCalendar({ email: g.email, privateKey: g.privateKey }, g.fetch);
  const at = new Date('2026-10-04T06:00:00Z');
  g.websiteBooks(TEST_CALENDARS.oyunaa, at, 60);
  const busy = await cal.busy([TEST_CALENDARS.oyunaa], new Date('2026-10-04T00:00:00Z'), new Date('2026-10-05T00:00:00Z'), TZ);
  assert.ok(busy.ok);
  assert.equal(busy.ok && busy.busy.get(TEST_CALENDARS.oyunaa)?.length, 1);
  const id = eventIdForHold('6f1c1a3e-6b0a-4c37-9d4a-1b2c3d4e5f60');
  const ev = { id, summary: 's', description: 'd', start: at, end: new Date(at.getTime() + 3600_000), transparency: 'opaque' as const, privateProps: {} };
  assert.deepEqual(await cal.insert(TEST_CALENDARS.oyunaa, ev), { ok: true });
  assert.deepEqual(await cal.insert(TEST_CALENDARS.oyunaa, ev), { ok: false, outcome: 'exists' });
  assert.deepEqual(await cal.remove(TEST_CALENDARS.oyunaa, id), { ok: true });
  assert.deepEqual(await cal.remove(TEST_CALENDARS.oyunaa, id), { ok: true }); // already gone counts as done
  // A deleted event comes back on patch (status confirmed), as Google's does.
  assert.deepEqual(await cal.patch(TEST_CALENDARS.oyunaa, id, ev), { ok: true });
  assert.equal(g.live(TEST_CALENDARS.oyunaa).length, 2);
  assert.deepEqual(await cal.patch(TEST_CALENDARS.oyunaa, 'dhnothere000', ev), { ok: false, outcome: 'gone' });
  const list = await cal.events(TEST_CALENDARS.oyunaa, at, new Date(at.getTime() + 3600_000), TZ);
  assert.ok(list.ok && list.events.length === 2 && list.events.every((e) => e.blocks && e.created !== null));
  assert.ok(list.ok && list.events.find((e) => e.id === id)?.hold === null, 'a dh event with no hold state is not a hold (never classified by its id)');
  await cal.patch(TEST_CALENDARS.oyunaa, id, { ...ev, privateProps: { dalaBookingHold: 'h', dalaBookingState: 'hold' } });
  const asHold = await cal.events(TEST_CALENDARS.oyunaa, at, new Date(at.getTime() + 3600_000), TZ);
  assert.ok(asHold.ok && asHold.events.find((e) => e.id === id)?.hold?.kind === 'chat', 'our event in state «hold» reads as our hold');
  await cal.patch(TEST_CALENDARS.oyunaa, id, { ...ev, privateProps: { dalaBookingHold: 'h', dalaBookingState: 'booking' } });
  const asBooking = await cal.events(TEST_CALENDARS.oyunaa, at, new Date(at.getTime() + 3600_000), TZ);
  assert.ok(asBooking.ok && asBooking.events.find((e) => e.id === id)?.hold === null, 'once paid (state «booking»), the same dh id is a booking, not a hold');
  // A website hold, as its contract writes it: busy while it lasts, free once expired.
  const later = new Date(at.getTime() + 3 * 3600_000);
  const wh = g.websiteHolds(TEST_CALENDARS.oyunaa, later, 60, '8800 1122', new Date(Date.now() + 5 * 60_000));
  const seen = await cal.events(TEST_CALENDARS.oyunaa, later, new Date(later.getTime() + 3600_000), TZ);
  assert.ok(seen.ok && seen.events[0]?.id === wh.id && /^sh[0-9a-f]{40}$/u.test(wh.id) && seen.events[0]?.hold?.kind === 'website');
  const day = [new Date('2026-10-04T00:00:00Z'), new Date('2026-10-05T00:00:00Z')] as const;
  const busyLive = await cal.busy([TEST_CALENDARS.oyunaa], day[0], day[1], TZ);
  assert.ok(busyLive.ok && busyLive.busy.get(TEST_CALENDARS.oyunaa)?.some((i) => i.start.getTime() === later.getTime()), 'a live website hold is busy');
  wh.privateProps['holdExpiresAt'] = new Date(Date.now() - 1000).toISOString();
  const busyExpired = await cal.busy([TEST_CALENDARS.oyunaa], day[0], day[1], TZ);
  assert.ok(busyExpired.ok && !busyExpired.busy.get(TEST_CALENDARS.oyunaa)?.some((i) => i.start.getTime() === later.getTime()), 'an expired website hold is free, although free/busy still shows it');
  // Only one token fetch for the whole port.
  assert.equal(g.calls.filter((c) => c.includes('/token')).length, 1);
});

test('Google Calendar: a calendar Google cannot read is a failure, never an empty one', async () => {
  const g = new FakeGoogle([TEST_CALENDARS.oyunaa]);
  g.brokenCalendars.add(TEST_CALENDARS.oyunaa);
  const cal = googleCalendar({ email: g.email, privateKey: g.privateKey }, g.fetch);
  const busy = await cal.busy([TEST_CALENDARS.oyunaa], new Date(), new Date(Date.now() + 3600_000), TZ);
  assert.equal(busy.ok, false);
  const wrongKey = googleCalendar({ email: g.email, privateKey: new FakeGoogle([]).privateKey }, g.fetch);
  const refused = await wrongKey.busy([TEST_CALENDARS.oyunaa], new Date(), new Date(Date.now() + 3600_000), TZ);
  assert.equal(refused.ok, false);
});

test('QPay: the tenant\'s merchant, payout account and mcc go on the invoice; billing still sends its own 8299', async () => {
  const q = new FakeQpay();
  q.registerMerchant('qpay-user', 'tara-merchant');
  const merchant = { username: 'qpay-user', password: 'qpay-pass', terminalId: 'DALATECH_AI', merchantId: 'tara-merchant', bankCode: '040000', bankAccount: 'ACC', accountName: 'Holder' };
  const tara = quickQr({ ...merchant, mccCode: '7230' }, q.fetch);
  const t = await tara.token();
  assert.ok(t.ok);
  const inv = await tara.createInvoice(t.ok ? t.token : '', { amountMnt: 20000, description: 'Болд - 99112233', callbackUrl: 'https://x/cb' });
  assert.ok(inv.ok);
  const stored = q.invoices.get(inv.ok ? inv.invoiceId : '');
  assert.equal(stored?.merchantId, 'tara-merchant');
  assert.deepEqual([stored?.bankCode, stored?.bankAccount, stored?.accountName], ['040000', 'ACC', 'Holder']);
  assert.equal(stored?.mcc, '7230');
  // A merchant not registered under this login: QPay refuses, as it does.
  const stranger = quickQr({ ...merchant, merchantId: 'someone-else', mccCode: '7230' }, q.fetch);
  const refused = await stranger.createInvoice(t.ok ? t.token : '', { amountMnt: 20000, description: 'x', callbackUrl: 'https://x/cb' });
  assert.equal(refused.ok, false);
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

test('branches: same services and deposits; never one calendar or payout account in two (one merchant is fine)', async () => {
  const { compareBranches } = await import('./branches.ts');
  const ya = parseBookingConfig(taraConfig(YA));
  const po = parseBookingConfig(taraConfig(PO));
  assert.ok(ya.ok && po.ok);
  const pair = (b: typeof po) => compareBranches([{ slug: 'a', config: ya.config }, { slug: 'b', config: (b as { ok: true; config: typeof po extends { ok: true; config: infer C } ? C : never }).config }]);
  assert.deepEqual(pair(po), []);
  const cheaper = parseBookingConfig(taraConfig(PO, { levels: [{ key: 'special', label: 'SPECIAL', deposit_mnt: 20000 }, { key: 'master', label: 'Мастер', deposit_mnt: 15000 }, { key: 'first', label: '1-р зэрэг', deposit_mnt: 10000 }] }));
  assert.ok(cheaper.ok && pair(cheaper).some((x) => x.kind === 'drift' && /deposits/u.test(x.detail)));
  const sameCal = parseBookingConfig(taraConfig(PO, { stylists: [{ name: 'Boloroo', level: 'special', gender: 'female', calendar_id: TEST_CALENDARS.oyunaa }] }));
  assert.ok(sameCal.ok && pair(sameCal).some((x) => x.kind === 'shared_calendar'));
  // Each branch is paid into its own account: the same account is a finding. The same merchant is
  // not: Tara's branches share the founder's merchant (2026-10-04), and the test rows already do.
  const yq = (taraConfig(YA)['qpay']) as Record<string, unknown>;
  assert.equal((taraConfig(PO)['qpay'] as Record<string, unknown>)['merchant_id'], yq['merchant_id']);
  const sameAccount = parseBookingConfig(taraConfig(PO, { qpay: { ...(taraConfig(PO)['qpay'] as Record<string, unknown>), bank_accounts: yq['bank_accounts'] } }));
  assert.ok(sameAccount.ok && pair(sameAccount).some((x) => x.kind === 'shared_account' && /payout account/u.test(x.detail)));
  // A branch not connected yet is still compared on its shape.
  const prep = parseBookingConfig(taraConfig(PO, { qpay: 'not-connected' }, { calendars: false }));
  assert.ok(prep.ok && pair(prep).length === 0);
  // Who serves a children's service is part of the one rule set.
  const swapped = parseBookingConfig(taraConfig(PO, {
    child_services: (taraConfig(PO)['child_services'] as Record<string, unknown>[]).map((c) => ({ ...c, gender: 'male' })) }));
  assert.ok(swapped.ok && pair(swapped).some((x) => /children/u.test(x.detail)));
});
