import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideReclaim, RECLAIM_AFTER_OPEN_MINUTES, RECLAIM_MAX_AGE_MINUTES, type ReclaimFacts,
} from './reclaim.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';

/**
 * Asia/Ulaanbaatar is UTC+8 with no daylight saving, so every instant below is written in
 * UTC with its Ulaanbaatar reading beside it. 2026-09-25 is a Friday.
 */
const HOURS: BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '10:00', closes: '20:00', closed: false }));
const SCHEDULE = { timezone: 'Asia/Ulaanbaatar', hours: HOURS, closures: [] as Closure[] };

const at = (iso: string) => new Date(iso);

function facts(over: Partial<ReclaimFacts> = {}): ReclaimFacts {
  return {
    control: 'human',
    source: 'echo',
    // Staff replied at 10:59 Friday; the customer wrote at 11:00.
    controlAt: at('2026-09-25T02:59:00Z'),
    latest: { externalId: 'm_1', at: at('2026-09-25T03:00:00Z') },
    reclaimRow: null,
    botReplied: false,
    // 13:30 Friday: 150 open minutes after the message.
    now: at('2026-09-25T05:30:00Z'),
    schedule: SCHEDULE,
    ...over,
  };
}

test('a staff-held chat, two open hours after the customer wrote, is sent the line', () => {
  const v = decideReclaim(facts());
  assert.equal(v.action, 'send');
  // A floor: the walk stops once it has counted past two hours.
  assert.ok(v.action === 'send' && v.openMinutesAtLeast >= RECLAIM_AFTER_OPEN_MINUTES);
});

test('two OPEN hours is the threshold: 115 minutes waits, 120 sends', () => {
  assert.deepEqual(decideReclaim(facts({ now: at('2026-09-25T04:55:00Z') })), { action: 'skip', reason: 'waiting' });
  assert.equal(decideReclaim(facts({ now: at('2026-09-25T05:00:00Z') })).action, 'send');
  assert.equal(RECLAIM_AFTER_OPEN_MINUTES, 120);
});

test('ACROSS A CLOSED NIGHT: the hours the salon is shut do not count', () => {
  // Written 19:30 Friday; 30 open minutes before close, then the night.
  const latest = { externalId: 'm_1', at: at('2026-09-25T11:30:00Z') };
  const controlAt = at('2026-09-25T11:29:00Z');
  // 23:00 Friday: 3.5 wall-clock hours, 30 open minutes.
  assert.deepEqual(decideReclaim(facts({ latest, controlAt, now: at('2026-09-25T15:00:00Z') })), { action: 'skip', reason: 'waiting' });
  // 11:20 Saturday: 30 + 80 = 110 open minutes. Still waiting, fourteen hours later.
  assert.deepEqual(decideReclaim(facts({ latest, controlAt, now: at('2026-09-26T03:20:00Z') })), { action: 'skip', reason: 'waiting' });
  // 11:35 Saturday: 30 + 95 = 125. Sent.
  const v = decideReclaim(facts({ latest, controlAt, now: at('2026-09-26T03:35:00Z') }));
  assert.equal(v.action, 'send');
  assert.equal(v.action === 'send' && v.openMinutesAtLeast, 125);
});

test('A CLOSURE DAY is not open time, and the customer then ages out: counted, never paged', () => {
  // Written 19:00 Friday; Saturday is a holiday.
  const latest = { externalId: 'm_1', at: at('2026-09-25T11:00:00Z') };
  const controlAt = at('2026-09-25T10:00:00Z');
  const closures: Closure[] = [{ startsOn: '2026-09-26', endsOn: '2026-09-26', title: 'Баяр', message: 'Амарна' }];
  const saturday = at('2026-09-26T03:30:00Z'); // 11:30 Saturday
  // Without the closure: 60 + 90 = 150 open minutes, sent.
  assert.equal(decideReclaim(facts({ latest, controlAt, now: saturday })).action, 'send');
  // With it: only Friday's 60 minutes count.
  assert.deepEqual(
    decideReclaim(facts({ latest, controlAt, now: saturday, schedule: { ...SCHEDULE, closures } })),
    { action: 'skip', reason: 'waiting' },
  );
  // Sunday 10:30: past Meta's window before two open hours ever passed. Nothing is sent and
  // nobody is paged: the closure ate the two hours, so no send was ever owed. Counted.
  assert.deepEqual(
    decideReclaim(facts({ latest, controlAt, now: at('2026-09-27T02:30:00Z'), schedule: { ...SCHEDULE, closures } })),
    { action: 'skip', reason: 'window_missed' },
  );
});

test('only while the salon is open NOW', () => {
  // Written 13:00 Friday, now 21:00: seven open hours have passed, but it is closed.
  const v = decideReclaim(facts({
    latest: { externalId: 'm_1', at: at('2026-09-25T05:00:00Z') },
    controlAt: at('2026-09-25T04:00:00Z'),
    now: at('2026-09-25T13:00:00Z'),
  }));
  assert.deepEqual(v, { action: 'skip', reason: 'closed_now' });
});

