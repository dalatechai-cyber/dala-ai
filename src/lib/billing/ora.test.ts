import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deliverOraEvent, eventForDelivery, ORA_TEST_PACK, oraPackOrder, oraSignatureValid, packPaidEvent, runOraPackInvoiceJob, signOra,
} from './ora.ts';

const SECRET = 'ora-platform-secret-for-unit-tests-0000';
const ACCOUNT = '42bde4c0-3890-4ecf-a000-007867c131fa';
const ORDER = `ord_${'a1'.repeat(16)}`;
const NOW = new Date('2026-10-02T04:00:00Z');

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
}
const ENV = {
  BILLING_MODE: 'test', ORA_PLATFORM_SECRET: SECRET,
  DALA_PUBLIC_URL: 'https://api.dalatech.online', BILLING_LINK_SECRET: 'link-secret-that-is-long-enough-00000000', BILLING_PAY_ORIGIN: undefined,
};

type Calls = { rpc: Array<{ fn: string; args: Record<string, unknown> }>; reads: number };
function fakeDb(account: Record<string, unknown> | null, calls: Calls): () => SupabaseClient {
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { calls.reads += 1; return { data: account, error: null }; } }) }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return { data: { invoice_id: 'b0000000-0000-4000-8000-000000000001', invoice_no: 'TEST-202610-0007', created: true }, error: null };
    },
  };
  return () => db as unknown as SupabaseClient;
}
const ORA_TEST_ACCOUNT = { id: ACCOUNT, is_test: true, status: 'active', ora_account: true };

function request(over: Record<string, unknown> = {}, at: Date = NOW): string {
  return JSON.stringify({ v: 1, ts: at.toISOString(), account: ACCOUNT, order: ORDER, amount_mnt: 100, label: 'x', test: true, ...over });
}
async function call(body: string, opts: { sig?: string | null; account?: Record<string, unknown> | null | undefined } = {}) {
  const calls: Calls = { rpc: [], reads: 0 };
  const r = await runOraPackInvoiceJob({
    db: fakeDb(opts.account === undefined ? ORA_TEST_ACCOUNT : opts.account, calls), now: NOW, rawBody: body,
    signature: opts.sig === undefined ? signOra(SECRET, body) : opts.sig,
  });
  return { ...r, calls };
}

test('a pack invoice key names its Ора order; any other key is not a pack', () => {
  assert.equal(oraPackOrder(`one_off:ora-pack-${'a1'.repeat(16)}`), ORDER);
  assert.equal(oraPackOrder('one_off:ora-setup'), null);
  assert.equal(oraPackOrder(`one_off:ora-pack-${'A1'.repeat(16)}`), null);
  assert.equal(oraPackOrder('monthly_fee:2026-10'), null);
});

test('the signature is v1=<hex HMAC-SHA256>; altered, truncated or another secret is refused', () => {
  const body = request();
  const sig = signOra(SECRET, body);
  assert.match(sig, /^v1=[0-9a-f]{64}$/u);
  assert.equal(oraSignatureValid(SECRET, body, sig), true);
  assert.equal(oraSignatureValid(SECRET, `${body} `, sig), false);
  assert.equal(oraSignatureValid(SECRET, body, sig.slice(0, -1)), false);
  assert.equal(oraSignatureValid(`${SECRET}x`, body, sig), false);
  assert.equal(oraSignatureValid(SECRET, body, null), false);
  assert.equal(oraSignatureValid(SECRET, body, sig.toUpperCase()), false);
});

test('pack invoice: a good test request makes the 100₮ test pack, with this platform\'s line, keyed by the order', () => withEnv(ENV, async () => {
  const r = await call(request({ label: 'anything Ора sends' }));
  assert.equal(r.status, 200);
  assert.equal(r.body['invoice_no'], 'TEST-202610-0007');
  assert.match(String(r.body['pay_url']), /^https:\/\/api\.dalatech\.online\/pay\/TEST-202610-0007-[0-9A-Z]{6}$/u);
  assert.equal(r.calls.rpc.length, 1);
  const a = r.calls.rpc[0]!.args;
  assert.equal(r.calls.rpc[0]!.fn, 'billing_issue_one_off');
  assert.equal(a['p_key'], `ora-pack-${'a1'.repeat(16)}`);
  assert.equal(a['p_amount'], 100);
  assert.deepEqual(a['p_lines'], [{ label: ORA_TEST_PACK.label, amount_mnt: 100 }]);
  assert.equal(a['p_issued_on'], '2026-10-02');
  assert.equal(a['p_by'], 'ora');
}));

test('pack invoice: signature and time refused with 401 before the database is read', () => withEnv(ENV, async () => {
  const body = request();
  for (const [what, r] of [
    ['unsigned', await call(body, { sig: null })],
    ['altered', await call(body.replace('"amount_mnt":100', '"amount_mnt":101'), { sig: signOra(SECRET, body) })],
    ['another secret', await call(body, { sig: signOra('x'.repeat(40), body) })],
    ['stale (6 minutes old)', await call(request({}, new Date(NOW.getTime() - 6 * 60_000)))],
    ['from the future (6 minutes)', await call(request({}, new Date(NOW.getTime() + 6 * 60_000)))],
  ] as const) {
    assert.equal(r.status, 401, what);
    assert.equal(r.calls.reads + r.calls.rpc.length, 0, `${what}: nothing read or written`);
  }
}));

