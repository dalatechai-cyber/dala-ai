import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_FAILURES_BEFORE_HALT, HALT_INTERVAL_MINUTES,
  credentialCode, credentialStreak, decideBreaker, runCredentialBreaker,
  type Attempt,
} from './breaker.ts';

const NOW = new Date('2026-09-06T21:00:00Z');

const fail = (code: string): Attempt => ({ state: 'failed', refusedReason: `no credential: ${code}` });
const sent: Attempt = { state: 'sent', refusedReason: null };
const otherFailure: Attempt = { state: 'failed', refusedReason: 'graph 613: rate limited' };

// ---------------------------------------------------------------------------
// The streak
// ---------------------------------------------------------------------------

test('a credential failure is recognised by the reason its own writer produces', () => {
  // `deliverOutbound` writes `no credential: ${secret.code}` and nothing else does. The
  // prefix is exported from the module that reads it, so the two cannot drift apart in
  // separate files the way a transcribed constant would.
  assert.equal(credentialCode(fail('secret_undecryptable')), 'secret_undecryptable');
  assert.equal(credentialCode(sent), null);
  assert.equal(credentialCode(otherFailure), null);
});

test('DONE-TEST: A SUCCESSFUL SEND RESETS THE STREAK, because the provider accepted the token', () => {
  // The strongest available evidence that a credential works is that it worked. Counting a
  // rate over a window instead would keep a channel one bad hour away from a halt for ever
  // after; consecutive-with-reset is a property of the sequence, not a number to tune.
  assert.equal(credentialStreak([fail('a'), fail('b'), fail('c')]), 3);
  assert.equal(credentialStreak([fail('a'), sent, fail('b'), fail('c')]), 1);
  assert.equal(credentialStreak([sent, fail('a'), fail('b'), fail('c')]), 0);
});

test('a failure of another kind breaks it too — the streak is about the CREDENTIAL', () => {
  assert.equal(credentialStreak([fail('a'), otherFailure, fail('b')]), 1);
});

