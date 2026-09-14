import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATE_AFTER_DAYS, planDigest, runDigestJob } from './digest.ts';
import type { OpenAlert } from './alert.ts';

const NOW = new Date('2026-09-14T01:00:00Z');   // 09:00 in Ulaanbaatar
const RAN = new Date('2026-09-14T00:00:00Z');   // the watchdog, an hour before

function episode(over: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: 1, tenantId: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
    dedupKey: 'channel_silence:ch-1:no_webhooks',
    body: 'Page 1520409424715591: this channel has NEVER received a webhook',
    at: new Date('2026-09-13T00:00:00Z'), notifiedAt: new Date('2026-09-13T00:00:00Z'),
    ...over,
  };
}

const CLEAN = { now: NOW, watchdogLastRan: RAN, channelsChecked: 2 };

test('DONE-TEST: A CLEAN DAY STILL SENDS, AND CARRIES PROOF OF LIFE', () => {
  // A digest that stays silent when nothing is open makes silence mean two things —
  // "nothing is wrong" and "the digest stopped running" — which is exactly the conflation
  // D-060 and D-062 were about, rebuilt inside the mechanism meant to be the safety net.
  const plan = planDigest([], CLEAN);
  assert.match(plan.summary, /Nothing open/);
  assert.match(plan.summary, /silence watchdog last ran 60m ago \(2 channels\)/);
  assert.equal(plan.escalate.length, 0);
});

test('DONE-TEST: and when the watchdog has never run, the clean day SAYS SO', () => {
  // `channel_health` is upserted on every run including healthy ones, precisely so that its
  // absence is a statement. A digest reading "nothing open" over a watchdog that has never
  // executed would be the most confident wrong sentence this system could produce.
  const plan = planDigest([], { now: NOW, watchdogLastRan: null, channelsChecked: 0 });
  assert.match(plan.summary, /never recorded an observation/);
  assert.doesNotMatch(plan.summary, /last ran/);
});

test('criticals lead, and within a severity the oldest episode leads', () => {
  const plan = planDigest([
    episode({ id: 1, severity: 'warn', kind: 'channel.unknown', at: new Date('2026-09-01T00:00:00Z') }),
    episode({ id: 2, severity: 'critical', kind: 'channel.no_messages', at: new Date('2026-09-12T00:00:00Z') }),
    episode({ id: 3, severity: 'critical', kind: 'channel.no_webhooks', at: new Date('2026-09-05T00:00:00Z') }),
  ], CLEAN);
  const order = ['channel.no_webhooks', 'channel.no_messages', 'channel.unknown'];
  const seen = order.map((k) => plan.summary.indexOf(k));
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, plan.summary);
  assert.match(plan.summary, /3 open conditions/);
});

test('DONE-TEST: AN OPEN CRITICAL RE-ESCALATES AFTER THREE DAYS', () => {
  // The failure `on_change` creates if nothing answers it: a condition alerts once, goes
  // quiet, and three weeks later nobody can tell it from one that never happened.
  const fresh = episode({ id: 1, notifiedAt: new Date('2026-09-13T00:00:00Z') });
  const stale = episode({ id: 2, notifiedAt: new Date('2026-09-10T00:00:00Z') });
  const plan = planDigest([fresh, stale], CLEAN);
  assert.deepEqual(plan.escalate.map((a) => a.id), [2]);
});

test('a digest-routed episode measures its three days from `at`, not from never', () => {
  // `notifiedAt` is null because nobody has been paged — which is the opposite of "recently
  // told". Reading null as recent would mean a digest-routed critical never escalates.
  const plan = planDigest([episode({ id: 5, notifiedAt: null, at: new Date('2026-09-09T00:00:00Z') })], CLEAN);
  assert.deepEqual(plan.escalate.map((a) => a.id), [5]);
  assert.equal(ESCALATE_AFTER_DAYS, 3);
});

test('a warn never re-escalates, however old', () => {
  // Escalation is for the things worth waking up to. A standing warn belongs in the digest
  // and nowhere else, or the escalation becomes the new daily repeat.
  const plan = planDigest([episode({ severity: 'warn', notifiedAt: new Date('2026-08-01T00:00:00Z') })], CLEAN);
  assert.equal(plan.escalate.length, 0);
});

test('an over-long digest REPORTS what it left out', () => {
  // A summary that silently omits the item you needed is worse than one that is too long,
  // and "the part it managed" is the shape D-057 is named for.
  const many = Array.from({ length: 200 }, (_, i) => episode({ id: i, body: 'x'.repeat(300) }));
  const plan = planDigest(many, CLEAN);
  assert.ok(plan.summary.length <= 4096, `${plan.summary.length}`);
  assert.match(plan.summary, /and \d+ more, not shown/);
});

// --- the job ---------------------------------------------------------------

function jobDb(over: { alerts?: unknown; health?: unknown; alertsError?: unknown } = {}) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'like', 'in', 'order', 'limit', 'update', 'insert']) chain[m] = () => chain;
      chain['then'] = (res: (v: unknown) => unknown) => res(
        table === 'alerts'
          ? { data: over.alerts ?? [], error: over.alertsError ?? null }
          : { data: over.health ?? [{ observed_at: RAN.toISOString() }], error: null },
      );
      return chain;
    },
  } as never;
}

test('an unsigned call is 401 and reads nothing', async () => {
  const r = await runDigestJob(
    { db: jobDb(), now: NOW, verifySignature: async () => false },
    { rawBody: '{}', signature: null },
  );
  assert.equal(r.status, 401);
});

test('DONE-TEST: a digest that cannot read the alerts is 503, never a clean day', async () => {
  // 200 with `open: 0` over an unreadable table is the mechanism claiming a clean day it
  // never checked — the same 200-with-nothing that lost three messages in one night.
  process.env['ALERTS_ENABLED'] = 'false';
  const r = await runDigestJob(
    { db: jobDb({ alertsError: { message: 'connection reset' } }), now: NOW, verifySignature: async () => true },
    { rawBody: '{}', signature: 'sig' },
  );
  assert.equal(r.status, 503);
  assert.match(String(r.body['detail']), /connection reset/);
});

test('a signed run reports what it found', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const r = await runDigestJob(
    {
      db: jobDb({ alerts: [{
        id: 1, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
        dedup_key: 'channel_silence:ch-1:no_webhooks', body: 'dead',
        at: '2026-09-13T00:00:00Z', notified_at: '2026-09-13T00:00:00Z',
      }] }),
      now: NOW,
      verifySignature: async () => true,
    },
    { rawBody: '{}', signature: 'sig' },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body['open'], 1);
  // ALERTS_ENABLED=false silences every path or it silences none of them.
  assert.equal(r.body['sent'], false);
});
