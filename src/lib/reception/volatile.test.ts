import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeClosure, isOpenAt, renderVolatile, type BusinessHours } from './volatile.ts';
import { tenantClock } from '../time/clock.ts';

const UB = 'Asia/Ulaanbaatar';   // UTC+8, no DST

// Sunday=0 … Saturday=6, matching Postgres `extract(dow)`.
const HOURS: BusinessHours[] = [
  { weekday: 0, opens: null, closes: null, closed: true },              // Sunday shut
  { weekday: 1, opens: '10:00:00', closes: '20:00:00', closed: false }, // Monday
  { weekday: 6, opens: '11:00:00', closes: '18:00:00', closed: false }, // Saturday
];

// ---------------------------------------------------------------------------
// The tenant's clock, not UTC's.
// ---------------------------------------------------------------------------

test('THE WEEKDAY IS THE TENANT\'S, NOT UTC\'S', () => {
  // 2026-09-05 is a Saturday. At 23:30 in Ulaanbaatar it is still Saturday; in UTC it is
  // already Sunday, and a salon asked at 23:30 local is being asked about Saturday.
  // Computing this in UTC answers about the wrong day for eight hours of every day.
  const c = tenantClock(new Date('2026-09-05T15:30:00Z'), UB);
  assert.equal(c.date, '2026-09-05');
  assert.equal(c.time, '23:30');
  assert.equal(c.weekday, 6, 'Saturday');

  const utc = tenantClock(new Date('2026-09-05T15:30:00Z'), 'UTC');
  assert.equal(utc.date, '2026-09-05');
  assert.equal(utc.time, '15:30');
});

test('an instant that is tomorrow in UB reports tomorrow', () => {
  const c = tenantClock(new Date('2026-09-05T16:00:00Z'), UB);
  assert.equal(c.date, '2026-09-06');
  assert.equal(c.time, '00:00');
  assert.equal(c.weekday, 0, 'Sunday');
});

test('midnight is 00:00, never 24:00', () => {
  // Some ICU versions return "24" for midnight under hour12:false, which would then
  // compare greater than every closing time and read as open all night.
  assert.equal(tenantClock(new Date('2026-09-05T16:00:00Z'), UB).time, '00:00');
});

// ---------------------------------------------------------------------------
// Open or shut.
// ---------------------------------------------------------------------------

test('inside the window is open; the closing minute itself is not', () => {
  assert.equal(isOpenAt(HOURS, 1, '10:00'), true, 'opening minute is open');
  assert.equal(isOpenAt(HOURS, 1, '19:59'), true);
  assert.equal(isOpenAt(HOURS, 1, '20:00'), false, 'closing minute is shut');
  assert.equal(isOpenAt(HOURS, 1, '09:59'), false);
});

test('a day marked closed is closed whatever the times say', () => {
  assert.equal(isOpenAt(HOURS, 0, '12:00'), false);
});

test('A MISSING DAY IS "WE DO NOT KNOW", NOT "CLOSED"', () => {
  // Telling a customer the salon is shut because a row is absent is a worse answer than
  // saying nothing about it. A provisioning gap must not become a product claim.
  assert.equal(isOpenAt(HOURS, 3, '12:00'), null);
  assert.equal(isOpenAt([{ weekday: 3, opens: null, closes: null, closed: false }], 3, '12:00'), null);
});

test('an overnight window wraps midnight instead of never being open', () => {
  const bar: BusinessHours[] = [{ weekday: 5, opens: '20:00:00', closes: '02:00:00', closed: false }];
  assert.equal(isOpenAt(bar, 5, '21:00'), true);
  assert.equal(isOpenAt(bar, 5, '01:00'), true);
  assert.equal(isOpenAt(bar, 5, '03:00'), false);
  assert.equal(isOpenAt(bar, 5, '19:59'), false);
});

// ---------------------------------------------------------------------------
// Closures.
// ---------------------------------------------------------------------------