test('DONE-TEST: kek_unavailable NEITHER COUNTS NOR BREAKS — it is not about this channel', () => {
  // Its own definition: "the platform cannot decrypt ANYTHING sealed under that version".
  // Counting it counts the global cause as local, and the one-halt-per-hour cap would then
  // be rescuing the breaker from a state it should never have entered. Treating it as a
  // RESET is the opposite error: a KEK blip between two undecryptable failures is not
  // evidence that the credential started working.
  assert.equal(credentialStreak([fail('kek_unavailable'), fail('secret_undecryptable'), fail('secret_undecryptable')]), 2);
  assert.equal(credentialStreak([fail('kek_unavailable'), fail('kek_unavailable')]), 0);
  // The retryable one is excluded for the other reason: a failed READ, not a failed credential.
  assert.equal(credentialStreak([fail('secret_unreadable'), fail('token_missing'), fail('token_missing')]), 2);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const facts = (over: Partial<Parameters<typeof decideBreaker>[0]> = {}) =>
  decideBreaker({ code: 'secret_undecryptable', streak: 3, haltsInInterval: 0, failingChannels: 1, ...over });

test('three consecutive failures halt the channel; two do not', () => {
  assert.equal(facts({ streak: CREDENTIAL_FAILURES_BEFORE_HALT }).action, 'halt');
  assert.equal(facts({ streak: CREDENTIAL_FAILURES_BEFORE_HALT - 1 }).action, 'none');
});

test('DONE-TEST: A GLOBAL CODE NEVER HALTS, whatever the streak says', () => {
  // The founder's refusal, in their words: "a KEK deployment slip halting every channel at
  // once is a self-inflicted outage from a config mistake". Better not to enter the state
  // than to be rescued from it by the cap.
  const d = facts({ code: 'kek_unavailable', streak: 99 });
  assert.equal(d.action, 'none');
  assert.equal(d.action === 'none' && d.reason, 'not_this_channel');
});

test('DONE-TEST: THE CAP HOLDS THE SECOND HALT IN THE HOUR', () => {
  const d = facts({ haltsInInterval: 1, failingChannels: 7 });
  assert.equal(d.action, 'suppressed');
  assert.equal(d.action === 'suppressed' && d.failingChannels, 7);
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

type Reply = { data?: unknown; error?: unknown };

function stub(over: { recent?: Attempt[]; halts?: number; failingChannels?: string[]; errors?: Record<string, string> } = {}) {
  const alerts: { severity: string; kind: string; dedupKey: string; body: string; quiet?: boolean }[] = [];
  const logs: { level: string; event: string }[] = [];
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  let scan = 0;

  const from = (table: string) => {
    const rec = { table, cols: '' };
    const chain: Record<string, unknown> = {};
    chain['select'] = (cols: string) => ((rec.cols = cols), chain);
    for (const m of ['eq', 'gte', 'like', 'order', 'limit']) chain[m] = () => chain;
    chain['update'] = (patch: Record<string, unknown>) => {
      writes.push({ table, patch });
      return chain;
    };
    const answer = (): Reply => {
      const err = over.errors?.[`${table}:${rec.cols}`];
      if (err !== undefined) return { data: null, error: { message: err } };
      if (table === 'alerts') return { data: new Array(over.halts ?? 0).fill({ dedup_key: 'k' }), error: null };
      if (rec.cols.includes('channel_id')) {
        return { data: (over.failingChannels ?? ['ch-1']).map((c) => ({ channel_id: c })), error: null };
      }
      scan += 1;
      return {
        data: (over.recent ?? []).map((a) => ({ state: a.state, refused_reason: a.refusedReason })),
        error: null,
      };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res(answer());
    return chain;
  };
  return {
    alerts, logs, writes, scans: () => scan,
    db: { from } as never,
    deps: {
      alert: async (a: { severity: 'warn' | 'critical'; kind: string; dedupKey: string; body: string; quiet?: boolean }) => { alerts.push(a); },
      log: (level: 'info' | 'warn' | 'error', event: string) => { logs.push({ level, event }); },
    },
  };
}

const run = (s: ReturnType<typeof stub>, code = 'secret_undecryptable') =>
  runCredentialBreaker(s.db, s.deps, { tenantId: 't-1', channelId: 'ch-1', code, now: NOW });

test('DONE-TEST: THE THIRD FAILURE STOPS THE CHANNEL — off, error, authorization_error', async () => {
  // `token_status = 'error'`, never `revoked`. Meta did not say the token is invalid; we
  // could not open our own copy of it. Recording `revoked` would send an operator to
  // re-authorise a Page whose authorisation was never the problem.
  const s = stub({ recent: [fail('secret_undecryptable'), fail('secret_undecryptable'), fail('secret_undecryptable')] });
  const d = await run(s);
  assert.equal(d.action, 'halt');
  assert.deepEqual(s.writes, [{
    table: 'tenant_channels',
    patch: { token_status: 'error', delivery_mode: 'off', status: 'authorization_error' },
  }]);
  assert.equal(s.alerts[0]?.kind, 'channel.credential_halt');
  assert.equal(s.alerts[0]?.severity, 'critical');
});

test('the halt alert is the clock the cap reads, so it must carry the hour', async () => {
  // There is no `halted_at` on `tenant_channels`, and adding one would be a second place
  // for the same fact to drift from. `haltsInInterval` counts these rows, which are
  // written by the halt and by nothing else.
  const s = stub({ recent: [fail('a'), fail('b'), fail('c')] });
  await run(s);
  assert.match(String(s.alerts[0]?.dedupKey), /^channel_credential_halt:ch-1:2026-09-06T21$/);
});

test('DONE-TEST: THE SUPPRESSED HALT IS THE MASS-REVOCATION ALARM', async () => {
  // The cap is sized against a global CONFIG error. A global EXTERNAL event — Meta revoking
  // tokens across many Pages — looks identical from here and would leave forty-nine
  // channels paying full model cost for two days while one halted per hour. Each individual
  // suppression is a correct decision; the pattern of them is the incident.
  const s = stub({
    recent: [fail('a'), fail('b'), fail('c')],
    halts: 1,
    failingChannels: ['ch-1', 'ch-2', 'ch-3', 'ch-4'],
  });
  const d = await run(s);
  assert.equal(d.action, 'suppressed');
  assert.deepEqual(s.writes, [], 'nothing is halted');
  assert.equal(s.alerts[0]?.kind, 'channel.credential_halt_suppressed');
  assert.equal(s.alerts[0]?.severity, 'critical');
  assert.match(String(s.alerts[0]?.body), /4 channel/);
  assert.match(String(s.alerts[0]?.dedupKey), /2026-09-06T21$/, 'hourly, so the pattern reports once per hour');
});

test('below the threshold it alerts once a day and changes nothing', async () => {
  // `token_missing` and `secret_malformed` were silent before this: a channel that answers
  // nobody and says nothing. Warn, per channel per day, because the condition persists
  // until somebody re-seals a row.
  const s = stub({ recent: [fail('token_missing')] });
  const d = await run(s, 'token_missing');
  assert.equal(d.action, 'none');
  assert.deepEqual(s.writes, []);
  assert.equal(s.alerts[0]?.kind, 'channel.credential_failure');
  assert.equal(s.alerts[0]?.severity, 'warn');
  assert.match(String(s.alerts[0]?.dedupKey), /:2026-09-06$/);
});

test('a global code raises nothing here — deliverOutbound already pages for it', async () => {
  const s = stub({ recent: [fail('kek_unavailable'), fail('kek_unavailable'), fail('kek_unavailable')] });
  const d = await run(s, 'kek_unavailable');
  assert.equal(d.action, 'none');
  assert.deepEqual(s.alerts, [], 'no second alert for a condition already paged as critical');
  assert.deepEqual(s.writes, []);
});

test('DONE-TEST: AN UNREADABLE BREAKER NEVER HALTS', async () => {
  // The direction a mistake is allowed to fail. Not halting costs a bounded number of model
  // calls; halting a working channel on evidence we could not read is an outage caused by
  // the thing that exists to prevent one.
  const s = stub({ recent: [fail('a'), fail('b'), fail('c')], errors: { 'outbound_messages:state, refused_reason': 'connection reset' } });
  const d = await run(s);
  assert.equal(d.action, 'unreadable');
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.alerts, []);
});

test('a failed halt write is reported, not swallowed as success', async () => {
  const s = stub({ recent: [fail('a'), fail('b'), fail('c')], errors: { 'tenant_channels:': 'permission denied' } });
  const d = await run(s);
  assert.equal(d.action, 'unreadable');
  assert.equal(s.alerts.length, 0, 'no halt alert for a halt that did not happen');
});

test('the interval and the threshold are platform constants, not per-tenant knobs', () => {
  // The same reasoning as the silence watchdog's threshold: a per-channel knob invites
  // tuning a real control into silence one channel at a time, and there is no measurement
  // that would justify a different number for anybody.
  assert.equal(CREDENTIAL_FAILURES_BEFORE_HALT, 3);
  assert.equal(HALT_INTERVAL_MINUTES, 60);
});

// D-128: below the halt nothing has stopped yet, so the warning may wait for the daily
// report; the halt and the mass-revocation alarm never do.
test('DONE-TEST: only the below-threshold warning is QUIET; the halt and the suppressed halt page', async () => {
  const below = stub({ recent: [fail('token_missing')] });
  await run(below, 'token_missing');
  assert.equal(below.alerts[0]?.quiet, true);

  const halted = stub({ recent: [fail('a'), fail('b'), fail('c')] });
  await run(halted);
  assert.notEqual(halted.alerts[0]?.quiet, true, 'a stopped channel pages');

  const held = stub({ recent: [fail('a'), fail('b'), fail('c')], halts: 1, failingChannels: ['ch-1', 'ch-2'] });
  await run(held);
  assert.notEqual(held.alerts[0]?.quiet, true, 'the mass-revocation alarm pages');
});
