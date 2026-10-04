// The booking pages while in-chat booking cannot run (founder, 2026-10-04): a calm 503 page in
// Mongolian, never a 500, no QR and no held time, and no error line for a setting that is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackRoute, pageContact, payPageRoute, sweepRoute } from './jobs.ts';
import { PAGE_UNAVAILABLE_NO_PHONE, unavailablePage } from './page.ts';
import { signHold } from './links.ts';
import { MissingEnvError } from '../env.ts';

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

test('QPay\'s callback and the sweep answer, never throw, for every way the ports fail', async () => {
  const thrower = async (): Promise<never> => { throw new MissingEnvError('SUPABASE_SECRET_BOOKING'); };
  const cb = await quiet(() => callbackRoute(thrower, 't'));
  assert.equal(cb.value.status, 503, 'QPay retries');
  const cbOff = await quiet(() => callbackRoute(async () => ({ ok: false, detail: 'BOOKING_MODE is off' }), 't'));
  assert.equal(cbOff.value.status, 503);
  assert.deepEqual(cbOff.errors, []);
  const sw = await quiet(() => sweepRoute(thrower, async () => true, '', 's'));
  assert.equal(sw.value.status, 503);
  const swOff = await quiet(() => sweepRoute(async () => ({ ok: false, detail: 'BOOKING_MODE is off' }), async () => true, '', 's'));
  assert.equal(swOff.value.status, 200);
});

test('the branch\'s phone, tappable, when the link checks and the database answers; nobody otherwise', async () => {
  const page = unavailablePage({ tenantName: 'Tara Salon — Яармаг', phones: ['76001888', '91005498'] });
  assert.ok(page.html.includes('<a href="tel:+97676001888">76001888</a>, <a href="tel:+97691005498">91005498</a>'));
  assert.ok(page.html.includes('Tara Salon — Яармаг'));
  // No database, or no link secret, or a link that does not check: no phone, no throw.
  assert.deepEqual(await pageContact(null, SECRET, signHold(SECRET, 'pay', HOLD)), { tenantName: null, phones: [] });
  const broken = { from: () => { throw new Error('network'); } } as never;
  assert.deepEqual(await pageContact(broken, SECRET, signHold(SECRET, 'pay', HOLD)), { tenantName: null, phones: [] });
  assert.deepEqual(await pageContact(broken, null, signHold(SECRET, 'pay', HOLD)), { tenantName: null, phones: [] });
  assert.deepEqual(await pageContact(broken, SECRET, signHold('y'.repeat(40), 'pay', HOLD)), { tenantName: null, phones: [] });
});
