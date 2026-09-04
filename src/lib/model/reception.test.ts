import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildRequest, classifyError, classifyResponse, isStale,
  RECEPTION_HISTORY_TURNS, RECEPTION_MAX_TOKENS, type ReceptionRequest,
} from './reception.ts';

const base: ReceptionRequest = {
  modelId: 'a-model-id',
  promptStable: 'STABLE PREFIX',
  promptVolatile: 'VOLATILE TAIL',
  cacheMode: '1h',
  history: [],
  customerMessage: 'Үнэ хэд вэ?',
  timeoutMs: 25_000,
};

// ---------------------------------------------------------------------------
// The wire shape. Three properties here are not stylistic.
// ---------------------------------------------------------------------------

test('thinking is pinned DISABLED — D-014, so it cannot eat the reply budget', () => {
  // The ancestor shares one MAX_TOKENS between thinking and the reply, so the customer
  // gets a truncated Mongolian half-sentence. Sonnet 5 rejects budget_tokens with a 400,
  // so there is no "just cap the thinking" option — off is the only setting.
  assert.deepEqual(buildRequest(base)['thinking'], { type: 'disabled' });
  assert.equal(buildRequest(base)['max_tokens'], RECEPTION_MAX_TOKENS);
});

test('`tools` is ABSENT, not an empty array', () => {
  // Reception is text-in, text-out. This is the single largest reduction in what a
  // successful prompt injection can achieve: there is no tool to call, so there is
  // nothing to make it call.
  assert.equal('tools' in buildRequest(base), false);
});

test('no sampling parameters — they are removed on Sonnet 5 and return a 400', () => {
  // Porting the ancestor's `temperature` would fail every single request.
  const req = buildRequest(base);
  for (const key of ['temperature', 'top_p', 'top_k']) {
    assert.equal(key in req, false, `${key} must not be sent`);
  }
});

test('the cache breakpoint sits on the STABLE block and nowhere else', () => {
  const system = buildRequest(base)['system'] as Record<string, unknown>[];
  assert.equal(system.length, 2);
  assert.deepEqual(system[0]?.['cache_control'], { type: 'ephemeral', ttl: '1h' });
  assert.equal('cache_control' in (system[1] ?? {}), false, 'the volatile tail is never cached');
  assert.equal(system[1]?.['text'], 'VOLATILE TAIL');
});

test('cacheMode off sends no cache_control at all, rather than an ephemeral default', () => {
  // An ephemeral block with the default 5m TTL would still be WRITTEN, and a write costs
  // 1.25x a plain read. "Caching off" that quietly pays the write premium is worse than
  // no caching.
  const system = buildRequest({ ...base, cacheMode: 'off' })['system'] as Record<string, unknown>[];
  assert.equal('cache_control' in (system[0] ?? {}), false);
});

test('an empty volatile tail produces one block, not a blank second one', () => {
  const system = buildRequest({ ...base, promptVolatile: '  ' })['system'] as unknown[];
  assert.equal(system.length, 1);
});

test('history is capped at ten turns and the customer message is last', () => {
  const history = Array.from({ length: 25 }, (_, i) => ({ role: 'user' as const, content: `turn ${i}` }));
  const messages = buildRequest({ ...base, history })['messages'] as Record<string, unknown>[];
  assert.equal(messages.length, RECEPTION_HISTORY_TURNS + 1);
  assert.equal(messages[0]?.['content'], 'turn 15');
  assert.equal(messages[messages.length - 1]?.['content'], 'Үнэ хэд вэ?');
});

test('every message is NFC-normalised on the way out', () => {
  const req = buildRequest({
    ...base,
    customerMessage: 'Сайн байна уу'.normalize('NFD'),
    history: [{ role: 'assistant', content: 'Ёлка'.normalize('NFD') }],
  });
  const messages = req['messages'] as Record<string, unknown>[];
  assert.equal(messages[0]?.['content'], 'Ёлка');
  assert.equal(messages[1]?.['content'], 'Сайн байна уу');
});

// ---------------------------------------------------------------------------
// Classification. The ancestor collapses three conditions into one and retries
// all of them — four paid calls for something that will never change.
// ---------------------------------------------------------------------------

test('A REFUSAL IS TERMINAL, and stop_reason is read BEFORE content', () => {
  // A safety refusal arrives as HTTP 200. Code that reaches for content[0].text first
  // sees a plausible body and mislabels a terminal condition as a normal reply — which
  // is exactly how one refusal becomes four paid calls.
  const r = classifyResponse({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber' },
    content: [{ type: 'text', text: 'энэ бол хариулт мэт харагдана' }],
    usage: { input_tokens: 9000, output_tokens: 12 },
  });
  assert.equal(r.kind, 'terminal');
  assert.equal(r.kind === 'terminal' && r.reason, 'refusal');
  assert.equal(r.kind === 'terminal' && r.category, 'cyber');
  assert.equal(r.kind === 'terminal' && r.usage?.input_tokens, 9000, 'a refusal is still billed and still settles');
});

