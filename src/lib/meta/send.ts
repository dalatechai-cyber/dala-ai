/**
 * The Messenger Send API call (V1.md 3.5).
 *
 * One function, one HTTP request, no database and no state. Everything about *whether* to
 * send lives in `outbound/claim.ts` and `outbound/deliver.ts`; this decides only what the
 * wire looks like and what the answer meant.
 *
 * ## `/{page-id}/messages`, never `/me/messages`
 *
 * `lib/messengerClient.js:10` in the ancestor hardcodes `/me/messages`, which resolves the
 * Page **from the token**. Ported unchanged into a multi-tenant system that is the single
 * most dangerous line in the file: a token/tenant mismatch does not error, it *succeeds
 * and posts as the wrong salon*, with a 200 OK and nothing to catch. With the id in the
 * path the same mistake is a Graph error. `pageId` is therefore required, and the literal
 * `me` is refused rather than merely discouraged.
 *
 * ## The token is a header, and appears in no other place
 *
 * Not the query string (it would land in Meta's access logs, in any proxy's, and in ours),
 * not the body, and not any error this module raises. The ancestor gets this right and it
 * is carried deliberately rather than by accident.
 *
 * ## Three outcomes, not two
 *
 * `sent` and `failed` are not enough. A request that left and whose answer never arrived
 * may have been delivered; retrying it replies to the customer twice, and marking it
 * failed loses the reply. So there is `indeterminate`, and the classification below is
 * careful about which network errors can be *proved* not to have reached Meta:
 *
 *  - the connection was never established (`ECONNREFUSED`, DNS, TLS) → `failed`, retryable
 *  - anything else, timeouts and resets included → `indeterminate`
 *
 * The default is `indeterminate` because §3.5.3 chooses silence over a duplicate: silence
 * still reaches the Quality layer as an unanswered question, and a duplicate reply has no
 * equivalent of that.
 */

/** Read from `config/platform.ts`'s clock budget in the caller; the ancestor uses 10 s. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/** Enough for any Graph error; a body larger than this is not one we should be parsing. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type SendFailure =
  /** Graph 190. Terminal. Halt outbound on this channel, mark the secret revoked, page. */
  | 'token_revoked'
  /** Graph 200 / 10. Terminal. A scope lost at App Review, or a task role removed. Page. */
  | 'channel_permission_error'
  /** Graph 100. Terminal. May name the recipient — mark the contact, never the token. */
  | 'recipient_unreachable'
  /** Graph 230. Terminal and quiet: the person has opted out of being messaged. */
  | 'consent_withheld'
  /** Graph 9010. Terminal. */
  | 'bot_validation'
  /** Graph 613. Retryable, backing off THIS tenant only. Re-send stored text. */
  | 'rate_limited'
  /** 5xx, or a connection that provably never opened. Retryable. */
  | 'transient'
  /** A Graph error we have no rule for. Classified by HTTP status — see `classify`. */
  | 'unknown';

export type SendOutcome =
  | { outcome: 'sent'; providerMessageId: string; recipientId: string | null }
  | {
      outcome: 'failed';
      failure: SendFailure;
      retryable: boolean;
      /** Meta's numeric code, for `tenant_secrets.last_error_code`. Never a message. */
      code: number | null;
      subcode: number | null;
      status: number | null;
      detail: string;
    }
  /** The request left and the answer never arrived. Do not re-send. Do not mark failed. */
  | { outcome: 'indeterminate'; detail: string };

export type SendInput = {
  /** The channel's `external_id`. The literal `me` is refused. */
  pageId: string;
  /** The customer's PSID. */
  recipientId: string;
  text: string;
  token: string;
  graphVersion: string;
  timeoutMs?: number;
  /** Test seam. Production passes nothing and gets the platform `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Every Graph code this codebase has a rule for, from §3.4.4's taxonomy — itself read from
 * Chatwoot's production Instagram handler rather than invented here.
 *
 * `2534014` (a private reply already sent for this comment) is deliberately absent: it is
 * success-equivalent for a surface V1 does not have. Adding it now would be an untested
 * branch guarding a feature that does not exist.
 */
const BY_CODE: Record<number, { failure: SendFailure; retryable: boolean }> = {
  190: { failure: 'token_revoked', retryable: false },
  200: { failure: 'channel_permission_error', retryable: false },
  10: { failure: 'channel_permission_error', retryable: false },
  100: { failure: 'recipient_unreachable', retryable: false },
  230: { failure: 'consent_withheld', retryable: false },
  9010: { failure: 'bot_validation', retryable: false },
  613: { failure: 'rate_limited', retryable: true },
};

/**
 * Turn a Graph response into a failure classification.
 *
 * An unrecognised code falls back to the **HTTP status**, and the asymmetry there is
 * deliberate: a 5xx is Meta's problem and worth retrying, while an unrecognised 4xx is a
 * request Meta will reject identically next time. Retrying it forever is how a queue turns
 * into a rate-limit ban on the app every tenant shares — the failure mode §3.4.4 warns
 * about for `190` specifically, and which applies to any permanent 4xx.
 */
export function classify(status: number, code: number | null): { failure: SendFailure; retryable: boolean } {
  const known = code === null ? undefined : BY_CODE[code];
  if (known !== undefined) return known;
  if (status >= 500) return { failure: 'transient', retryable: true };
  return { failure: 'unknown', retryable: false };
}

/**
 * Did this error happen before anything could have reached Meta?
 *
 * Only these are provable. A timeout, a reset, a socket hang up — all of those can happen
 * after the request was received and acted upon, so they are NOT here, and the caller
 * treats their absence as `indeterminate`.
 */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function errorCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur != null && depth < 5; depth += 1) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Read a bounded amount of the body. A response too large to be a Graph reply is not one. */
