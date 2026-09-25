import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEguneRequest, callEgune, classifyEgune, classifyEguneError } from './egune.ts';
import { fixtureDb } from './fixtureDb.ts';
import { RECEPTION_HISTORY_TURNS, RECEPTION_MAX_TOKENS, type ReceptionRequest } from '../../src/lib/model/reception.ts';

const req = (over: Partial<ReceptionRequest> = {}): ReceptionRequest => ({
  modelId: 'ignored-by-egune', promptStable: 'STABLE', promptVolatile: 'VOLATILE', cacheMode: '1h',
  history: [], customerMessage: 'Сайн байна уу', timeoutMs: 1_000, ...over,
});

test('the system prompt is the stable prefix then the volatile tail, as one message', () => {
  const b = buildEguneRequest(req(), { model: 'egune1-14b' }) as { messages: { role: string; content: string }[]; max_tokens: number; model: string };
  assert.equal(b.model, 'egune1-14b');
  assert.equal(b.max_tokens, RECEPTION_MAX_TOKENS);
  assert.deepEqual(b.messages[0], { role: 'system', content: 'STABLE\n\nVOLATILE' });
  assert.deepEqual(b.messages.at(-1), { role: 'user', content: 'Сайн байна уу' });
});

test('history is capped exactly as the Sonnet request caps it', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }));
  const b = buildEguneRequest(req({ history }), { model: 'm' }) as { messages: unknown[] };
  assert.equal(b.messages.length, 1 + RECEPTION_HISTORY_TURNS + 1);
});

test('thinking is asked off by default, and can be left out', () => {
  assert.deepEqual((buildEguneRequest(req(), { model: 'm' }) as Record<string, unknown>)['chat_template_kwargs'], { enable_thinking: false });
  assert.equal('chat_template_kwargs' in buildEguneRequest(req(), { model: 'm', disableThinking: false }), false);
});

test('a reply is read from choices[0].message.content with usage mapped', () => {
  const { outcome, trace } = classifyEgune({ model: 'egune1-14b', choices: [{ finish_reason: 'stop', message: { content: ' Сайн байна уу! ' } }], usage: { prompt_tokens: 900, completion_tokens: 40 } });
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.equal(outcome.text, 'Сайн байна уу!');
  assert.deepEqual(outcome.usage, { input_tokens: 900, output_tokens: 40 });
  assert.equal(trace.thinkStripped, false);
});

test('a reasoning trace is stripped and COUNTED, never sent', () => {
  const { outcome, trace } = classifyEgune({ choices: [{ finish_reason: 'stop', message: { content: '<think>the price rule says…</think>Сайн байна уу!' } }] });
  assert.equal(outcome.kind === 'ok' && outcome.text, 'Сайн байна уу!');
  assert.equal(trace.thinkStripped, true);
});

test('a reply cut inside its reasoning leaves nothing to send', () => {
  const { outcome } = classifyEgune({ choices: [{ finish_reason: 'stop', message: { content: '<think>still thinking about' } }] });
  assert.equal(outcome.kind === 'terminal' && outcome.reason, 'empty');
});

test('finish_reason length is max_tokens, terminal: half a sentence is not sent', () => {
  const { outcome } = classifyEgune({ choices: [{ finish_reason: 'length', message: { content: 'Сайн байна' } }] });
  assert.equal(outcome.kind === 'terminal' && outcome.reason, 'max_tokens');
});

test('errors are classified by status and code, never by message text', () => {
  assert.deepEqual([401, 403, 404, 429, 500, 400].map((s) => {
    const o = classifyEguneError(s, { error: { message: 'x' } });
    return `${o.kind}:${o.reason}`;
  }), ['terminal:auth', 'terminal:auth', 'terminal:model_not_found', 'retryable:rate_limited', 'retryable:upstream', 'terminal:invalid_request']);
  // An empty wallet is terminal even when the status looks retryable.
  assert.equal(classifyEguneError(429, { error: { code: 'insufficient_quota' } }).kind, 'terminal');
});

test('the call sends a Bearer key to /chat/completions and a deadline is a retryable timeout', async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const ok = await callEgune(req(), 'eg-k', {
    model: 'm', baseUrl: 'https://egune.test/v1/',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get('authorization') };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Тийм' } }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(seen, { url: 'https://egune.test/v1/chat/completions', auth: 'Bearer eg-k' });
  assert.equal(ok.outcome.kind, 'ok');

  const slow = await callEgune(req({ timeoutMs: 20 }), 'eg-k', {
    model: 'm',
    fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch,
  });
  assert.equal(slow.outcome.kind === 'retryable' && slow.outcome.reason, 'timeout');
});

// ---------------------------------------------------------------- fixtureDb

const dump = {
  tenants: [{ id: 't1', slug: 's' }],
  forbidden_phrasings: [{ gate: 'a', stems: [], tenant_id: null }, { gate: 'b', stems: [], tenant_id: 't1' }, { gate: 'c', stems: [], tenant_id: 't2' }],
  tenant_closures: [{ tenant_id: 't1', ends_on: '2026-09-01', title: 'old' }, { tenant_id: 't1', ends_on: '2026-10-01', title: 'new' }],
};

test('fixtureDb answers the loader\'s query shapes', async () => {
  const db = fixtureDb(dump);
  const or = await db.from('forbidden_phrasings').select('gate, tenant_id').or('tenant_id.is.null,tenant_id.eq.t1');
  assert.deepEqual((or.data as { gate: string }[]).map((r) => r.gate), ['a', 'b']);
  const gte = await db.from('tenant_closures').select('title').eq('tenant_id', 't1').gte('ends_on', '2026-09-25');
  assert.deepEqual(gte.data, [{ title: 'new' }]);
  const one = await db.from('tenants').select('slug').eq('id', 't1').maybeSingle();
  assert.deepEqual(one.data, { slug: 's' });
});

test('fixtureDb is read-only and refuses what it cannot answer exactly', () => {
  const db = fixtureDb(dump) as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown>; rpc: () => unknown };
  assert.throws(() => db.from('tenants')['insert']!({}), /read-only/);
  assert.throws(() => db.from('tenants')['update']!({}), /read-only/);
  assert.throws(() => db.rpc(), /read-only/);
  assert.throws(() => db.from('not_dumped'), /not in the dump/);
});

test('fixtureDb refuses a column the dump does not have rather than returning undefined', async () => {
  const db = fixtureDb(dump);
  await assert.rejects(async () => { await db.from('tenants').select('slug, nope'); }, /not in the dump/);
});