test('max_tokens is terminal and the partial text is NOT returned', () => {
  const r = classifyResponse({
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'Эмэгтэй үс тайралтын үнэ нь' }],
    usage: { input_tokens: 9000, output_tokens: 700 },
  });
  assert.equal(r.kind === 'terminal' && r.reason, 'max_tokens');
  assert.equal(JSON.stringify(r).includes('Эмэгтэй'), false, 'a truncated Mongolian half-sentence must not reach a customer');
});

test('a genuinely empty end_turn is its own reason — the caller allows ONE retry', () => {
  const r = classifyResponse({ stop_reason: 'end_turn', content: [], usage: {} });
  assert.equal(r.kind === 'terminal' && r.reason, 'empty');
});

test('a normal reply comes back NFC-normalised, with usage and the model that served it', () => {
  const r = classifyResponse({
    stop_reason: 'end_turn',
    model: 'served-by-something',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '  Ёлка  '.normalize('NFD') }],
    usage: { input_tokens: 9000, output_tokens: 120, cache_read_input_tokens: 8800, cache_creation_input_tokens: 0 },
  });
  assert.equal(r.kind, 'ok');
  assert.equal(r.kind === 'ok' && r.text, 'Ёлка');
  assert.equal(r.kind === 'ok' && r.modelReturned, 'served-by-something');
  assert.equal(r.kind === 'ok' && r.usage.cache_read_input_tokens, 8800);
});

test('usage fields that are absent read as 0, never NaN — the ledger multiplies by these', () => {
  const r = classifyResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 'nine thousand' } });
  assert.equal(r.kind === 'ok' && r.usage.input_tokens, 0);
  assert.equal(r.kind === 'ok' && r.usage.cache_read_input_tokens, 0);
});

test('stop_details is read ONLY on a refusal — it is null for every other stop reason', () => {
  const r = classifyResponse({ stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: 'x' }], usage: {} });
  assert.equal(r.kind, 'ok');
});

// ---------------------------------------------------------------------------
// Errors: retryable vs terminal, decided by status and never by message text.
// ---------------------------------------------------------------------------

function apiError(Cls: new (s: number, e: unknown, m: string, h: Headers) => Error, status: number) {
  return new Cls(status, { type: 'error' }, `status ${status}`, new Headers());
}

test('a retired model id is TERMINAL and never falls back to another model', () => {
  // §6.10.5: a silent model swap changes the Mongolian quality with nothing visible
  // changing. Every tenant gets the pinned handoff line and the founder gets paged.
  const r = classifyError(apiError(Anthropic.NotFoundError as never, 404));
  assert.equal(r.kind === 'terminal' && r.reason, 'model_not_found');
});

test('auth and bad-request failures are terminal; retrying cannot change them', () => {
  assert.equal(classifyError(apiError(Anthropic.AuthenticationError as never, 401)).kind, 'terminal');
  assert.equal(classifyError(apiError(Anthropic.PermissionDeniedError as never, 403)).kind, 'terminal');
  assert.equal(classifyError(apiError(Anthropic.BadRequestError as never, 400)).kind, 'terminal');
});

test('429 and 5xx are retryable — the only cases QStash\'s retries are for', () => {
  const limited = classifyError(apiError(Anthropic.RateLimitError as never, 429));
  assert.equal(limited.kind === 'retryable' && limited.reason, 'rate_limited');
  const upstream = classifyError(apiError(Anthropic.InternalServerError as never, 503));
  assert.equal(upstream.kind === 'retryable' && upstream.reason, 'upstream');
});

test('a local abort is retryable, and it is a real cancellation rather than a lost race', () => {
  // The ancestor's withTimeout races a timer against a promise and never cancels the
  // underlying work, so the route returns while an Anthropic call is still in flight —
  // spending on a request nobody is waiting for. An AbortController genuinely stops it.
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const r = classifyError(abort);
  assert.equal(r.kind === 'retryable' && r.reason, 'timeout');
});

test('an unrecognised throw is retryable, not silently terminal', () => {
  assert.equal(classifyError(new Error('socket hang up')).kind, 'retryable');
});

// ---------------------------------------------------------------------------
// The pre-generation deadline.
// ---------------------------------------------------------------------------

test('an event older than the deadline is dropped BEFORE the call, so it costs nothing', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  assert.equal(isStale(new Date('2026-09-03T15:00:00Z'), now), true, '21 hours old');
  assert.equal(isStale(new Date('2026-09-04T00:00:00Z'), now), false, '12 hours old');
});