const HOLIDAY = {
  startsOn: '2026-09-07', endsOn: '2026-09-09',
  title: 'Наадам', message: 'Баярын өдрүүдэд 9-р сарын 7-9-нд амарна.',
};

test('a closure is inclusive at both ends', () => {
  assert.equal(activeClosure([HOLIDAY], '2026-09-07')?.title, 'Наадам');
  assert.equal(activeClosure([HOLIDAY], '2026-09-09')?.title, 'Наадам');
  assert.equal(activeClosure([HOLIDAY], '2026-09-06'), null);
  assert.equal(activeClosure([HOLIDAY], '2026-09-10'), null);
});

test('A CLOSURE OUTRANKS THE WEEKLY HOURS', () => {
  // A public holiday is exactly the case where the schedule says open and the door is
  // locked. Monday 2026-09-07 is inside the closure and inside Monday's hours.
  const out = renderVolatile({
    now: new Date('2026-09-07T04:00:00Z'), timezone: UB, channel: 'facebook_page',
    hours: HOURS, closures: [HOLIDAY],
  });
  assert.equal(isOpenAt(HOURS, 1, '12:00'), true, 'precondition: the schedule says open');
  assert.equal(out.includes('ХААЛТТАЙ'), true);
  assert.equal(out.includes('НЭЭЛТТЭЙ'), false);
});

test('the closure message is reproduced VERBATIM', () => {
  // It is the tenant's own sentence, written and reviewed by them. Paraphrasing would put
  // words in their mouth about something as concrete as a public holiday.
  const out = renderVolatile({
    now: new Date('2026-09-07T04:00:00Z'), timezone: UB, channel: 'facebook_page',
    hours: HOURS, closures: [HOLIDAY],
  });
  assert.equal(out.includes(HOLIDAY.message), true);
});

test('a closure message in NFD is normalised, because the prompt is NFC everywhere', () => {
  const out = renderVolatile({
    now: new Date('2026-09-07T04:00:00Z'), timezone: UB, channel: 'facebook_page',
    hours: HOURS, closures: [{ ...HOLIDAY, message: 'Ёлка'.normalize('NFD') }],
  });
  assert.equal(out.includes('Ёлка'), true);
});

// ---------------------------------------------------------------------------
// The rendered block.
// ---------------------------------------------------------------------------

test('the block carries the local time, the channel, and the status', () => {
  const out = renderVolatile({
    now: new Date('2026-09-07T04:00:00Z'), timezone: UB, channel: 'facebook_page',
    hours: HOURS, closures: [],
  });
  assert.equal(out.includes('2026-09-07 12:00 (Asia/Ulaanbaatar)'), true);
  assert.equal(out.includes('СУВАГ: facebook_page'), true);
  assert.equal(out.includes('НЭЭЛТТЭЙ'), true);
});

test('with no hours row and no closure the block says NOTHING about being open', () => {
  const out = renderVolatile({
    now: new Date('2026-09-09T04:00:00Z'), timezone: UB, channel: 'facebook_page',
    hours: [], closures: [],
  });
  assert.equal(out.includes('НЭЭЛТТЭЙ'), false);
  assert.equal(out.includes('ХААЛТТАЙ'), false);
  assert.equal(out.includes('ОДООГИЙН ЦАГ'), true, 'the time is still known');
});

test('THE BLOCK IS ITS OWN STRING — it can never touch the cached prefix', () => {
  // The ancestor concatenates its closure section onto the cached base prompt, so anything
  // date-shaped added there invalidates every entry, silently, and the bill roughly
  // triples. Two renders one minute apart must differ, which is exactly why this is
  // returned separately rather than appended.
  const a = renderVolatile({ now: new Date('2026-09-07T04:00:00Z'), timezone: UB, channel: 'c', hours: HOURS, closures: [] });
  const b = renderVolatile({ now: new Date('2026-09-07T04:01:00Z'), timezone: UB, channel: 'c', hours: HOURS, closures: [] });
  assert.notEqual(a, b, 'it varies per request, which is why it must not be cached');
});
