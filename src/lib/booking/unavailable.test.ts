// The booking pages while in-chat booking cannot run (founder, 2026-10-04): a calm 503 page in
// Mongolian, never a 500, no QR and no held time, and no error line for a setting that is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackRoute, pageContact, payPageRoute, sweepRoute } from './jobs.ts';
import { PAGE_UNAVAILABLE_NO_PHONE, unavailableLine, unavailablePage } from './page.ts';
import { signHold } from './links.ts';
import { MissingEnvError } from '../env.ts';
import { liveBookingPorts } from './live.ts';

const HOLD = '11111111-2222-4333-8444-555555555555';
const SECRET = 'x'.repeat(40);

/** Captures console.error/warn/info for one call. */
async function quiet<T>(f: () => Promise<T>): Promise<{ value: T; errors: string[]; others: string[] }> {
  const errors: string[] = []; const others: string[] = [];
  const saved = { error: console.error, warn: console.warn, info: console.info };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { others.push(a.map(String).join(' ')); };
  console.info = (...a: unknown[]) => { others.push(a.map(String).join(' ')); };
  try { return { value: await f(), errors, others }; } finally { Object.assign(console, saved); }
}

test('DONE-TEST: SUPABASE_SECRET_BOOKING UNSET — THE PAGE IS A CALM 503 IN MONGOLIAN, NOT A 500', async () => {
  // The old routes built the ports with a client that throws this before the 503 path ran.
  const r = await quiet(() => payPageRoute(async () => { throw new MissingEnvError('SUPABASE_SECRET_BOOKING'); }, { token: 'x.y', method: 'GET', stateOnly: false }));
  assert.equal(r.value.status, 503);
  assert.ok(r.value.html.includes(PAGE_UNAVAILABLE_NO_PHONE));
  assert.ok(!r.value.html.includes('data:image') && !/unavailable|error|Not found/iu.test(r.value.html));
});

test('switched off or not set up: 503, the calm page, and no error line (info for off, warn for a missing setting)', async () => {
  const off = await quiet(() => payPageRoute(async () => ({ ok: false, detail: 'BOOKING_MODE is off' }), { token: 'x.y', method: 'POST', stateOnly: false }));
  assert.equal(off.value.status, 503);
  assert.equal(off.value.redirect, undefined, 'a POST makes no new code');
  assert.deepEqual(off.errors, []);
  const unset = await quiet(() => payPageRoute(async () => ({ ok: false, detail: 'booking is not configured: GOOGLE_PRIVATE_KEY' }), { token: 'x.y', method: 'GET', stateOnly: false }));
  assert.equal(unset.value.status, 503);
  assert.deepEqual(unset.errors, []);
  assert.ok(unset.others.some((l) => l.includes('booking.page_unavailable')));
});

test('the page\'s poll gets JSON, not the page', async () => {
  const r = await quiet(() => payPageRoute(async () => ({ ok: false, detail: 'BOOKING_MODE is off' }), { token: 'x.y', method: 'GET', stateOnly: true }));
  assert.equal(r.value.status, 503);
  assert.equal(r.value.contentType, 'json');
  assert.deepEqual(JSON.parse(r.value.html), { state: 'unavailable' });
});

test('DONE-TEST: A PAID CALLBACK WHILE BOOKING CANNOT RUN TELLS THE FOUNDER NOW (ONCE), AND QPAY GETS 503', async () => {
  const saved = process.env['BOOKING_LINK_SECRET'];
  process.env['BOOKING_LINK_SECRET'] = SECRET;
  try {
    const told: string[] = [];
    const notify = async (t: string) => { told.push(t); return true; };
    const thrower = async (): Promise<never> => { throw new MissingEnvError('SUPABASE_SECRET_BOOKING'); };
    const token = signHold(SECRET, 'callback', HOLD);
    const a = await quiet(() => callbackRoute(thrower, token, notify));
    assert.equal(a.value.status, 503);
    assert.equal(told.length, 1);
    assert.ok(told[0]?.includes(HOLD) && /PAID/u.test(told[0] ?? '') && /refund/u.test(told[0] ?? ''));
    const b = await quiet(() => callbackRoute(async () => ({ ok: false, detail: 'booking is not configured: SUPABASE_SECRET_BOOKING' }), token, notify));
    assert.equal(b.value.status, 503);
    assert.equal(told.length, 1, 'QPay calling again tells nobody twice');
    // A link that does not check is not a payment of ours: 403, nobody told.
    const forged = await quiet(() => callbackRoute(thrower, signHold('z'.repeat(40), 'callback', '99999999-2222-4333-8444-555555555555'), notify));
    assert.equal(forged.value.status, 403);
    assert.equal(told.length, 1);
    // Telegram down: the error line says nobody was told, and a later call tries again.
    const other = signHold(SECRET, 'callback', '22222222-2222-4333-8444-555555555555');
    const down = await quiet(() => callbackRoute(thrower, other, async () => false));
    assert.ok(down.errors.some((l) => l.includes('booking.callback_unsettled_not_told')));
    await quiet(() => callbackRoute(thrower, other, notify));
    assert.equal(told.length, 2);
  } finally {
    if (saved === undefined) delete process.env['BOOKING_LINK_SECRET']; else process.env['BOOKING_LINK_SECRET'] = saved;
  }
});

