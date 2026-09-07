import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, monthKey } from './periods.ts';

const UB = 'Asia/Ulaanbaatar';   // UTC+8, no DST since 2017

test('the day rolls over on the SALON\'s calendar, not UTC\'s', () => {
  // A daily ceiling that rolls at UTC midnight rolls at 08:00 in Ulaanbaatar —
  // mid-morning, in the middle of a working day — so a tenant that exhausted "today"
  // would recover mid-appointment.
  assert.equal(dayKey(new Date('2026-09-02T15:59:00Z'), UB), '2026-09-02'); // 23:59 UB
  assert.equal(dayKey(new Date('2026-09-02T16:00:00Z'), UB), '2026-09-03'); // 00:00 UB
});

test('a UTC-midnight instant is already tomorrow in Ulaanbaatar', () => {
  assert.equal(dayKey(new Date('2026-09-02T23:00:00Z'), UB), '2026-09-03');
});

test('the month rolls over on the salon\'s calendar too — it is what they are billed for', () => {
  assert.equal(monthKey(new Date('2026-09-30T15:59:00Z'), UB), '2026-09');
  assert.equal(monthKey(new Date('2026-09-30T16:00:00Z'), UB), '2026-10');
});

// ---------------------------------------------------------------------------
// The zone is an argument, and that is the point.
// ---------------------------------------------------------------------------

test('DONE-TEST: TWO TENANTS, ONE INSTANT, TWO DIFFERENT DAYS', () => {
  // The whole change, in one assertion. `dayKey` used to add a hardcoded 8 hours while
  // `tenants.timezone` was a per-tenant column, so a tenant in New York had their daily
  // ceiling roll over at 11:00 the previous morning — their spend for two calendar days
  // blended into one row, and the row labelled with neither of their days.
  const instant = new Date('2026-09-02T16:30:00Z');
  assert.equal(dayKey(instant, UB), '2026-09-03', '00:30 on the 3rd in Ulaanbaatar');
  assert.equal(dayKey(instant, 'America/New_York'), '2026-09-02', '12:30 on the 2nd in New York');
  assert.equal(dayKey(instant, 'UTC'), '2026-09-02');
});

test('the month is the tenant\'s month, not a shifted one', () => {
  const instant = new Date('2026-08-31T20:00:00Z');
  assert.equal(monthKey(instant, UB), '2026-09', '04:00 on 1 September in Ulaanbaatar');
  assert.equal(monthKey(instant, 'America/New_York'), '2026-08', '16:00 on 31 August in New York');
});

test('DONE-TEST: A ZONE WITH DAYLIGHT SAVING IS RIGHT ON BOTH SIDES OF THE SHIFT', () => {
  // The reason this is `Intl` and not `now.getTime() + offset * 60_000`. A fixed offset is
  // correct for Mongolia and silently an hour out for half the year anywhere that shifts —
  // and an hour is the whole distance between one day's ceiling and the next at midnight.
  //
  // Europe/Berlin is UTC+2 in July and UTC+1 in December.
  assert.equal(dayKey(new Date('2026-07-15T22:30:00Z'), 'Europe/Berlin'), '2026-07-16', '00:30 CEST');
  assert.equal(dayKey(new Date('2026-12-15T22:30:00Z'), 'Europe/Berlin'), '2026-12-15', '23:30 CET');
});

test('DONE-TEST: AN UNKNOWN ZONE THROWS — it never quietly becomes UTC', () => {
  // A fallback here would put a tenant's ceiling on the wrong calendar and say nothing,
  // which is the failure this module exists to end. On the money path the throw is caught
  // by `withTenantRole` and refuses with a 503; a 503 costs a redelivery.
  assert.throws(() => dayKey(new Date('2026-09-02T16:00:00Z'), 'Asia/Ulan_Bator_Typo'), RangeError);
  assert.throws(() => monthKey(new Date('2026-09-02T16:00:00Z'), ''), RangeError);
});

test('every counter written before this change keeps its key', () => {
  // The two existing tenants are both `Asia/Ulaanbaatar`, so the new rule must agree with
  // the old fixed +8 for every instant in the range the ledger actually covers. It does —
  // Mongolia has had no daylight saving since 2017 — and this is the assertion that says
  // so from arithmetic rather than from the assumption.
  const fixedOffsetDayKey = (now: Date): string =>
    new Date(now.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);

  for (let h = 0; h < 24 * 400; h += 1) {
    const t = new Date(Date.UTC(2026, 0, 1) + h * 3_600_000);
    assert.equal(dayKey(t, UB), fixedOffsetDayKey(t), t.toISOString());
  }
});
