import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSilence, MAX_LOOKBACK_DAYS, type SilenceInput } from './silence.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';

const TZ = 'Asia/Ulaanbaatar';   // UTC+8, no DST

/** Open 10:00–20:00 every day, on the tenant's clock. */
const DAILY: BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, opens: '10:00', closes: '20:00', closed: false,
}));

/** 2026-09-04 is a Friday. 06:00Z is 14:00 local — mid-afternoon, open. */
const NOW = new Date('2026-09-04T06:00:00Z');

function input(over: Partial<SilenceInput> = {}): SilenceInput {
  return {
    lastInboundAt: new Date('2026-09-04T05:30:00Z'),
    liveSince: new Date('2026-08-01T00:00:00Z'),
    now: NOW,
    timezone: TZ,
    hours: DAILY,
    closures: [],
    thresholdOpenMinutes: 180,
    ...over,
  };
}

test('a message half an hour ago is fine', () => {
  const r = assessSilence(input());
  assert.equal(r.verdict, 'ok');
  assert.equal(r.verdict === 'ok' && Math.round(r.openMinutes), 30);
});

test('DONE-TEST: four open hours of nothing is silence', () => {
  // 02:00Z is 10:00 local, the moment the salon opened. Four hours of trading with not one
  // message is the signal — for Matrix, whose measured traffic is 60.5 replies/day, four
  // open hours would normally carry a dozen conversations.
  const r = assessSilence(input({ lastInboundAt: new Date('2026-09-04T02:00:00Z') }));
  assert.equal(r.verdict, 'silent');
  assert.equal(r.verdict === 'silent' && r.everReceived, true);
  // A FLOOR, not the total: the walk stopped as soon as it had counted past the
  // 180-minute threshold. The real figure is 240, and the watchdog deliberately does not
  // pay to find that out — but it must not claim 185 IS the total either.
  assert.ok(r.verdict === 'silent' && r.openMinutesAtLeast > 180);
  assert.ok(r.verdict === 'silent' && r.openMinutesAtLeast <= 240);
});

test('DONE-TEST: OVERNIGHT SILENCE IS NOT A FAULT — this is the whole point', () => {
  // The last message came at 19:50 local yesterday, ten minutes before closing. It is now
  // 14:00 the next day. By the clock that is EIGHTEEN HOURS of silence and a naive
  // watchdog screams; in open minutes it is ten yesterday plus four today, and the salon
  // has been trading normally for those four.
  //
  // An alarm that fires every morning is muted within a week, and a muted alarm is worse
  // than no alarm at all.
  const lastInboundAt = new Date('2026-09-03T11:50:00Z');   // 19:50 local, Thursday
  const wallClockHours = (NOW.getTime() - lastInboundAt.getTime()) / 3_600_000;
  assert.equal(wallClockHours, 18.166666666666668, 'eighteen hours by the clock');

  const r = assessSilence(input({ lastInboundAt, thresholdOpenMinutes: 300 }));
  assert.equal(r.verdict, 'ok', 'and only 250 open minutes, which is under the threshold');
  assert.equal(r.verdict === 'ok' && Math.round(r.openMinutes), 250);
});

test('DONE-TEST: a closure does not count as open time', () => {
  // Tsagaan Sar: the door locked, the phone quiet, and the weekly schedule still saying
  // 10:00–20:00. That is precisely the case a weekly schedule alone gets wrong, and it is
  // why `activeClosure` outranks `isOpenAt` here exactly as it does in L4.
  //
  // The last message came ten minutes before closing on the 2nd; the 3rd and 4th are shut.
  const lastInboundAt = new Date('2026-09-02T11:50:00Z');   // 19:50 local
  const closures: Closure[] = [{ startsOn: '2026-09-03', endsOn: '2026-09-04', title: 'Амралт', message: '…' }];

  const withClosure = assessSilence(input({ lastInboundAt, closures, thresholdOpenMinutes: 300 }));
  assert.equal(withClosure.verdict, 'ok', 'two closed days contribute nothing');
  assert.equal(withClosure.verdict === 'ok' && Math.round(withClosure.openMinutes), 10);

  // The same input WITHOUT the closure is silent — which is what proves the closure did
  // the work, rather than the threshold happening to be generous.
  const without = assessSilence(input({ lastInboundAt, thresholdOpenMinutes: 300 }));
  assert.equal(without.verdict, 'silent');
});

test('DONE-TEST: a channel that has NEVER received an event is a different fault', () => {
  // §5 item 15: a page-level subscribe returns {"success": true} even when the app never
  // enabled that field, and no events are ever delivered. Nothing else in the system would
  // notice, because "no events" is what a quiet Tuesday looks like. The remedy is the app
  // subscription, not the token, so the verdict has to carry which one it is.
  const r = assessSilence(input({ lastInboundAt: null, liveSince: new Date('2026-09-04T02:00:00Z') }));
  assert.equal(r.verdict, 'silent');
  assert.equal(r.verdict === 'silent' && r.everReceived, false);
});

test('a channel that went live ten minutes ago is not yet silent', () => {
  const r = assessSilence(input({ lastInboundAt: null, liveSince: new Date('2026-09-04T05:50:00Z') }));
  assert.equal(r.verdict, 'ok');
});

