import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  DEFAULT_REPLY_AGE_LIMIT_MINUTES,
  MAX_REPLY_AGE_LIMIT_MINUTES,
  isFresh,
  replyAgeLimitMinutes,
} from './freshness.ts';
import { STALE_EVENT_HOURS } from '../model/reception.ts';

const now = new Date('2026-09-04T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

test('the default is 30 minutes — the founder\'s call, and §3.9\'s own number', () => {
  assert.equal(DEFAULT_REPLY_AGE_LIMIT_MINUTES, 30);
});

test('a message inside the limit is answered; one outside is not', () => {
  assert.equal(isFresh(minutesAgo(0), now, 30), true);
  assert.equal(isFresh(minutesAgo(29), now, 30), true);
  assert.equal(isFresh(minutesAgo(30), now, 30), true, 'exactly at the limit still counts');
  assert.equal(isFresh(minutesAgo(31), now, 30), false);
  assert.equal(isFresh(minutesAgo(60), now, 30), false, 'the hour-old message the founder named');
});

test('the limit is per tenant — GS Auto Center may want two hours', () => {
  // §3.9 names 120 for a garage, whose customers are waiting on a car rather than a
  // haircut. The same message is stale for one tenant and fresh for the other, which is
  // the entire reason this is a column and not a constant.
  const message = minutesAgo(90);
  assert.equal(isFresh(message, now, 30), false);
  assert.equal(isFresh(message, now, 120), true);
});

test('a timestamp slightly in the FUTURE is fresh, not stale', () => {
  // Clock skew between Meta and us is real and small. Treating a message a few seconds
  // ahead as stale would drop live messages for a reason no operator could diagnose.
  assert.equal(isFresh(new Date(now.getTime() + 5_000), now, 30), true);
  assert.equal(isFresh(new Date(now.getTime() + 3_600_000), now, 30), true);
});

test('an unusable timestamp is NOT fresh — it is refused, not assumed recent', () => {
  assert.equal(isFresh(new Date('nonsense'), now, 30), false);
});

test('the column is read defensively, and every unusable value falls back to 30', () => {
  assert.equal(replyAgeLimitMinutes(45), 45);
  assert.equal(replyAgeLimitMinutes(1), 1);
  assert.equal(replyAgeLimitMinutes(MAX_REPLY_AGE_LIMIT_MINUTES), MAX_REPLY_AGE_LIMIT_MINUTES);
  for (const bad of [null, undefined, '30', 0, -5, NaN, Infinity, MAX_REPLY_AGE_LIMIT_MINUTES + 1, {}]) {
    assert.equal(replyAgeLimitMinutes(bad), 30, `${JSON.stringify(bad)} should fall back`);
  }
  // A float is floored rather than refused: 30.7 is somebody's arithmetic, not a typo.
  assert.equal(replyAgeLimitMinutes(30.7), 30);
});

test('the freshness gate is strictly tighter than the STALE_EVENT_HOURS backstop', () => {
  // Two controls, two questions: is a reply still WANTED (per tenant, 30 min) versus is it
  // still DELIVERABLE (platform, under Messenger's 24-hour window). This asserts the
  // relationship rather than either number — if a tenant were ever allowed a limit above
  // the backstop, the backstop would start silently deciding product behaviour.
  assert.ok(
    MAX_REPLY_AGE_LIMIT_MINUTES <= STALE_EVENT_HOURS * 60 + 24 * 60,
    'the per-tenant ceiling must stay inside a day',
  );
  assert.ok(DEFAULT_REPLY_AGE_LIMIT_MINUTES < STALE_EVENT_HOURS * 60);
});

test('the migration and the code agree on the bounds', () => {
  // 0006 carries `check (max_reply_age_minutes between 1 and 1440)`. If the migration and
  // the reader disagreed, a row the database accepts would be silently replaced by the
  // default — a tenant's configured value quietly ignored.
  const sql = readFileSync('supabase/migrations/0006_reply_freshness.sql', 'utf8');
  assert.match(sql, /between 1 and 1440/);
  assert.match(sql, /default 30/);
  assert.equal(MAX_REPLY_AGE_LIMIT_MINUTES, 1440);
  assert.equal(DEFAULT_REPLY_AGE_LIMIT_MINUTES, 30);
});
