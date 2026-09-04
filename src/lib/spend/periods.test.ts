import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, monthKey } from './periods.ts';

test('the day rolls over on the SALON\'s calendar, not UTC\'s', () => {
  // Mongolia is UTC+8 year-round. A daily ceiling that rolls at UTC midnight rolls at
  // 08:00 local — mid-morning, in the middle of a working day — so a tenant that
  // exhausted "today" would recover mid-appointment.
  assert.equal(dayKey(new Date('2026-09-02T15:59:00Z')), '2026-09-02'); // 23:59 UB
  assert.equal(dayKey(new Date('2026-09-02T16:00:00Z')), '2026-09-03'); // 00:00 UB
});

test('a UTC-midnight instant is already tomorrow in Ulaanbaatar', () => {
  assert.equal(dayKey(new Date('2026-09-02T23:00:00Z')), '2026-09-03');
});

test('the month rolls over on the salon\'s calendar too — it is what they are billed for', () => {
  assert.equal(monthKey(new Date('2026-09-30T15:59:00Z')), '2026-09');
  assert.equal(monthKey(new Date('2026-09-30T16:00:00Z')), '2026-10');
});
