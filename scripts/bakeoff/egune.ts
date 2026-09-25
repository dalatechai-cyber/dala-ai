/**
 * Egune as a Reception arm, for the bake-off ONLY.
 *
 * Nothing in `src/` imports this file, so production cannot reach it: a model swap there is
 * a registry change (`config/models.json`) plus a decision in DECISIONS.md, never an import
 * from `scripts/`. It exists so the same `handleReception` pipeline — the same prompt, gate,
 * guards and pinned lines — can be run with Egune in the model seat, and nothing else moved.
 *
 * ## The wire shape, and where it was read
 *
 * Egune's API is OpenAI-compatible. The official Node SDK (`egune` 1.0.0 on npm, published by
 * Chimege, Egune's parent) sends `POST {base}/chat/completions` with
 * `Authorization: Bearer <key>` to `https://api.egune.com/v1`, and reads the reply at
 * `choices[0].message.content` with an OPTIONAL `usage { prompt_tokens, completion_tokens }`.
 * Its pricing, context window and data-retention terms were NOT readable from here — every
 * official page is behind this environment's egress proxy — so nothing below assumes them.
 *
 * ## Mapping one request shape onto the other
 *
 * Anthropic takes the system prompt as two blocks (the cached prefix and the volatile tail);
 * the OpenAI shape takes one `system` message. They are joined with a blank line, which is
 * what the model would see in Anthropic's case too: two consecutive text blocks. Egune has no
 * prompt cache we know of, so `cacheMode` has nothing to map to and every call pays the full
 * prefix. That is the honest comparison against production, where D-072 measured 86.7% of
 * Sonnet 5 replies as cache MISSES.
 *
 * Third-party code using the same API strips `<think>…</think>` from replies and sends
 * `chat_template_kwargs: { enable_thinking: false }` to stop them. Both are done here: a
 * reasoning trace addressed to a salon customer would be a D-066 leak, and the harness counts
 * every reply it had to strip (`thinkStripped`) rather than hiding them.
 *
 * ## Classification mirrors `callReception`
 *
 * `finish_reason: 'length'` is `max_tokens` (terminal: the partial text is half a sentence),
 * an empty reply is `empty`, 401/403 `auth`, 404 `model_not_found`, 429 `rate_limited`
 * (retryable), 5xx `upstream`, a local deadline `timeout`. A quota or balance error is
 * terminal — retrying an empty wallet spends nothing and fixes nothing.
 */
import { nfc } from '../../src/lib/mn/text.ts';
import { RECEPTION_HISTORY_TURNS, RECEPTION_MAX_TOKENS, type CallOutcome, type ReceptionRequest } from '../../src/lib/model/reception.ts';

export const EGUNE_BASE_URL = 'https://api.egune.com/v1';
/**
 * What `GET /v1/models` lists for the founder's key (2026-09-25): `egune-nano`, and nothing
 * else. The official SDK README's `egune1-14b` answered every call with HTTP 503 "No available
 * servers for the requested model" — the first bake-off run measured nothing because of it.
 * `GET /v1/models` is the authority; the workflow prints it first for exactly this reason.
 */
export const EGUNE_DEFAULT_MODEL = 'egune-nano';

export type EguneOptions = {
  model: string;
  baseUrl?: string;
  /** Send `chat_template_kwargs.enable_thinking = false`. Off only to test whether it is accepted. */
  disableThinking?: boolean;
  fetchImpl?: typeof fetch;
};

/** What the harness records beyond the pipeline's own outcome. */
export type EguneTrace = { thinkStripped: boolean; finishReason: string; modelReturned: string };

const THINK = /<think>[\s\S]*?<\/think>/gu;
/** An unclosed `<think>` (the reply was cut inside it) leaves nothing safe to send. */
const OPEN_THINK = /<think>[\s\S]*$/u;