test('DONE-TEST: no business_hours row is NOT_CONFIGURED, never a verdict', () => {
  // Counting unknown hours as open alerts every unprovisioned tenant nightly; counting
  // them as closed disables the watchdog silently — the watchdog acquiring the exact
  // defect it exists to detect. `isOpenAt` already refuses to collapse "we do not know"
  // into "closed"; this is the same refusal one layer up.
  const r = assessSilence(input({ hours: [] }));
  assert.equal(r.verdict, 'not_configured');
  assert.match(r.verdict === 'not_configured' ? r.detail : '', /business_hours/);
});

test('DONE-TEST: A PROVISIONING GAP IS NOT UNKNOWN — the two unmeasurables are separate verdicts', () => {
  // They used to share `unknown`, and `unknown` alerts. Since every tenant sits between
  // being provisioned and having its hours entered, the first live channel on the platform
  // raised a fresh alert every day saying only that setup was unfinished — the dedup key
  // carries the date, so it never suppressed. Two verdicts, because the remedies are
  // nothing alike: one is a form to fill in, the other is a question that should have had
  // an answer and did not.
  const missingSchedule = assessSilence(input({ hours: [] }));
  const noClock = assessSilence(input({ lastInboundAt: null, liveSince: null }));
  const closedFortnight = assessSilence(input({
    lastInboundAt: new Date('2026-08-01T00:00:00Z'),
    hours: DAILY.map((h) => ({ ...h, closed: true, opens: null, closes: null })),
  }));
  assert.equal(missingSchedule.verdict, 'not_configured');
  assert.equal(noClock.verdict, 'not_configured');
  // Hours that SAY closed are configured. That is an answer, and it keeps alerting.
  assert.equal(closedFortnight.verdict, 'unknown');
});

test('a day marked closed:true is known, not unknown', () => {
  // The difference between "closed on Sunday" and "no row for Sunday" is the difference
  // between an answer and the absence of one.
  const hours: BusinessHours[] = DAILY.map((h) => (h.weekday === 4 ? { ...h, closed: true, opens: null, closes: null } : h));
  const r = assessSilence(input({ lastInboundAt: new Date('2026-09-03T02:00:00Z'), hours, thresholdOpenMinutes: 600 }));
  assert.equal(r.verdict, 'ok');
});

test('nothing to measure from is a provisioning gap, not silence', () => {
  // No inbound event ever AND no `went_live_at`. A channel that was never stamped live and
  // has never received anything did not stop working; it was never finished.
  const r = assessSilence(input({ lastInboundAt: null, liveSince: null }));
  assert.equal(r.verdict, 'not_configured');
});

test('an event stamped in the future is clock skew, not a fault', () => {
  const r = assessSilence(input({ lastInboundAt: new Date('2026-09-04T09:00:00Z') }));
  assert.equal(r.verdict, 'ok');
});

test('a fortnight of closure is unmeasurable, NOT silent', () => {
  // The lookback bound exists so a long closure cannot be reported as a dead channel. It
  // is deliberately `unknown` rather than `ok`: a schedule with almost no open time in two
  // weeks is worth an operator's glance, just not an outage alarm.
  const closed: BusinessHours[] = DAILY.map((h) => ({ ...h, closed: true, opens: null, closes: null }));
  const r = assessSilence(input({ lastInboundAt: new Date('2026-08-01T00:00:00Z'), hours: closed }));
  assert.equal(r.verdict, 'unknown');
  assert.match(r.verdict === 'unknown' ? r.detail : '', new RegExp(`${MAX_LOOKBACK_DAYS} days`));
});

test('THE WALK IS BOUNDED BY THE THRESHOLD, not by how long the channel has been dead', () => {
  // A token revoked three months ago must cost the same handful of probes as one revoked
  // this morning. Walking forwards would sample ninety days to reach a conclusion it had
  // after the first three open hours.
  const started = process.hrtime.bigint();
  const r = assessSilence(input({ lastInboundAt: new Date('2026-06-01T00:00:00Z') }));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.verdict, 'silent');
  assert.ok(ms < 50, `decided in ${ms.toFixed(1)}ms`);
});

test('the threshold is a boundary, and crossing it is what changes the verdict', () => {
  // 10:00 local + 180 open minutes = 13:00; now is 14:00, so exactly 240 open minutes.
  const lastInboundAt = new Date('2026-09-04T02:00:00Z');
  assert.equal(assessSilence(input({ lastInboundAt, thresholdOpenMinutes: 239 })).verdict, 'silent');
  assert.equal(assessSilence(input({ lastInboundAt, thresholdOpenMinutes: 241 })).verdict, 'ok');
});

test('the tenant clock decides, not UTC', () => {
  // 06:00Z is 14:00 in Ulaanbaatar and 06:00 in London. The same instant is mid-afternoon
  // trading for one tenant and four hours before opening for another, and a watchdog
  // computing in UTC would alert the wrong one.
  const lastInboundAt = new Date('2026-09-04T02:00:00Z');
  const mn = assessSilence(input({ lastInboundAt }));
  const uk = assessSilence(input({ lastInboundAt, timezone: 'Europe/London' }));
  assert.equal(mn.verdict, 'silent', '4 open hours in Ulaanbaatar');
  assert.equal(uk.verdict, 'ok', 'still shut in London — 06:00 local');
});
