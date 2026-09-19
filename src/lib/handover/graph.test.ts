import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { passThreadControl, takeThreadControl } from './graph.ts';

const BASE = { pageId: '1520409424715591', psid: 'PSID1', token: 'T0K3N', graphVersion: 'v21.0' };

type Seen = { url?: string | undefined; init?: RequestInit | undefined };

function fakeFetch(res: { status: number; body?: string }, seen: Seen) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(res.body ?? '{"success":true}', { status: res.status });
  }) as unknown as typeof fetch;
}

const bodyOf = (seen: Seen) => JSON.parse(String(seen.init?.body ?? '{}'));

test('a 200 is ACCEPTED, never "passed" — Graph took the call, control is proven by the webhook', async () => {
  const seen: Seen = {};
  const r = await passThreadControl({ ...BASE, targetAppId: '263902037430900', fetchImpl: fakeFetch({ status: 200 }, seen) });
  assert.equal(r.outcome, 'accepted');
});

test('the page id is explicit: /me is refused on both calls', async () => {
  for (const call of [
    () => passThreadControl({ ...BASE, pageId: 'me', targetAppId: 'A', fetchImpl: fakeFetch({ status: 200 }, {}) }),
    () => takeThreadControl({ ...BASE, pageId: 'me', fetchImpl: fakeFetch({ status: 200 }, {}) }),
  ]) {
    const r = await call();
    assert.equal(r.outcome, 'failed');
    assert.match(r.outcome === 'failed' ? r.detail : '', /\/me/);
  }
});

test('a pass with no target app is refused rather than letting Graph choose an owner', async () => {
  const r = await passThreadControl({ ...BASE, targetAppId: '', fetchImpl: fakeFetch({ status: 200 }, {}) });
  assert.equal(r.outcome, 'failed');
  assert.match(r.outcome === 'failed' ? r.detail : '', /no target app/);
});

test('an empty thread or token is refused before any request is made', async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  assert.equal((await takeThreadControl({ ...BASE, psid: '', fetchImpl: spy })).outcome, 'failed');
  assert.equal((await takeThreadControl({ ...BASE, token: '', fetchImpl: spy })).outcome, 'failed');
  assert.equal(called, false, 'a refusal must not reach the network');
});

test('the body carries recipient.id, and target_app_id only on a pass', async () => {
  const p: Seen = {}; const t: Seen = {};
  await passThreadControl({ ...BASE, targetAppId: '263902037430900', fetchImpl: fakeFetch({ status: 200 }, p) });
  await takeThreadControl({ ...BASE, fetchImpl: fakeFetch({ status: 200 }, t) });

  assert.deepEqual(bodyOf(p).recipient, { id: 'PSID1' });
  assert.equal(bodyOf(p).target_app_id, '263902037430900');
  assert.deepEqual(bodyOf(t).recipient, { id: 'PSID1' });
  assert.ok(!('target_app_id' in bodyOf(t)), 'take names no target');
  assert.match(String(p.url), /\/pass_thread_control$/);
  assert.match(String(t.url), /\/take_thread_control$/);
});

test('metadata is ABSENT when not given, and an empty string is a value that is sent', async () => {
  const none: Seen = {}; const empty: Seen = {};
  await takeThreadControl({ ...BASE, fetchImpl: fakeFetch({ status: 200 }, none) });
  await takeThreadControl({ ...BASE, metadata: '', fetchImpl: fakeFetch({ status: 200 }, empty) });
  assert.ok(!('metadata' in bodyOf(none)));
  assert.equal(bodyOf(empty).metadata, '');
});

test('the token is in the Authorization header and never in the URL', async () => {
  const seen: Seen = {};
  await takeThreadControl({ ...BASE, fetchImpl: fakeFetch({ status: 200 }, seen) });
  assert.equal((seen.init?.headers as Record<string, string>)['authorization'], 'Bearer T0K3N');
  assert.ok(!String(seen.url).includes('T0K3N'), 'the token must never reach the query string');
});

test('a known Graph code classifies as the send path classifies it', async () => {
  const r = await takeThreadControl({
    ...BASE,
    fetchImpl: fakeFetch({ status: 400, body: '{"error":{"code":190,"error_subcode":460}}' }, {}),
  });
  assert.equal(r.outcome, 'failed');
  if (r.outcome !== 'failed') return;
  assert.equal(r.failure, 'token_revoked');
  assert.equal(r.retryable, false);
  assert.equal(r.code, 190);
  assert.equal(r.subcode, 460);
});

test('an UNRECOGNISED 4xx is terminal and a 5xx is transient — a refused call is not retried forever', async () => {
  const four = await takeThreadControl({ ...BASE, fetchImpl: fakeFetch({ status: 403, body: '{"error":{"code":99999}}' }, {}) });
  const five = await takeThreadControl({ ...BASE, fetchImpl: fakeFetch({ status: 503 }, {}) });
  assert.equal(four.outcome === 'failed' && four.retryable, false);
  assert.equal(five.outcome === 'failed' && five.retryable, true);
});

test('a non-JSON error body is classified by status rather than throwing', async () => {
  const r = await takeThreadControl({ ...BASE, fetchImpl: fakeFetch({ status: 502, body: '<html>gateway</html>' }, {}) });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.outcome === 'failed' ? r.code : 'x', null);
});

test('a connection that provably never opened is transient; anything else is INDETERMINATE', async () => {
  const never = (async () => { const e = new Error('nope') as Error & { code: string }; e.code = 'ECONNREFUSED'; throw e; }) as unknown as typeof fetch;
  const maybe = (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch;

  const a = await takeThreadControl({ ...BASE, fetchImpl: never });
  assert.equal(a.outcome, 'failed');
  assert.equal(a.outcome === 'failed' && a.retryable, true);

  // The load-bearing one: an answer that never arrived must NOT read as "it did not
  // happen". The caller resolves it towards silence; see the module header.
  const b = await takeThreadControl({ ...BASE, fetchImpl: maybe });
  assert.equal(b.outcome, 'indeterminate');
});

test('NEVER_CONNECTED is kept in step with the send path, which the module docstring claims', () => {
  const setOf = (src: string) => {
    const m = /const NEVER_CONNECTED = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(m !== null, 'NEVER_CONNECTED not found — this check must fail loudly, never vacuously');
    return new Set([...String(m[1]).matchAll(/'([^']+)'/g)].map((x) => x[1]));
  };
  const mine = setOf(readFileSync(new URL('./graph.ts', import.meta.url), 'utf8'));
  const theirs = setOf(readFileSync(new URL('../meta/send.ts', import.meta.url), 'utf8'));
  assert.ok(mine.size > 0);
  assert.deepEqual([...mine].sort(), [...theirs].sort(),
    'the two lists of provably-never-connected error codes have drifted apart');
});
