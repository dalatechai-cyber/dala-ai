import test from 'node:test';
import assert from 'node:assert/strict';
import { decideReclaim, RECLAIM_WINDOW_MINUTES, type ReclaimCandidate } from './reclaim.ts';

const NOW = new Date('2026-09-20T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const candidate = (over: Partial<ReclaimCandidate> = {}): ReclaimCandidate => ({
  conversationId: 'c1',
  control: 'human',
  source: 'passed',
  at: minsAgo(60),
  ...over,
});

test('a thread WE passed, past the window, is reclaimed', () => {
  const v = decideReclaim(candidate({ at: minsAgo(20) }), NOW);
  assert.equal(v.reclaim, true);
  assert.equal(v.reclaim === true && v.waitedMinutes, 20);
});

// THE RULE THE WHOLE SWEEPER EXISTS TO RESPECT.
//
// `handover` is what Meta writes when a receptionist takes a thread in Business Suite, and
// it is ALSO what it writes when we pass one — that collision is why this could not be
// built before `0033`. The reclaim window (15) is shorter than the takeover cooldown (30),
// so reclaiming a `handover` thread would take it back off a person who is still inside
// the cooldown and make that cooldown unreachable for every tenant at once.
test('a thread a PERSON took is never reclaimed, however long they have held it', () => {
  for (const source of ['handover', 'echo', null] as const) {
    for (const age of [16, 60, 60 * 24 * 365]) {
      const v = decideReclaim(candidate({ source, at: minsAgo(age) }), NOW);
      assert.equal(v.reclaim, false, `source=${source} age=${age}m must not reclaim`);
      assert.equal(v.reclaim === false && v.reason, 'not_ours_to_reclaim');
    }
  }
});

test('inside the window it waits, and says how long it has waited', () => {
  const v = decideReclaim(candidate({ at: minsAgo(14) }), NOW);
  assert.equal(v.reclaim, false);
  assert.equal(v.reclaim === false && v.reason, 'window_open');
  assert.equal(v.waitedMinutes, 14);
});

test('the boundary is inclusive: exactly the window reclaims', () => {
  assert.equal(decideReclaim(candidate({ at: minsAgo(RECLAIM_WINDOW_MINUTES) }), NOW).reclaim, true);
  assert.equal(decideReclaim(candidate({ at: minsAgo(RECLAIM_WINDOW_MINUTES - 1) }), NOW).reclaim, false);
});

// `0027` shipped every pre-existing conversation with a null `thread_control_at`, so this
// is a real state rather than a malformed row. `humanHoldsThread` reads a null as "control
// is current" and refuses to ANSWER; this reads it the same way and refuses to RECLAIM.
// Both resolve towards leaving the person alone.
test('human with no timestamp is read as current, never as expired', () => {
  const v = decideReclaim(candidate({ at: null }), NOW);
  assert.equal(v.reclaim, false);
  assert.equal(v.reclaim === false && v.reason, 'no_timestamp');
});

// A `bot` thread carrying `source = 'passed'` is one this sweeper ALREADY reclaimed. It
// must read as nothing to do, not as a discriminator failure.
test('a thread already back with the bot is not_human, not a reclaim', () => {
  for (const control of ['bot', 'unknown'] as const) {
    const v = decideReclaim(candidate({ control }), NOW);
    assert.equal(v.reclaim, false);
    assert.equal(v.reclaim === false && v.reason, 'not_human');
  }
});

// A window of 0 is a tenant saying "take it back immediately", exactly as a cooldown of 0
// means "resume immediately" in `humanHoldsThread`. A switch nobody can turn off is a
// switch somebody works around.
test('a zero window reclaims at once rather than never', () => {
  assert.equal(decideReclaim(candidate({ at: NOW }), NOW, 0).reclaim, true);
});

test('a future timestamp does not reclaim — a clock ahead of us is not an expired wait', () => {
  const v = decideReclaim(candidate({ at: new Date(NOW.getTime() + 60_000) }), NOW);
  assert.equal(v.reclaim, false);
  assert.equal(v.reclaim === false && v.reason, 'window_open');
});