test('the sweep answers, never throws: 200 when it cannot run (nothing to retry), 503 on a throw', async () => {
  const sw = await quiet(() => sweepRoute(async () => { throw new MissingEnvError('SUPABASE_SECRET_BOOKING'); }, async () => true, '', 's'));
  assert.equal(sw.value.status, 503);
  const swOff = await quiet(() => sweepRoute(async () => ({ ok: false, detail: 'booking is not configured: SUPABASE_SECRET_BOOKING' }), async () => true, '', 's'));
  assert.equal(swOff.value.status, 200);
});

test('the three approved lines: (a) only when the website booking is KNOWN to work, (b) otherwise, (c) with no branch', () => {
  const base = { tenantName: 'Tara Salon — Яармаг', phones: ['76001888', '91005498'], bookingUrl: 'https://www.matrixecosalon.org/' };
  const a = unavailableLine({ ...base, websiteBookingWorking: true });
  assert.equal(a.kind, 'website');
  assert.equal(a.html, 'Энэ холбоосоор одоогоор цаг захиалах боломжгүй байна. Цагаа эндээс захиална уу: <a href="https://www.matrixecosalon.org/">https://www.matrixecosalon.org/</a> Эсвэл <a href="tel:+97676001888">76001888</a>, <a href="tel:+97691005498">91005498</a> дугаарт залгана уу.');
  const b = unavailableLine({ ...base, websiteBookingWorking: false });
  assert.equal(b.html, 'Онлайн захиалга одоогоор боломжгүй байна. Цаг захиалах бол <a href="tel:+97676001888">76001888</a>, <a href="tel:+97691005498">91005498</a> дугаарт залгана уу.');
  assert.equal(unavailableLine({ ...base, bookingUrl: null, websiteBookingWorking: true }).kind, 'phone', 'no link: never (a)');
  assert.equal(unavailableLine({ ...base, bookingUrl: 'javascript:alert(1)', websiteBookingWorking: true }).kind, 'phone', 'only an https link');
  assert.equal(unavailableLine({ tenantName: null, phones: [], bookingUrl: null, websiteBookingWorking: false }).html, PAGE_UNAVAILABLE_NO_PHONE);
});

test('the branch\'s phone, tappable, when the link checks and the database answers; nobody otherwise', async () => {
  const page = unavailablePage({ tenantName: 'Tara Salon — Яармаг', phones: ['76001888', '91005498'], bookingUrl: null, websiteBookingWorking: false });
  assert.ok(page.html.includes('<a href="tel:+97676001888">76001888</a>, <a href="tel:+97691005498">91005498</a>'));
  assert.ok(page.html.includes('Tara Salon — Яармаг'));
  // No database, or no link secret, or a link that does not check: no phone, no throw.
  assert.deepEqual(await pageContact(null, SECRET, signHold(SECRET, 'pay', HOLD)), { tenantName: null, phones: [], bookingUrl: null, websiteBookingWorking: false });
  const broken = { from: () => { throw new Error('network'); } } as never;
  assert.deepEqual(await pageContact(broken, SECRET, signHold(SECRET, 'pay', HOLD)), { tenantName: null, phones: [], bookingUrl: null, websiteBookingWorking: false });
  assert.deepEqual(await pageContact(broken, null, signHold(SECRET, 'pay', HOLD)), { tenantName: null, phones: [], bookingUrl: null, websiteBookingWorking: false });
  assert.deepEqual(await pageContact(broken, SECRET, signHold('y'.repeat(40), 'pay', HOLD)), { tenantName: null, phones: [], bookingUrl: null, websiteBookingWorking: false });
});

test('switched off stops NEW bookings only: the callback and the sweep still build their ports to finish a paid deposit', async () => {
  const saved = process.env['BOOKING_MODE'];
  delete process.env['BOOKING_MODE'];
  try {
    const db = {} as never;
    assert.deepEqual(await liveBookingPorts(db), { ok: false, detail: 'BOOKING_MODE is off' });
    const settle = await liveBookingPorts(db, { settleWhenOff: true });
    assert.equal(settle.ok, false);
    assert.ok(!settle.ok && settle.detail.startsWith('booking is not configured:'), 'past the switch, to the settings it needs');
  } finally {
    if (saved !== undefined) process.env['BOOKING_MODE'] = saved;
  }
});