async function boundedText(res: Response): Promise<string> {
  const body = res.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Send one text message on one tenant's token.
 *
 * Takes the token as an argument rather than reading it: the decision about *which*
 * tenant's credential this is belongs to the caller, which has the tenant id, and a
 * function that fetched its own credential would be one refactor away from caching it.
 */
export async function sendMessage(input: SendInput): Promise<SendOutcome> {
  if (input.pageId === '' || input.pageId === 'me') {
    // Not a warning in a comment. `me` resolves the Page from the token, so a
    // token/tenant mismatch would succeed as the wrong salon instead of erroring.
    return {
      outcome: 'failed',
      failure: 'unknown',
      retryable: false,
      code: null,
      subcode: null,
      status: null,
      detail: "refusing to send to '/me/messages': the page id must be explicit",
    };
  }
  if (input.recipientId === '') {
    return { outcome: 'failed', failure: 'unknown', retryable: false, code: null, subcode: null, status: null, detail: 'no recipient' };
  }
  if (input.text === '') {
    return { outcome: 'failed', failure: 'unknown', retryable: false, code: null, subcode: null, status: null, detail: 'refusing to send an empty message' };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${input.graphVersion}/${encodeURIComponent(input.pageId)}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        // The token lives here and nowhere else. Never a query parameter.
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // RESPONSE is the reply-inside-the-window type. The window itself is checked by
        // the eligibility gate before this is reached; Meta checks it again.
        messaging_type: 'RESPONSE',
        recipient: { id: input.recipientId },
        message: { text: input.text },
      }),
      signal: controller.signal,
      // Belt and braces with the shared clients' policy: nothing here is cacheable, and a
      // cached POST would be a re-send.
      cache: 'no-store',
    });
  } catch (e) {
    const code = errorCode(e);
    if (code !== null && NEVER_CONNECTED.has(code)) {
      return {
        outcome: 'failed',
        failure: 'transient',
        retryable: true,
        code: null,
        subcode: null,
        status: null,
        detail: `connection never established (${code})`,
      };
    }
    // Timeouts, resets, and anything unrecognised. The bytes may have arrived.
    return { outcome: 'indeterminate', detail: `send did not complete (${code ?? (e as Error).name})` };
  } finally {
    clearTimeout(timer);
  }

  let raw: string;
  try {
    raw = await boundedText(res);
  } catch (e) {
    // The status arrived but the body did not. Meta has already acted on the request.
    return { outcome: 'indeterminate', detail: `response body unreadable (${(e as Error).name})` };
  }

  let parsed: unknown = null;
  try {
    parsed = raw === '' ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;

  if (res.ok) {
    const messageId = obj['message_id'];
    if (typeof messageId !== 'string' || messageId === '') {
      // A 2xx with no message id. Meta almost certainly delivered it, and we cannot say
      // so — which is exactly what `indeterminate` is for. Re-sending would double-reply.
      return { outcome: 'indeterminate', detail: 'send returned 2xx with no message_id' };
    }
    const recipientId = obj['recipient_id'];
    return {
      outcome: 'sent',
      providerMessageId: messageId,
      recipientId: typeof recipientId === 'string' ? recipientId : null,
    };
  }

  const err = (obj['error'] ?? {}) as Record<string, unknown>;
  const code = typeof err['code'] === 'number' ? err['code'] : null;
  const subcode = typeof err['error_subcode'] === 'number' ? err['error_subcode'] : null;
  const { failure, retryable } = classify(res.status, code);

  // Meta's own message is NOT carried into `detail`. An authentication error is the one
  // string most likely to quote the credential back, and `detail` is written to
  // `outbound_messages.refused_reason` and read in logs. The numeric code and the trace id
  // are what an operator actually needs to open a Meta support case.
  const trace = typeof err['fbtrace_id'] === 'string' ? err['fbtrace_id'] : null;
  return {
    outcome: 'failed',
    failure,
    retryable,
    code,
    subcode,
    status: res.status,
    detail: `graph ${res.status} code=${code ?? '?'} subcode=${subcode ?? '?'}${trace === null ? '' : ` fbtrace=${trace}`}`,
  };
}
