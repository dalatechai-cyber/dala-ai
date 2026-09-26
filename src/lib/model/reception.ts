/**
 * The Reception model call (V1.md 3.2).
 *
 * ## Everything here classifies a failure before it retries one
 *
 * The ancestor collapses three unrelated conditions into one `'Empty response from
 * Claude'` throw and lets QStash retry it three times — **four paid calls for a condition
 * that will never change.** The general rule it is missing:
 *
 * > Classify retryable (5xx, 429, network, timeout) from terminal (4xx auth, refusal,
 * > `max_tokens`, budget exhausted) and stop on terminal.
 *
 * A retry loop on a permanent condition burns money, burns the Meta rate budget, and
 * delays the customer's fallback by three round trips.
 *
 * ## `stop_reason` is read BEFORE `content`
 *
 * A safety refusal arrives as **HTTP 200**. Code that reaches for `content[0].text`
 * first sees an empty or partial body and mislabels a terminal condition as an empty
 * response — which is exactly how one refusal becomes four paid calls.
 *
 * ## Three request properties that are not stylistic
 *
 *  - **`thinking: { type: 'disabled' }`.** D-014: the ancestor shares one `MAX_TOKENS`
 *    between thinking and the reply, so thinking eats the reply budget and the customer
 *    gets a truncated Mongolian half-sentence. Sonnet 5 accepts `disabled`; it rejects
 *    `budget_tokens` outright with a 400, so there is no "just cap the thinking" option.
 *  - **`tools` is ABSENT, not an empty array.** Reception is text-in, text-out. This is
 *    the single largest reduction in what a successful prompt injection can achieve:
 *    there is no tool to call, so there is nothing to make it call.
 *  - **No `temperature`, `top_p` or `top_k`.** Sampling parameters are removed on Sonnet
 *    5 and return a 400. Porting the ancestor's `temperature` would fail every request.
 */
import Anthropic from '@anthropic-ai/sdk';
import { nfc } from '../mn/text.ts';
import type { Usage } from '../spend/settle.ts';

/**
 * The output ceiling, matched to the ancestor's 1024 — and the gap cost a real customer.
 *
 * At 700 this was BELOW what the ancestor has run in production for months, and
 * `max_tokens` is classified terminal here (correctly: the partial text is half a
 * Mongolian sentence). So a reply that merely ran long was discarded and the customer got
 * the handoff line instead. Measured in production 2026-09-21 08:28:45 UTC:
 * `answered_with_handoff { code: 'model_max_tokens' }` on a live turn.
 *
 * Note what this is NOT a licence for. The founder's complaint the same night was replies
 * that were TOO LONG — 1,020 characters by the eleventh turn. That had a different cause
 * (D-111: the assistant's own turns never reached history, so the model re-answered the
 * whole thread every time) and the fix for it is history, plus a brevity instruction in
 * the prompt. Raising the ceiling stops a good reply being thrown away; it is not how
 * reply length is controlled, and raising it further would not fix anything.
 *
 * Mongolian runs ~1.41 characters per token (D-072), so 1024 is roughly 1,450 characters
 * — comfortably above the ancestor's measured p90 of 364.
 */
export const RECEPTION_MAX_TOKENS = 1024;

/** Turns of history sent back. Beyond ten adds cost without adding context. */
export const RECEPTION_HISTORY_TURNS = 10;

/**
 * Older than this and we do not call the model at all. Free, before the spend, and the
 * same shape as the comment private-reply seven-day check. Messenger's window is 24
 * hours, so a reply generated at hour 23 is a race we should not enter.
 */
export const STALE_EVENT_HOURS = 20;

export type ReceptionRequest = {
  modelId: string;
  /** L0+L1+L2+L3. Byte-stable per (tenant, config_version). Carries the breakpoint. */
  promptStable: string;
  /** L4. Volatile, uncached, and structurally incapable of touching the prefix. */
  promptVolatile: string;
  cacheMode: 'off' | '5m' | '1h';
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  customerMessage: string;
  timeoutMs: number;
};

export type TerminalReason =
  /** HTTP 200 with stop_reason 'refusal'. Never retry; send the pinned handoff line. */
  | 'refusal'
  /** The output ceiling was hit. The partial text may be half a Mongolian sentence. */
  | 'max_tokens'
  /** stop_reason 'end_turn' with no text block. ONE retry is reasonable, then handoff. */
  | 'empty'
  /** The model id is gone. Pages the founder — never fall back to a different model. */
  | 'model_not_found'
  /** 401/403: the key is invalid, revoked or not permitted. Pages the founder at once. */
  | 'auth'
  /**
   * The account cannot pay: HTTP 402 / `billing_error`, or the 400 Anthropic actually sent
   * on 2026-09-25 when credit ran out. Every reply on the platform is the handoff line until
   * a human tops up, so it pages the founder at once, like `auth`.
   */
  | 'billing'
  | 'invalid_request'
  /** We refused to call at all — the event is older than the messaging window allows. */
  | 'stale_event';