test('THE 24-HOUR WINDOW: past the send limit nothing is sent; counted, not paged', () => {
  // Written 12:00 Friday, so the limit falls at 11:00 Saturday, while open.
  const latest = { externalId: 'm_1', at: at('2026-09-25T04:00:00Z') };
  const justInside = new Date(latest.at.getTime() + (RECLAIM_MAX_AGE_MINUTES - 1) * 60_000);
  const atLimit = new Date(latest.at.getTime() + RECLAIM_MAX_AGE_MINUTES * 60_000);
  assert.equal(decideReclaim(facts({ latest, now: justInside })).action, 'send'); // 10:59 Saturday, open
  assert.deepEqual(decideReclaim(facts({ latest, now: atLimit })), { action: 'skip', reason: 'window_missed' });
  // A line already sent whose flip was lost is still finished past the limit: the flip sends nothing.
  assert.deepEqual(decideReclaim(facts({ latest, now: atLimit, reclaimRow: 'sent' })), { action: 'finish' });
  assert.ok(RECLAIM_MAX_AGE_MINUTES < 24 * 60, 'the limit stays inside Meta\'s 24 hours');
});

test('STAFF REPLIED after the customer: nothing is sent, at any age', () => {
  for (const controlAt of [at('2026-09-25T03:00:01Z'), at('2026-09-25T03:00:00Z')]) {
    assert.deepEqual(decideReclaim(facts({ controlAt })), { action: 'skip', reason: 'staff_replied_after' });
  }
});

test('THE BOT ALREADY REPLIED after the message: nothing is sent', () => {
  assert.deepEqual(decideReclaim(facts({ botReplied: true })), { action: 'skip', reason: 'bot_replied' });
});

test('THE RECLAIM ROW decides a repeat: sent finishes the flip, never a second send', () => {
  // `refused` is what the worker writes when a person replied or a send failed for good
  // (`worker/reclaim.ts`): terminal, so the sweep stops re-enqueueing it.
  assert.deepEqual(decideReclaim(facts({ reclaimRow: 'sent' })), { action: 'finish' });
  // Its own row is not "the bot replied": a crash after the send must still be finished.
  assert.deepEqual(decideReclaim(facts({ reclaimRow: 'sent', botReplied: false })), { action: 'finish' });
  assert.deepEqual(decideReclaim(facts({ reclaimRow: 'refused' })), { action: 'skip', reason: 'reclaim_refused' });
  assert.deepEqual(decideReclaim(facts({ reclaimRow: 'indeterminate' })), { action: 'skip', reason: 'reclaim_indeterminate' });
  assert.deepEqual(decideReclaim(facts({ reclaimRow: 'sending' })), { action: 'skip', reason: 'reclaim_in_flight' });
  // A row an earlier attempt drafted or failed is still owed.
  assert.equal(decideReclaim(facts({ reclaimRow: 'failed' })).action, 'send');
  assert.equal(decideReclaim(facts({ reclaimRow: 'draft' })).action, 'send');
});

test('a Meta handover or our own pass is never sent to and never paged, only counted', () => {
  // Not paged: the bot's own media hand-off also writes `handover`, so "staff took the chat
  // through Meta's inbox" would be false for every photo (and Tara switched that page off, D-153).
  for (const source of ['handover', 'passed'] as const) {
    assert.deepEqual(decideReclaim(facts({ source })), { action: 'skip', reason: 'meta_holds_thread' }, source);
    // And only once the same timing a send would need has passed.
    assert.deepEqual(decideReclaim(facts({ source, now: at('2026-09-25T04:00:00Z') })), { action: 'skip', reason: 'waiting' }, source);
  }
  assert.deepEqual(decideReclaim(facts({ source: null })), { action: 'skip', reason: 'unknown_source' });
});

test('nothing held, no time, or no customer message: nothing to do', () => {
  assert.deepEqual(decideReclaim(facts({ control: 'bot' })), { action: 'skip', reason: 'not_human' });
  assert.deepEqual(decideReclaim(facts({ control: 'unknown' })), { action: 'skip', reason: 'not_human' });
  // `human` with no time reads as current, exactly as check 4 reads it.
  assert.deepEqual(decideReclaim(facts({ controlAt: null })), { action: 'skip', reason: 'no_timestamp' });
  assert.deepEqual(decideReclaim(facts({ latest: null })), { action: 'skip', reason: 'no_customer_message' });
});

test('hours that were never entered cannot be counted, so nothing is sent', () => {
  assert.deepEqual(
    decideReclaim(facts({ schedule: { ...SCHEDULE, hours: [] } })),
    { action: 'skip', reason: 'hours_not_configured' },
  );
});
