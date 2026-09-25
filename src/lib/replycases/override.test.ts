import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, generateOverrideKey, OVERRIDE_MAX_HOURS, signOverride, verifyOverride, type GateFindings } from './override.ts';

const FOUNDER = generateOverrideKey();
const STRANGER = generateOverrideKey();
const SHA = 'a'.repeat(40);
const NOW = new Date('2026-09-25T03:00:00Z');
const OUTAGE: GateFindings = { wrong: [], unchecked: ['timed out after 180s: the database or the model did not answer'] };

function tokenFor(over: Partial<{ sha: string; hours: number; now: Date }> = {}, key = FOUNDER.privateKeyPem): string {
  return signOverride({ sha: over.sha ?? SHA, reason: 'Supabase down; hotfix', now: over.now ?? NOW, hours: over.hours ?? 6 }, key);
}

function run(findings: GateFindings, token: string | undefined, over: { alertOk?: boolean; sha?: string; now?: Date } = {}) {
  const alerts: string[] = [];
  const records: string[] = [];
  return decide(findings, {
    token, sha: over.sha ?? SHA, now: over.now ?? NOW, publicKeys: [FOUNDER.publicKey],
    alert: async (text) => { alerts.push(text); return over.alertOk === false ? { ok: false, detail: 'telegram 502' } : { ok: true }; },
    record: async ({ body }) => { records.push(body); return 'alerts row written'; },
  }).then((d) => ({ ...d, alerts, records }));
}

test('DONE-TEST: THE FOUNDER\'S TOKEN LETS AN OUTAGE THROUGH, AND ANNOUNCES AND LOGS EVERY USE', async () => {
  const r = await run(OUTAGE, tokenFor());
  assert.equal(r.exit, 0);
  assert.equal(r.alerts.length, 1, 'a Telegram alert, every time');
  assert.match(r.alerts[0] ?? '', /OVERRIDDEN for deploy aaaaaaa[\s\S]*Reason: Supabase down; hotfix/);
  assert.equal(r.records.length, 1, 'and a durable log row');
  assert.ok(r.lines.some((l) => /OVERRIDDEN by the founder's key/.test(l)), 'and the build log says so');
});

test('DONE-TEST: A WRONG ANSWER IS NEVER OVERRIDDEN — ONLY WHAT COULD NOT BE CHECKED', async () => {
  const r = await run({ wrong: ['matrix case 2: expected «…», got «…»'], unchecked: OUTAGE.unchecked }, tokenFor());
  assert.equal(r.exit, 1);
  assert.equal(r.alerts.length, 0);
});

test('DONE-TEST: NO ALERT DELIVERED, NO OVERRIDE', async () => {
  const r = await run(OUTAGE, tokenFor(), { alertOk: false });
  assert.equal(r.exit, 2);
  assert.equal(r.records.length, 0);
  assert.match(r.lines.join(' '), /Telegram alert could not be sent/);
});

test('only the founder\'s key, only this commit, only inside the window', async () => {
  assert.equal((await run(OUTAGE, tokenFor({}, STRANGER.privateKeyPem))).exit, 2, 'a stranger\'s key');
  assert.equal((await run(OUTAGE, tokenFor({ sha: 'b'.repeat(40) }))).exit, 2, 'another commit');
  assert.equal((await run(OUTAGE, tokenFor(), { now: new Date(NOW.getTime() + 7 * 60 * 60_000) })).exit, 2, 'expired');
  assert.equal((await run(OUTAGE, tokenFor(), { sha: '' })).exit, 2, 'a build with no commit SHA');
  assert.equal((await run(OUTAGE, undefined)).exit, 2, 'no token');
  const tampered = tokenFor().replace(/^[^.]+/, Buffer.from(JSON.stringify({ v: 1, sha: SHA, issued: NOW.toISOString(),
    until: new Date(NOW.getTime() + 3600_000).toISOString(), reason: 'edited' })).toString('base64url'));
  assert.equal((await run(OUTAGE, tampered)).exit, 2, 'a payload edited after signing');
});

test('no registered key means nobody can override', () => {
  const v = verifyOverride(tokenFor(), { sha: SHA, now: NOW, publicKeys: [] });
  assert.deepEqual(v, { ok: false, why: 'no founder key is registered in overrideKeys.ts' });
});

test(`a token cannot be minted for more than ${OVERRIDE_MAX_HOURS} hours or without a reason`, () => {
  assert.throws(() => tokenFor({ hours: OVERRIDE_MAX_HOURS + 1 }));
  assert.throws(() => signOverride({ sha: SHA, reason: ' ', now: NOW, hours: 1 }, FOUNDER.privateKeyPem));
  assert.throws(() => signOverride({ sha: 'abc', reason: 'x', now: NOW, hours: 1 }, FOUNDER.privateKeyPem));
});

test('a passing gate never uses the override, even when a token is set', async () => {
  const r = await run({ wrong: [], unchecked: [] }, tokenFor());
  assert.equal(r.exit, 0);
  assert.equal(r.alerts.length, 0);
});
