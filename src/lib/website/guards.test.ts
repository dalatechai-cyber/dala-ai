import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consumeRate, windowStart } from './ratelimit.ts';
import { verifyTurnstile } from './turnstile.ts';

const NOW = new Date('2026-09-18T18:34:17.500Z');
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Answers `bump_web_rate` with a counter per (bucket, window), like the real function. */
function rateDb(override?: { data?: unknown; error?: unknown }) {
  const counters = new Map<string, number>();
  const args: Record<string, unknown>[] = [];
  const db = {
    rpc: async (fn: string, params: Record<string, unknown>) => {
      assert.equal(fn, 'bump_web_rate');
      args.push(params);
      if (override) return { data: override.data ?? null, error: override.error ?? null };
      const key = `${params['p_tenant_id']}|${params['p_bucket_key']}|${params['p_window_start']}`;
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return { data: next, error: null };
    },
  } as never;
  return { db, args };
}

const call = (db: never, over: Partial<{ limit: number; bucketKey: string }> = {}, now = NOW) =>
  consumeRate(db, { tenantId: 't-1', bucketKey: 'mint:abc', limit: 3, windowMs: MINUTE, ...over }, now);

test('a window is floored, so two requests in the same minute share a counter', () => {
  const a = windowStart(new Date('2026-09-18T18:34:00.000Z'), MINUTE);
  const b = windowStart(new Date('2026-09-18T18:34:59.999Z'), MINUTE);
  assert.equal(a.toISOString(), b.toISOString());
  assert.equal(a.toISOString(), '2026-09-18T18:34:00.000Z');
  assert.notEqual(windowStart(new Date('2026-09-18T18:35:00.000Z'), MINUTE).toISOString(), a.toISOString());
});

test('requests up to the limit pass and the one after it does not', async () => {
  const { db } = rateDb();
  for (let i = 1; i <= 3; i += 1) {
    const r = await call(db);
    assert.equal(r.ok, true, `request ${i}`);
    assert.equal(r.ok === true && r.count, i);
  }
  const over = await call(db);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.reason, 'rate_limited');
});

test('DONE-TEST: the counter is per bucket AND per tenant, not global', async () => {
  const { db } = rateDb();
  for (let i = 0; i < 3; i += 1) await call(db);
  assert.equal((await call(db)).ok, false, 'this bucket is spent');
  assert.equal((await call(db, { bucketKey: 'mint:different' })).ok, true, 'a different caller is not');
});

test('a new window starts a new count', async () => {
  const { db } = rateDb();
  for (let i = 0; i < 3; i += 1) await call(db);
  assert.equal((await call(db)).ok, false);
  const nextWindow = new Date(NOW.getTime() + MINUTE);
  assert.equal((await call(db, {}, nextWindow)).ok, true);
});

test('DONE-TEST: the fixed-window give is 2x the limit across a boundary, and is bounded', async () => {
  // Stated rather than discovered. A sliding window would be tighter at the boundary and
  // costs a row per request or a read-modify-write; the point of this limiter is to bound a
  // flood, which it does, unlike the in-process Map it replaces.
  const { db } = rateDb();
  const endOfWindow = new Date(NOW.getTime());
  const startOfNext = new Date(windowStart(NOW, MINUTE).getTime() + MINUTE);
  let passed = 0;
  for (let i = 0; i < 6; i += 1) if ((await call(db, {}, endOfWindow)).ok) passed += 1;
  for (let i = 0; i < 6; i += 1) if ((await call(db, {}, startOfNext)).ok) passed += 1;
  assert.equal(passed, 6, 'exactly 2 x limit, never more');
});

test('DONE-TEST: a limiter that cannot be consulted REFUSES', async () => {
  // Rule 2. The thing behind this gate is anonymous traffic against a paid model, so the
  // failure mode of opening is somebody else's money.
  const { db } = rateDb({ error: { message: 'connection reset' } });
  const r = await call(db);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'rate_unavailable');
});

test('an unreadable count refuses rather than being treated as zero', async () => {
  for (const data of [null, undefined, '3', 0, -1, 2.5, {}]) {
    const { db } = rateDb({ data });
    const r = await call(db);
    assert.equal(r.ok, false, JSON.stringify(data) ?? 'undefined');
    assert.equal(r.ok === false && r.reason, 'rate_unavailable', JSON.stringify(data) ?? 'undefined');
  }
});

test('a nonsensical limit or window refuses instead of being coerced into one', async () => {
  const { db } = rateDb();
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    const r = await consumeRate(db, { tenantId: 't', bucketKey: 'b', limit, windowMs: MINUTE }, NOW);
    assert.equal(r.ok === false && r.reason, 'rate_unavailable', String(limit));
  }
  for (const windowMs of [0, -1000, Number.NaN]) {
    const r = await consumeRate(db, { tenantId: 't', bucketKey: 'b', limit: 3, windowMs }, NOW);
    assert.equal(r.ok === false && r.reason, 'rate_unavailable', String(windowMs));
  }
});

