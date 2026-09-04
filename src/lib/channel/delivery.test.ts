import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canDeliver } from './delivery.ts';

test('only `live` delivers', () => {
  assert.deepEqual(canDeliver('live'), { deliver: true });
  for (const mode of ['off', 'shadow_routing', 'shadow']) {
    assert.equal(canDeliver(mode).deliver, false, mode);
  }
});

test('DONE-TEST: the mirror phase does not double-reply Matrix customers', () => {
  // Meta delivers the identical event to EVERY subscribed app, and during Track 4's
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
  for (const mode of modes) assert.equal(typeof canDeliver(String(mode)).deliver, 'boolean');
});