export function buildEguneRequest(input: ReceptionRequest, opts: EguneOptions): Record<string, unknown> {
  const system = input.promptVolatile.trim() === ''
    ? input.promptStable
    : `${input.promptStable}\n\n${input.promptVolatile}`;
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: RECEPTION_MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      ...input.history.slice(-RECEPTION_HISTORY_TURNS).map((m) => ({ role: m.role, content: nfc(m.content) })),
      { role: 'user', content: nfc(input.customerMessage) },
    ],
  };
  if (opts.disableThinking !== false) body['chat_template_kwargs'] = { enable_thinking: false };
  return body;
}

/** Classify a 200 response. Pure, so it is tested without a network. */
export function classifyEgune(response: unknown): { outcome: CallOutcome; trace: EguneTrace } {
  const r = (response ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(r['choices']) ? r['choices'] : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice['message'] ?? {}) as Record<string, unknown>;
  const finishReason = typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : '';
  const modelReturned = typeof r['model'] === 'string' ? r['model'] : '';
  const u = (r['usage'] ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage = { input_tokens: n(u['prompt_tokens']), output_tokens: n(u['completion_tokens']) };

  const raw = typeof message['content'] === 'string' ? message['content'] : '';
  const stripped = raw.replace(THINK, '').replace(OPEN_THINK, '');
  const trace: EguneTrace = { thinkStripped: stripped !== raw, finishReason, modelReturned };

  if (finishReason === 'length') {
    return { outcome: { kind: 'terminal', reason: 'max_tokens', detail: 'output ceiling hit; the partial reply is not safe to send', usage }, trace };
  }
  const text = stripped.trim();
  if (text === '') {
    return { outcome: { kind: 'terminal', reason: 'empty', detail: `no text with finish_reason ${finishReason || '<absent>'}`, usage }, trace };
  }
  return { outcome: { kind: 'ok', text: nfc(text), usage, modelReturned, stopReason: finishReason }, trace };
}

/** Classify an HTTP error by status and Egune's `error.code`, never by message text. */
export function classifyEguneError(status: number, body: unknown): CallOutcome {
  const e = ((body ?? {}) as Record<string, unknown>)['error'];
  const err = (e ?? {}) as Record<string, unknown>;
  const code = typeof err['code'] === 'string' ? err['code'] : typeof err['type'] === 'string' ? err['type'] : '';
  const detail = `HTTP ${status}${code === '' ? '' : ` ${code}`}: ${typeof err['message'] === 'string' ? err['message'] : ''}`.trim();
  if (code === 'insufficient_quota' || code === 'insufficient_funds') return { kind: 'terminal', reason: 'auth', detail };
  if (status === 401 || status === 403) return { kind: 'terminal', reason: 'auth', detail };
  if (status === 404) return { kind: 'terminal', reason: 'model_not_found', detail };
  if (status === 429) return { kind: 'retryable', reason: 'rate_limited', detail };
  if (status >= 500) return { kind: 'retryable', reason: 'upstream', detail };
  return { kind: 'terminal', reason: 'invalid_request', detail };
}

/**
 * Make the call. The key is an argument, read from the environment by the caller and never
 * logged; nothing here is module-scope.
 */
export async function callEgune(
  input: ReceptionRequest, apiKey: string, opts: EguneOptions,
): Promise<{ outcome: CallOutcome; trace: EguneTrace | null }> {
  const f = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await f(`${(opts.baseUrl ?? EGUNE_BASE_URL).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildEguneRequest(input, opts)),
      signal: controller.signal,
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { outcome: classifyEguneError(res.status, body), trace: null };
    return classifyEgune(body);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { outcome: { kind: 'retryable', reason: 'timeout', detail: 'aborted at the local deadline' }, trace: null };
    }
    return { outcome: { kind: 'retryable', reason: 'network', detail: err instanceof Error ? err.message : String(err) }, trace: null };
  } finally {
    clearTimeout(timer);
  }
}
