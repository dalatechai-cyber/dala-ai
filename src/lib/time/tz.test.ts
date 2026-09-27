/**
 * Mongolian time whatever the machine's zone (founder, 2026-09-27). The same scenarios run in
 * child processes with TZ set to UTC, Asia/Singapore and America/New_York; every answer must
 * be identical, and must be Ulaanbaatar's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./tzScenarios.ts', import.meta.url));
const ZONES = ['UTC', 'Asia/Singapore', 'America/New_York', 'Asia/Ulaanbaatar'];

function runUnder(tz: string): string {
  return execFileSync(process.execPath, [...process.execArgv, SCRIPT], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  });
}

test('the children really run on different clocks (else the comparison below proves nothing)', () => {
  const offsets = ZONES.map((tz) => execFileSync(process.execPath, ['-e', "process.stdout.write(String(new Date('2026-09-27T16:00:00Z').getTimezoneOffset()))"], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  }));
  assert.deepEqual(offsets, ['0', '-480', '240', '-480']);
});

test('every time-dependent answer is identical under UTC, Singapore, New York and Ulaanbaatar machines', () => {
  const outputs = ZONES.map((tz) => ({ tz, out: runUnder(tz) }));
  const first = outputs[0];
  assert.ok(first !== undefined && first.out.length > 0);
  for (const o of outputs) assert.equal(o.out, first.out, `TZ=${o.tz} differs from TZ=${first.tz}`);
});

test('the answers are Ulaanbaatar\'s, either side of its midnight', () => {
  const rows = JSON.parse(runUnder('America/New_York')) as Array<{
    iso: string; clock: { date: string; time: string; weekday: number }; dayStart: string;
    ub: string[]; spend: string[]; report: { date: string }; volatile: string;
  }>;
  const at = (iso: string) => {
    const r = rows.find((x) => x.iso === iso);
    assert.ok(r !== undefined);
    return r;
  };
  const before = at('2026-09-27T15:59:00Z');
  assert.deepEqual(before.clock, { date: '2026-09-27', time: '23:59', weekday: 0 });
  assert.equal(before.ub[2], '2026-09-27 23:59 UB time');
  assert.equal(before.volatile.includes('ХААЛТТАЙ'), true, 'Sunday 23:59 there: shut');

  const after = at('2026-09-27T16:00:00Z');
  assert.deepEqual(after.clock, { date: '2026-09-28', time: '00:00', weekday: 1 });
  assert.equal(after.dayStart, '2026-09-27T16:00:00.000Z');
  assert.deepEqual(after.spend, ['2026-09-28', '2026-09']);
  assert.equal(after.ub[0], '2026-09-28');
  assert.equal(after.ub[1], '2026-09-28 00');
  assert.equal(after.volatile.includes('НЭЭЛТТЭЙ'), true, 'Monday 00:00 there: open');

  // The 00:05 digest reports the Ulaanbaatar day that just ended.
  assert.equal(at('2026-09-27T16:05:00Z').report.date, '2026-09-27');

  // The month rolls on Ulaanbaatar's clock, eight hours before UTC's.
  assert.deepEqual(at('2026-09-30T15:59:00Z').spend, ['2026-09-30', '2026-09']);
  assert.deepEqual(at('2026-09-30T16:00:00Z').spend, ['2026-10-01', '2026-10']);
});
