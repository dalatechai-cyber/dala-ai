import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readinessDedupKey, recordReadiness, type ReadinessEffects } from './record.ts';
import type { Readiness } from './validate.ts';

const DB = {} as SupabaseClient;
const NOW = new Date('2026-09-16T01:00:00Z');
const r = (stage: Readiness['stage'], waitingOn: string[] = []): Readiness =>
  ({ stage, waitingOn, findings: [] });

type Call = {
  op: 'raise' | 'resolve'; key: string;
  exceptKey: string | undefined; route: string | undefined; repeat: string | undefined;
};
function spy(raiseOutcome: Awaited<ReturnType<ReadinessEffects['raise']>>) {
  const calls: Call[] = [];
  const effects: ReadinessEffects = {
    raise: async (_db, input) => {
      calls.push({ op: 'raise', key: input.dedupKey, route: input.route, repeat: input.repeat, exceptKey: undefined });
      return raiseOutcome;
    },
    resolve: async (_db, input) => {
      calls.push({ op: 'resolve', key: input.keyPrefix, exceptKey: input.exceptKey, route: undefined, repeat: undefined });
      return { ok: true, resolved: [] };
    },
  };
  return { calls, effects };
}

test('DONE-TEST: INCOMPLETENESS IS A DIGEST EPISODE, NEVER A TELEGRAM', () => {
  // Telegram is shared with Core Language's customers (CLAUDE.md), so an onboarding
  // checklist has no business interrupting it. And the key carries no date: D-063's whole
  // lesson is that a condition which PERSISTS must not re-alert every morning.
  const { calls, effects } = spy({ outcome: 'recorded_for_digest' });
  return recordReadiness(DB, 'gs-auto', r('sentences', ['services and prices']), NOW, effects)
    .then((out) => {
      assert.equal(out.recorded, 'open');
      const raised = calls.find((c) => c.op === 'raise');
      assert.equal(raised?.route, 'digest');
      assert.equal(raised?.repeat, 'on_change');
      assert.doesNotMatch(raised?.key ?? '', /2026|\d{2}-\d{2}/, 'no date in an episode key');
    });
});

test('DONE-TEST: A SUPPRESSED RAISE RESOLVES NOTHING', () => {
  // `alerts_dedup_hourly` is unique on (kind, dedup_key, hour), so a tenant returning to a
  // state it held earlier this hour gets 23505. Resolving the others on that outcome would
  // leave NO open episode — and an absent readiness line reads exactly like a ready tenant.
  // Stale by up to an hour beats invisible. This is the ordering that guarantees it.
  const { calls, effects } = spy({ outcome: 'suppressed_duplicate' });
  return recordReadiness(DB, 'gs-auto', r('knowledge', ['client: «Сор»']), NOW, effects)
    .then((out) => {
      assert.equal(out.recorded, 'open');
      assert.deepEqual(calls.map((c) => c.op), ['raise'], 'raise only — nothing was closed');
    });
});

test('a fresh episode closes the tenant’s previous one, and only that tenant’s', () => {
  const { calls, effects } = spy({ outcome: 'recorded_for_digest' });
  return recordReadiness(DB, 'gs-auto', r('knowledge', ['a']), NOW, effects).then(() => {
    assert.deepEqual(calls.map((c) => c.op), ['raise', 'resolve'], 'raise FIRST');
    const res = calls[1]!;
    assert.equal(res.key, 'provisioning:gs-auto:', 'scoped by prefix to one tenant');
    assert.equal(res.exceptKey, readinessDedupKey('gs-auto', r('knowledge', ['a'])));
  });
});

test('DONE-TEST: A READY TENANT CLOSES ITS EPISODE AND SAYS NOTHING', () => {
  const { calls, effects } = spy({ outcome: 'recorded_for_digest' });
  return recordReadiness(DB, 'gs-auto', r('ready'), NOW, effects).then((out) => {
    assert.equal(out.recorded, 'ready');
    assert.deepEqual(calls.map((c) => c.op), ['resolve'], 'nothing is raised for a finished tenant');
    assert.equal(calls[0]?.exceptKey, undefined, 'every episode closes, none excepted');
  });
});

test('the key changes when the waiting-on list does, so the digest never names a done item', () => {
  const before = readinessDedupKey('gs-auto', r('knowledge', ['services and prices', 'contacts']));
  const after = readinessDedupKey('gs-auto', r('knowledge', ['contacts']));
  assert.notEqual(before, after);
});

test('an unreadable alerts table is reported, never swallowed as recorded', () => {
  const { effects } = spy({ outcome: 'failed', detail: 'alerts insert failed' });
  return recordReadiness(DB, 'gs-auto', r('routing', ['x']), NOW, effects)
    .then((out) => assert.equal(out.recorded, 'failed'));
});
