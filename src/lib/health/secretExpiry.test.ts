import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  checkSecretExpiry, raiseExpiryAlerts,
  EXPIRY_URGENT_DAYS, EXPIRY_WARN_DAYS,
} from './secretExpiry.ts';

const NOW = new Date('2026-09-21T03:00:00Z');
const inDays = (d: number): string => new Date(NOW.getTime() + d * 86_400_000).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  tenant_id: 't-1', kind: 'page_token', status: 'active',
  expires_at: null, data_access_expires_at: null, ...over,
});

/** Answers one select on `tenant_secrets`, and records what was written to `alerts`. */
function stub(answer: { data?: unknown; error?: unknown }) {
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  const filters: string[] = [];
  const from = (table: string) => {
    // `raiseAlert` reads `alerts` twice on one call and the two need OPPOSITE answers: the
    // duplicate check must find nothing, and the insert that follows must come back with a
    // row or `claim` reports failure. A stub that answers both the same way makes every
    // alert look refused, which is a test failing for a reason the code does not have.
    let inserted = false;
    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    chain['in'] = (col: string, val: unknown) => (filters.push(`in:${col}=${JSON.stringify(val)}`), chain);
    chain['eq'] = () => chain;
    chain['is'] = () => chain;
    chain['gte'] = () => chain;
    chain['order'] = () => chain;
    chain['limit'] = () => chain;
    chain['insert'] = (patch: Record<string, unknown>) => {
      writes.push({ table, patch });
      inserted = true;
      return chain;
    };
    const reply = () => (table !== 'alerts' ? answer : inserted ? { data: { id: 1 }, error: null } : { data: null, error: null });
    chain['maybeSingle'] = async () => reply();
    chain['then'] = (res: (v: unknown) => unknown) => res(reply());
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, writes, filters };
}

test('DONE-TEST: AN UNREADABLE TABLE IS NOT "NOTHING IS EXPIRING"', () => {
  // The whole reason this module exists is that the platform could not see an expiry
  // coming. A checker that answers "clean" when it failed to ask reproduces that blindness
  // with a green tick on top, which is strictly worse. The caller turns this into a 503.
  return checkSecretExpiry(stub({ data: null, error: { message: 'boom' } }).db, { now: NOW })
    .then((r) => {
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.detail : '', /unreadable/);
    });
});

test('DONE-TEST: A CREDENTIAL WITH NO DATES IS UNKNOWN, NOT SAFE', async () => {
  // Every row written before `0035` reads NULL on both clocks, and so does any credential
  // sealed without the `debug_token` values. Counting those as fine is how a silence turns
  // into a reassurance (D-070).
  const r = await checkSecretExpiry(stub({ data: [row()], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.unknown, 1, 'reported as unknown');
  assert.equal(r.findings.length, 0, 'and NOT alerted — we know nothing, so we claim nothing');
});

test('a date comfortably in the future says nothing at all', async () => {
  // Matrix on the day this shipped: data access lapses 2026-12-20, ninety days out. One
  // line a day about a date in December is how a real alert gets missed.
  const r = await checkSecretExpiry(
    stub({ data: [row({ data_access_expires_at: inDays(90) })], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.unknown, 0, 'it is known — just not urgent');
  assert.deepEqual(r.findings, []);
});

test('inside the warning window it goes to the DIGEST, not to Telegram', async () => {
  const r = await checkSecretExpiry(
    stub({ data: [row({ data_access_expires_at: inDays(EXPIRY_WARN_DAYS - 1) })], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]?.severity, 'warn');
  assert.equal(r.findings[0]?.route, 'digest');
  assert.equal(r.findings[0]?.clock, 'data_access_expires_at');
});

test('inside the urgent window it becomes a message', async () => {
  const r = await checkSecretExpiry(
    stub({ data: [row({ data_access_expires_at: inDays(EXPIRY_URGENT_DAYS - 1) })], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.findings[0]?.severity, 'critical');
  assert.equal(r.findings[0]?.route, 'now');
});

test('DONE-TEST: BOTH CLOCKS ARE READ, AND "NEVER EXPIRES" DOES NOT COVER DATA ACCESS', async () => {
  // The trap this module is shaped around. Matrix's live token has `expires_at: 0` — it
  // genuinely never expires — and its data access still lapses about ninety days after the
  // last authorization. A checker reading only `expires_at` would call that credential
  // permanently healthy and reproduce D-109 on a longer fuse.
  const r = await checkSecretExpiry(
    stub({ data: [row({ expires_at: null, data_access_expires_at: inDays(3) })], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.findings.length, 1, 'the NULL expires_at contributes nothing, and does not silence the other');
  assert.equal(r.findings[0]?.clock, 'data_access_expires_at');
  assert.equal(r.findings[0]?.severity, 'critical');

  // And both fire independently when both are near.
  const both = await checkSecretExpiry(
    stub({ data: [row({ expires_at: inDays(2), data_access_expires_at: inDays(5) })], error: null }).db, { now: NOW });
  assert.ok(both.ok);
  assert.deepEqual(both.findings.map((f) => f.clock), ['expires_at', 'data_access_expires_at']);
});

test('an already-lapsed credential reports as lapsed, with a negative count', async () => {
  const r = await checkSecretExpiry(
    stub({ data: [row({ data_access_expires_at: inDays(-4) })], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.findings[0]?.severity, 'critical');
  assert.ok((r.findings[0]?.daysLeft ?? 0) < 0);
});

test('an UNREADABLE date is a finding, never folded into "unknown"', async () => {
  // Something wrote a value and we cannot read it. That is a different fault from never
  // having had one, and burying it in the unknown count would make a corrupted date
  // indistinguishable from an honest blank.
  const r = await checkSecretExpiry(
    stub({ data: [row({ data_access_expires_at: 'not-a-date' })], error: null }).db, { now: NOW });
  assert.ok(r.ok);
  assert.equal(r.unknown, 0);
  assert.equal(r.findings.length, 1);
  assert.ok(Number.isNaN(r.findings[0]?.daysLeft ?? 0));
});

test('only live credentials are asked about', async () => {
  // A revoked row is already halted and already alerted; telling somebody it will also
  // expire is noise about a fault they are holding.
  const s = stub({ data: [], error: null });
  await checkSecretExpiry(s.db, { now: NOW });
  assert.ok(s.filters.some((f) => f.startsWith('in:status=') && f.includes('active') && f.includes('rotating')),
    `status was not narrowed: ${JSON.stringify(s.filters)}`);
});

test('the alert body names the clock, the direction, and that nothing renews it', async () => {
  const s = stub({ data: [], error: null });
  // The digest route on purpose: `raiseAlert` short-circuits before Telegram for it, so
  // this exercises the body and the key without a unit test reaching the network.
  const out = await raiseExpiryAlerts(s.db, [
    { tenantId: 't-1', kind: 'page_token', clock: 'data_access_expires_at', daysLeft: 5, severity: 'warn', route: 'digest' },
  ]);
  assert.equal(out.failed, 0);
  const alert = s.writes.find((w) => w.table === 'alerts');
  assert.equal(alert?.patch['kind'], 'secret.expiring');
  const body = String(alert?.patch['body'] ?? '');
  assert.match(body, /data access lapses in 5 day\(s\)/);
  assert.match(body, /nothing here renews it automatically/);
  // The severity belongs in the key: crossing from the 30-day note into the 7-day message
  // is a different condition, and without it the earlier suppression eats the urgent one.
  assert.match(String(alert?.patch['dedup_key'] ?? ''), /secret_expiring:t-1:page_token:data_access_expires_at:warn/);
});