export type RetryableReason = 'rate_limited' | 'upstream' | 'timeout' | 'network';

export type CallOutcome =
  | { kind: 'ok'; text: string; usage: Usage; modelReturned: string; stopReason: string }
  | { kind: 'terminal'; reason: TerminalReason; detail: string; usage?: Usage; category?: string }
  | { kind: 'retryable'; reason: RetryableReason; detail: string };

/**
 * Is this event too old to answer? Checked BEFORE the model call, so a stale event costs
 * nothing at all rather than a full generation nobody is waiting for.
 */
export function isStale(eventAt: Date, now: Date, hours = STALE_EVENT_HOURS): boolean {
  return now.getTime() - eventAt.getTime() > hours * 3_600_000;
}

/** Extract Anthropic's `usage` block, keeping the two cache fields the bill turns on. */
function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(u['input_tokens']),
    output_tokens: n(u['output_tokens']),
    cache_read_input_tokens: n(u['cache_read_input_tokens']),
    cache_creation_input_tokens: n(u['cache_creation_input_tokens']),
  };
}

/**
 * The customer's reply out of what the model wrote (D-133).
 *
 * Why this exists: the gate checklist asks the model to walk the Ш-rules before answering,
 * thinking is off (D-014), and so the model walked them IN the reply. Every caught leak had
 * the same shape — a first paragraph «Ш0 (…) болон Ш2 (…) хамаарч байна.», a blank line,
 * then the real answer — and the guard then threw the real answer away with it (case 20,
 * «2 ajiltan avbal hungulult bga yu», served the handoff line instead of the discounts).
 * The instruction «never write the labels» was already in the prompt; it was a request the
 * model kept breaking because the checklist had nowhere else to go.
 *
 * So it gets somewhere: `<check>…</check>` for the walk, `<reply>…</reply>` for the customer
 * (`reception/volatile.ts`). This returns the `<reply>` body. A model that ignores the
 * format loses nothing: with no `<reply>`, every `<check>` block is removed and the rest is
 * the reply, exactly as before. Everything downstream — every guard, the label guard
 * included — still reads what is returned here, so a label written INSIDE `<reply>` is
 * refused as it always was.
 */
export function replyOf(text: string): string {
  const open = text.indexOf('<reply>');
  if (open !== -1) {
    const from = open + '<reply>'.length;
    const close = text.indexOf('</reply>', from);
    return stripTags(close === -1 ? text.slice(from) : text.slice(from, close)).trim();
  }
  // No reply tag: drop the checks (a check left unclosed runs to the end — it is not an answer).
  const noChecks = text.replace(/<check>[\s\S]*?(?:<\/check>|$)/gu, '');
  return stripTags(noChecks).trim();
}

function stripTags(t: string): string {
  return t.replace(/<\/?(?:reply|check)>/gu, '');
}

/**
 * Classify a response the API returned successfully. Exported because it is the part
 * worth testing exhaustively, and it has no network in it.
 *
 * The order of the checks is the specification: `stop_reason` first, `content` last.
 */
export function classifyResponse(response: unknown): CallOutcome {
  const r = (response ?? {}) as Record<string, unknown>;
  const usage = readUsage(r['usage']);
  const stopReason = typeof r['stop_reason'] === 'string' ? r['stop_reason'] : '';
  const modelReturned = typeof r['model'] === 'string' ? r['model'] : '';

  // 1. A safety refusal arrives as HTTP 200. Terminal, and never retried.
  if (stopReason === 'refusal') {
    // `stop_details` is populated ONLY for a refusal and is null for every other stop
    // reason, so it is read here and nowhere else.
    const details = (r['stop_details'] ?? {}) as Record<string, unknown>;
    const category = typeof details['category'] === 'string' ? details['category'] : 'unknown';
    return { kind: 'terminal', reason: 'refusal', detail: `refused: ${category}`, usage, category };
  }

  // 2. The output ceiling. The partial text may be a truncated Mongolian half-sentence,
  //    so it is NOT sent. This is the D-014 failure, and it disappears once thinking is
  //    pinned off and max_tokens is sized for the reply alone.
  if (stopReason === 'max_tokens') {
    return { kind: 'terminal', reason: 'max_tokens', detail: 'output ceiling hit; the partial reply is not safe to send', usage };
  }

  // 3. Only now is `content` read.
  const content = Array.isArray(r['content']) ? r['content'] : [];
  const text = content
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // 4. Only the reply leaves this function; the model's own check never does (D-133).
  const reply = replyOf(text);
  if (reply === '') {
    return { kind: 'terminal', reason: 'empty', detail: `no reply text with stop_reason ${stopReason || '<absent>'}`, usage };
  }

  return { kind: 'ok', text: nfc(reply), usage, modelReturned, stopReason };
}