test('pack invoice: the amount and mode are fixed here; 49,000₮, live, other amounts and wrong accounts are refused', () => withEnv(ENV, async () => {
  const cases: Array<[string, string, Record<string, unknown> | null | undefined, string]> = [
    ['49,000₮ on a test account', request({ amount_mnt: 49000 }), undefined, 'wrong_amount'],
    ['a live request (the real pack is not enabled)', request({ test: false, amount_mnt: 49000 }), undefined, 'wrong_mode'],
    ['1₮', request({ amount_mnt: 1 }), undefined, 'wrong_amount'],
    ['"100" as a string', request({ amount_mnt: '100' }), undefined, 'bad_request'],
    ['a malformed order', request({ order: 'ord_123' }), undefined, 'bad_request'],
    ['a malformed account', request({ account: 'acct_1' }), undefined, 'bad_request'],
    ['an unknown account', request(), null, 'unknown_account'],
    ['an account not marked as Ора\'s (Tara, DalaTech)', request(), { ...ORA_TEST_ACCOUNT, ora_account: false }, 'not_an_ora_account'],
    ['an ended account', request(), { ...ORA_TEST_ACCOUNT, status: 'ended' }, 'account_not_active'],
    ['a live account asked as test', request(), { ...ORA_TEST_ACCOUNT, is_test: false }, 'wrong_mode'],
  ];
  for (const [what, body, account, reason] of cases) {
    const r = await call(body, { account });
    assert.equal(r.status, 422, what);
    assert.equal(r.body['reason'], reason, what);
    assert.equal(r.calls.rpc.length, 0, `${what}: no invoice`);
  }
}));

test('pack invoice: live billing refuses a test pack, and live packs stay refused', () => withEnv({ ...ENV, BILLING_MODE: 'live' }, async () => {
  assert.equal((await call(request())).body['reason'], 'wrong_mode');
  const live = await call(request({ test: false, amount_mnt: 49000 }), { account: { ...ORA_TEST_ACCOUNT, is_test: false } });
  assert.equal(live.status, 422);
  assert.equal(live.body['reason'], 'live_not_enabled');
  assert.equal(live.calls.rpc.length, 0);
}));

test('pack invoice: billing off, no secret, or a short secret is 503; too large is 413', async () => {
  await withEnv({ ...ENV, BILLING_MODE: undefined }, async () => assert.equal((await call(request())).status, 503));
  await withEnv({ ...ENV, ORA_PLATFORM_SECRET: undefined }, async () => assert.equal((await call(request())).status, 503));
  await withEnv({ ...ENV, ORA_PLATFORM_SECRET: 'short' }, async () => assert.equal((await call(request(), { sig: signOra('short', request()) })).status, 503));
  await withEnv(ENV, async () => assert.equal((await call(request({ label: 'x'.repeat(5000) }))).status, 413));
});

test('the event: stored without ts; each delivery adds a fresh ts and keeps the id', () => {
  const stored = packPaidEvent({ invoiceId: 'inv-1', invoiceNo: 'TEST-202610-0007', accountId: ACCOUNT, order: ORDER, amountMnt: 100, isTest: true });
  assert.equal('ts' in JSON.parse(stored), false);
  const a = JSON.parse(eventForDelivery(stored, new Date('2026-10-02T04:00:00Z')));
  const b = JSON.parse(eventForDelivery(stored, new Date('2026-10-02T09:00:00Z')));
  assert.deepEqual(Object.keys(a).slice(0, 3), ['v', 'id', 'ts']);
  assert.equal(a.id, 'pack.paid:inv-1');
  assert.equal(a.id, b.id);
  assert.notEqual(a.ts, b.ts);
  assert.deepEqual({ ...a, ts: 0 }, { v: 1, id: 'pack.paid:inv-1', ts: 0, type: 'pack.paid', account: ACCOUNT, order: ORDER, invoice: 'TEST-202610-0007', amount_mnt: 100, test: true });
  // Ора's own id rule (ora db 0009, billing_apply).
  assert.match(a.id, /^[A-Za-z0-9_:.-]{8,100}$/u);
});

test('delivering: signed body; 200 sent with Ора\'s outcome; 401/422 terminal; 5xx, 429 and no answer retried', async () => {
  const stored = packPaidEvent({ invoiceId: 'inv-1', invoiceNo: 'TEST-202610-0007', accountId: ACCOUNT, order: ORDER, amountMnt: 100, isTest: true });
  const endpoint = { url: 'https://ora.example/api/billing/webhook', secret: 'w'.repeat(40) };
  const seen: Array<{ body: string; sig: string | null; redirect: unknown }> = [];
  const answer = (status: number, json: unknown): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
    seen.push({ body: String(init?.body), sig: new Headers(init?.headers).get('x-ora-signature'), redirect: init?.redirect });
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  const at = new Date();
  const ok = await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, answer(200, { ok: true, outcome: 'credited' }));
  assert.deepEqual(ok, { outcome: 'sent', providerMessageId: 'ora:credited' });
  assert.equal(oraSignatureValid(endpoint.secret, seen[0]!.body, seen[0]!.sig), true);
  assert.equal(JSON.parse(seen[0]!.body).ts, at.toISOString());
  assert.equal(seen[0]!.redirect, 'manual');
  assert.deepEqual(await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, answer(200, { ok: true, duplicate: true })), { outcome: 'sent', providerMessageId: 'ora:duplicate' });
  assert.equal((await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, answer(401, { error: 'bad_signature' }))).outcome, 'terminal');
  const refused = await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, answer(422, { error: 'rejected' }));
  assert.deepEqual(refused, { outcome: 'terminal', detail: 'Ора answered HTTP 422 (rejected)' });
  assert.equal((await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, answer(302, {}))).outcome, 'terminal');
  for (const s of [500, 503, 429, 408]) assert.equal((await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, answer(s, {}))).outcome, 'retry', String(s));
  const dead = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.equal((await deliverOraEvent(endpoint, { body: stored, isTest: true }, at, dead)).outcome, 'retry');
});
