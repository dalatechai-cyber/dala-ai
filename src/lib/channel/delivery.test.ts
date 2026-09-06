import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canDeliver } from './delivery.ts';

test('only `live` delivers', () => {
  assert.deepEqual(canDeliver('live'), { deliver: true, generate: true });
  for (const mode of ['off', 'shadow_routing', 'shadow']) {
    assert.equal(canDeliver(mode).deliver, false, mode);
  }
});

test('DONE-TEST: ONLY THE MIRROR GENERATES WITHOUT DELIVERING — the rest are free', () => {
  // The verdict used to be one boolean, consulted after the reply had already been
  // generated, so every non-live mode paid for text nobody could receive. Two of them are
  // supposed to cost nothing at all: `shadow_routing`, whose own description in this file
  // reads «nothing is generated or sent», and `off` — which is what a channel becomes when
  // `haltChannelOutbound` reacts to a Graph 190, so every message after a token dies was
  // drafting a reply into a channel that could not send it.
  assert.equal(canDeliver('shadow').generate, true, 'the mirror must keep generating');
  for (const mode of ['off', 'shadow_routing', '', 'enabled']) {
    assert.equal(canDeliver(mode).generate, false, mode);
  }
});

test('the mirror is its own reason, so a log line can tell the two apart', () => {
  // `not_live` on a halted channel and `not_live` on the mirror phase are different facts
  // about different situations, and an operator reading the worker's output should not
  // have to infer which from the mode.
  const mirror = canDeliver('shadow');
  const halted = canDeliver('off');
  assert.equal(mirror.deliver === false && mirror.reason, 'mirror');
  assert.equal(halted.deliver === false && halted.reason, 'not_live');
});

test('DONE-TEST: the mirror phase does not double-reply Matrix customers', () => {
  // During Track 4's mirror both systems see the traffic — by whatever route. There are
  // two Meta apps, so a second subscription is available; whether both then receive
  // `entry.messaging` rather than one getting `entry.standby` is [UNVERIFIED]. See
  // `delivery.ts`, which has been wrong about this twice. What is certain is that if both
  // are receiving and both send, the salon answers twice. And during Track 4's
  // 14-day mirror both Dala AI and the incumbent Matrix-Chatbot are subscribed to that
  // Page. A `shadow` channel that delivered would send a second reply from the same salon
  // to every customer for two weeks — turning the phase whose entire purpose is zero risk
  // into the riskiest thing in the plan.
  const verdict = canDeliver('shadow');
  assert.equal(verdict.deliver, false);
  assert.match(verdict.deliver === false ? verdict.detail : '', /deliberately not sent/);
});

test('an unrecognised mode does NOT deliver — the allow-list is positive', () => {
  // A mode added to the constraint later is non-delivering until somebody decides
  // otherwise. A deny-list would have made the new value live by default, which is the
  // wrong direction for this particular default to fail in.
  for (const mode of ['', 'LIVE', 'live ', 'enabled', 'production']) {
    assert.equal(canDeliver(mode).deliver, false, JSON.stringify(mode));
  }
});

test('every mode the schema permits is named here', () => {
  // If a migration adds a fifth mode, this fails rather than letting it fall through the
  // unrecognised branch unnoticed — the branch is a safety net, not a plan.
  const sql = readFileSync('supabase/migrations/0001_initial_schema.sql', 'utf8');
  const m = /delivery_mode\s+text not null default 'off'\s*\n?\s*check \(delivery_mode in \(([^)]*)\)\)/.exec(sql);
  assert.notEqual(m, null, 'the delivery_mode constraint must still be findable');
  const modes = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]); // ascii-safe: SQL string literals
  assert.deepEqual(modes.sort(), ['live', 'off', 'shadow', 'shadow_routing']);
  for (const mode of modes) {
    assert.equal(typeof canDeliver(String(mode)).deliver, 'boolean');
    // A fifth mode must also have a deliberate answer to "does this spend money?".
    assert.equal(typeof canDeliver(String(mode)).generate, 'boolean');
  }
});