test('the RPC is asked for by the name the migration creates, in public', () => {
  // D-029's third bug: `db.rpc('reserve_spend')` resolved against the `public` profile while
  // the function lived in `app`, and every reply for every tenant refused. Read from the
  // migration rather than trusted.
  const sql = readFileSync('supabase/migrations/0031_website_channel.sql', 'utf8');
  assert.match(sql, /create or replace function public\.bump_web_rate\(/);
  assert.match(sql, /grant execute on function public\.bump_web_rate\([^)]*\) to postgres, service_role/);
});

test('the RPC parameter names match what the code sends', async () => {
  const { db, args } = rateDb();
  await call(db);
  assert.deepEqual(Object.keys(args[0]!).sort(), ['p_bucket_key', 'p_tenant_id', 'p_window_start']);
  const sql = readFileSync('supabase/migrations/0031_website_channel.sql', 'utf8');
  for (const p of ['p_tenant_id', 'p_bucket_key', 'p_window_start']) assert.match(sql, new RegExp(`\\n  ${p} `));
});

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

const okFetch = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('a verified token passes', async () => {
  assert.deepEqual(await verifyTurnstile('tok', 'secret', undefined, okFetch({ success: true })), { ok: true });
});

test('DONE-TEST: a missing secret is unavailable, never a pass', async () => {
  // "No fallback to a default credential" extends to "no fallback to no credential".
  for (const secret of [undefined, '']) {
    const r = await verifyTurnstile('tok', secret, undefined, okFetch({ success: true }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'turnstile_unavailable');
  }
});

test('a missing secret is reported as OUR fault, not the caller\'s', async () => {
  // turnstile_failed would send an operator looking at the visitor. A retry cannot help.
  const r = await verifyTurnstile('tok', '', undefined, okFetch({ success: true }));
  assert.equal(r.ok === false && r.reason, 'turnstile_unavailable');
  const missingToken = await verifyTurnstile('', 'secret', undefined, okFetch({ success: true }));
  assert.equal(missingToken.ok === false && missingToken.reason, 'turnstile_missing');
});

test('DONE-TEST: only success === true passes — never a truthy value', async () => {
  // `if (body.success)` passes on the STRING "false", which is what a form-encoded or
  // loosely-typed proxy would hand back.
  for (const success of ['true', 'false', 1, {}, [], 'yes']) {
    const r = await verifyTurnstile('tok', 'secret', undefined, okFetch({ success }));
    assert.equal(r.ok, false, JSON.stringify(success));
    assert.equal(r.ok === false && r.reason, 'turnstile_unavailable', JSON.stringify(success));
  }
});

test('an explicit failure is a failure, and carries Cloudflare\'s codes', async () => {
  const r = await verifyTurnstile('tok', 'secret', undefined, okFetch({ success: false, 'error-codes': ['invalid-input-response'] }));
  assert.equal(r.ok === false && r.reason, 'turnstile_failed');
  assert.equal(r.ok === false && r.detail, 'invalid-input-response');
});

test('a non-200, a non-JSON body and a thrown fetch all refuse', async () => {
  const cases: Array<typeof fetch> = [
    okFetch({ success: true }, 503),
    (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch,
    (async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch,
  ];
  for (const f of cases) {
    const r = await verifyTurnstile('tok', 'secret', undefined, f);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'turnstile_unavailable');
  }
});

test('DONE-TEST: there is no bypass flag in the module\'s CODE', () => {
  // A development bypass is one dashboard edit from being live, and its failure is silent.
  //
  // The first version of this test matched the raw file and failed on its own docstring,
  // which names TURNSTILE_DISABLED in order to say it does not exist. An assertion about
  // code that reads comments is not an assertion about code — so the comments are stripped
  // first, and what is left is what actually runs.
  const src = readFileSync('src/lib/website/turnstile.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /export async function verifyTurnstile/, 'the strip did not eat the code');
  assert.equal(/TURNSTILE_DISABLED|NODE_ENV|process\.env/.test(src), false,
    'the secret is passed IN; this module reads no environment and has no off switch');
});

test('the request is no-store — rule 8 is not only about Supabase', async () => {
  let init: RequestInit | undefined;
  const spy = (async (_url: string, i: RequestInit) => {
    init = i;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  await verifyTurnstile('tok', 'secret', '203.0.113.7', spy);
  assert.equal(init?.cache, 'no-store');
  assert.match(String(init?.body), /remoteip=203\.0\.113\.7/);
  assert.match(String(init?.body), /secret=secret/);
});