/**
 * Is this the account being unable to pay?
 *
 * The one place this file reads message text, and why: when credit ran out on 2026-09-25
 * Anthropic answered **HTTP 400, `invalid_request_error`**, «Your credit balance is too low
 * to access the Anthropic API» — the same status and type as a malformed request, so status
 * alone cannot tell "we sent something wrong" from "nobody is paying". The documented
 * `402 billing_error` is checked first, by status and by body type; the message is the
 * fallback for the shape actually observed. If the wording changes, the error falls back to
 * `invalid_request` and is still flagged per reply — quieter, never refused.
 */
export function isBillingError(err: InstanceType<typeof Anthropic.APIError>): boolean {
  if (err.status === 402) return true;
  const body = err.error as { error?: { type?: unknown } } | undefined;
  if (body?.error?.type === 'billing_error') return true;
  return err.status === 400 && /credit balance|purchase credits|plans\s*&\s*billing/i.test(err.message);
}

/**
 * Classify a thrown error. Retryable and terminal are decided by status, not by message
 * text — string-matching an error message is how a retry loop survives a rename.
 */
export function classifyError(err: unknown): CallOutcome {
  if (err instanceof Anthropic.NotFoundError) {
    // §6.10.5: a retired model id is not a crash, it is the feature quietly becoming
    // something else. Terminal, and it pages the founder — NEVER a silent fall back to a
    // different model, because that changes the Mongolian quality with nothing visible
    // changing.
    return { kind: 'terminal', reason: 'model_not_found', detail: err.message };
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'terminal', reason: 'auth', detail: err.message };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: 'retryable', reason: 'rate_limited', detail: err.message };
  }
  if (err instanceof Anthropic.APIError && isBillingError(err)) {
    return { kind: 'terminal', reason: 'billing', detail: err.message };
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return { kind: 'terminal', reason: 'invalid_request', detail: err.message };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: 'retryable', reason: 'timeout', detail: err.message };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'retryable', reason: 'network', detail: err.message };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    if (status >= 500) return { kind: 'retryable', reason: 'upstream', detail: err.message };
    return { kind: 'terminal', reason: 'invalid_request', detail: `HTTP ${status}: ${err.message}` };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { kind: 'retryable', reason: 'timeout', detail: 'aborted at the local deadline' };
  }
  return { kind: 'retryable', reason: 'network', detail: err instanceof Error ? err.message : String(err) };
}

/**
 * Build the request body. Separated from the call so the wire shape is testable without
 * a network, an API key, or a cent of spend.
 */
export function buildRequest(input: ReceptionRequest): Record<string, unknown> {
  const stable: Record<string, unknown> = { type: 'text', text: input.promptStable };
  // No cache_control at all when caching is off — an ephemeral block with a 5m default
  // would still be written, and a write costs 1.25x a plain read.
  if (input.cacheMode !== 'off') {
    stable['cache_control'] = { type: 'ephemeral', ttl: input.cacheMode };
  }

  const system: Record<string, unknown>[] = [stable];
  // The volatile tail is its OWN block with no cache_control. This is what makes the
  // ancestor's trap structurally unavailable: it concatenates the closure section onto
  // the cached base prompt, so the moment anything date-shaped joins that string every
  // request writes a fresh entry, caching silently stops, and the bill roughly triples.
  if (input.promptVolatile.trim() !== '') {
    system.push({ type: 'text', text: input.promptVolatile });
  }

  return {
    model: input.modelId,
    max_tokens: RECEPTION_MAX_TOKENS,
    thinking: { type: 'disabled' },
    system,
    messages: [
      ...input.history.slice(-RECEPTION_HISTORY_TURNS).map((m) => ({ role: m.role, content: nfc(m.content) })),
      { role: 'user', content: nfc(input.customerMessage) },
    ],
    // NOTE: `tools` is deliberately absent, and so are temperature/top_p/top_k —
    // the sampling parameters are removed on Sonnet 5 and return a 400.
  };
}

/**
 * Make the call.
 *
 * The client is constructed HERE, per call, and never at module scope. Two reasons, and
 * the second is the one that matters: CLAUDE.md rule 7 forbids a module-scope credential
 * cache because warm lambdas are reused across tenants, and Track 2's named done-test is
 * that a tenant at its cap is refused *before an Anthropic client is constructed*. A
 * module-scope client would make that test unwritable.
 */
export async function callReception(
  input: ReceptionRequest,
  apiKey: string,
): Promise<CallOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    const response = await client.messages.create(
      buildRequest(input) as never,
      { signal: controller.signal },
    );
    return classifyResponse(response);
  } catch (err) {
    return classifyError(err);
  } finally {
    // Always clear it. A pending timer holds the lambda open past the response.
    clearTimeout(timer);
  }
}
