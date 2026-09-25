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
    chain['like'] = () => chain;
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
  ], { now: NOW });
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

// ---------------------------------------------------------------------------
// D-128: both severities are EPISODES, closed when the credential stops qualifying.
// ---------------------------------------------------------------------------

type AlertRow = { id: number; dedup_key: string; severity: string; route: string; repeat_policy: string; resolved_at: string | null };

/** A stateful `alerts` table: enough of PostgREST for raise, suppress and resolve. */
function alertsTable(opts: { resolveFails?: boolean } = {}) {
  const rows: AlertRow[] = [];
  const from = () => {
    const f: { key?: string; like?: string; open?: boolean; policy?: string; ids?: number[] } = {};
    let insert: Record<string, unknown> | null = null;
    let patch: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    const hits = () => rows.filter((r) => (f.key === undefined || r.dedup_key === f.key)
      && (f.like === undefined || r.dedup_key.startsWith(f.like))
      && (!f.open || r.resolved_at === null)
      && (f.policy === undefined || r.repeat_policy === f.policy)
      && (f.ids === undefined || f.ids.includes(r.id)));
    chain['select'] = () => chain;
    chain['limit'] = () => chain;
    chain['order'] = () => chain;
    chain['eq'] = (c: string, v: string) => { if (c === 'dedup_key') f.key = v; if (c === 'repeat_policy') f.policy = v; return chain; };
    chain['is'] = () => { f.open = true; return chain; };
    chain['like'] = (_c: string, v: string) => { f.like = v.replace(/%$/, ''); return chain; };
    chain['in'] = (_c: string, v: unknown[]) => { f.ids = v.map(Number); return chain; };
    chain['insert'] = (r: Record<string, unknown>) => {
      insert = r;
      rows.push({ id: rows.length + 1, dedup_key: String(r['dedup_key']), severity: String(r['severity']),
        route: String(r['route']), repeat_policy: String(r['repeat_policy']), resolved_at: null });
      return chain;
    };
    chain['update'] = (p: Record<string, unknown>) => { patch = p; return chain; };
    chain['maybeSingle'] = async () => {
      if (insert !== null) return { data: { id: rows.length }, error: null };
      const h = hits();
      return { data: h[0] === undefined ? null : { id: h[0].id }, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => {
      if (patch !== null) {
        if (opts.resolveFails) return res({ data: null, error: { message: 'alerts unwritable' } });
        for (const r of hits()) r.resolved_at = String(patch['resolved_at']);
        return res({ data: null, error: null });
      }
      if (opts.resolveFails && f.like !== undefined) return res({ data: null, error: { message: 'alerts unreadable' } });
      return res({ data: hits().map((r) => ({ ...r, id: r.id, kind: 'secret.expiring', body: '', at: NOW.toISOString(), notified_at: null, tenant_id: 't-1' })), error: null });
    };
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, rows };
}

const warnFinding = { tenantId: 't-1', kind: 'page_token', clock: 'data_access_expires_at' as const, daysLeft: 20, severity: 'warn' as const, route: 'digest' as const };
const critFinding = { ...warnFinding, daysLeft: 5, severity: 'critical' as const, route: 'now' as const };

test('DONE-TEST: BOTH SEVERITIES ARE ON_CHANGE EPISODES — the warning included, so the digest lists it', async () => {
  // The 30-day warning was `daily` under a dateless key: written once, routed to a digest
  // that lists only on_change rows, and therefore shown to nobody (the inventory, B9).
  process.env['ALERTS_ENABLED'] = 'false';
  const t = alertsTable();
  await raiseExpiryAlerts(t.db, [warnFinding], { now: NOW });
  await raiseExpiryAlerts(t.db, [warnFinding], { now: NOW });
  assert.equal(t.rows.length, 1, 'an unchanged condition is one row, however many hourly runs see it');
  assert.equal(t.rows[0]?.repeat_policy, 'on_change');
  assert.equal(t.rows[0]?.route, 'digest');

  const u = alertsTable();
  await raiseExpiryAlerts(u.db, [critFinding], { now: NOW });
  assert.equal(u.rows[0]?.repeat_policy, 'on_change');
  assert.equal(u.rows[0]?.route, 'now', 'the critical still pages at once');
});

test('DONE-TEST: A RE-SEALED CREDENTIAL CLOSES ITS EPISODE, AND RUNNING DOWN AGAIN ALERTS AGAIN', async () => {
  // The once-ever failure: a credential re-sealed and then run down a quarter later was
  // silent the second time, because the old row still existed.
  process.env['ALERTS_ENABLED'] = 'false';
  const t = alertsTable();
  await raiseExpiryAlerts(t.db, [critFinding], { now: NOW });
  const later = new Date(NOW.getTime() + 3_600_000);
  const cleared = await raiseExpiryAlerts(t.db, [], { now: later });   // re-sealed: nothing qualifies
  assert.equal(cleared.resolved, 1);
  assert.equal(t.rows[0]?.resolved_at, later.toISOString());

  await raiseExpiryAlerts(t.db, [critFinding], { now: later });
  assert.equal(t.rows.length, 2, 'a second lapse is a second episode');
  assert.equal(t.rows[1]?.resolved_at, null);
});

test('crossing from warn into critical closes the warning as the critical opens', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const t = alertsTable();
  await raiseExpiryAlerts(t.db, [warnFinding], { now: NOW });
  const r = await raiseExpiryAlerts(t.db, [critFinding], { now: NOW });
  assert.equal(r.resolved, 1);
  assert.deepEqual(t.rows.map((x) => [x.severity, x.resolved_at === null]), [['warn', false], ['critical', true]]);
});

test('a finding still true keeps its episode open, and other tenants are untouched by the family resolve', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const t = alertsTable();
  const other = { ...warnFinding, tenantId: 't-2' };
  await raiseExpiryAlerts(t.db, [warnFinding, other], { now: NOW });
  const r = await raiseExpiryAlerts(t.db, [warnFinding, other], { now: NOW });
  assert.equal(r.resolved, 0);
  assert.ok(t.rows.every((x) => x.resolved_at === null));
});

test('a resolve that cannot be written is REPORTED, and the episodes stay open', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const t = alertsTable({ resolveFails: true });
  const r = await raiseExpiryAlerts(t.db, [], { now: NOW });
  assert.equal(r.resolveFailed, true);
  assert.equal(r.resolved, 0);
});
