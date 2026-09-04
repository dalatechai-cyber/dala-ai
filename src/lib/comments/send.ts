/**
 * Post one public reply to a comment (§3.8.3).
 *
 * The comment-surface twin of `meta/send.ts`, and separate from it for the same reason
 * `comments.ts` is separate from `extract.ts`: a DM and a public post are different
 * surfaces with different consequences, and there must be no code path where one can be
 * mistaken for the other. What they share is the shape of an answer — three outcomes, the
 * Graph taxonomy, and a token that appears only in a header.
 *
 * ## The edge is UNVERIFIED, and it is isolated so that being wrong is a one-line fix
 *
 * `docs/architecture/00-research-notes.md` records `POST /{comment-id}/comments` as
 * SEARCH-CORROBORATED with an explicit "re-verify the exact edge", because one indexed
 * source claims `POST /{comment-id}` instead. I could not confirm it either:
 * `developers.facebook.com` is blocked by this environment's egress proxy.
 *
 * So the edge is one exported constant with the uncertainty written next to it. If the
 * first real attempt returns a Graph 100 naming the path, changing `REPLY_EDGE` is the
 * whole fix — no call sites, no tests, no reasoning to redo. That is the difference
 * between an unverified fact costing a minute and costing an afternoon.
 *
 * ## Nothing here decides WHAT to post
 *
 * `body` arrives already chosen by `eligibility.ts`, which never saw the customer's text.
 * This function cannot compose, append to, or vary it — it puts the given bytes on the
 * wire. A public surface is the wrong place for a function that could do otherwise.
 */
import { classify, DEFAULT_SEND_TIMEOUT_MS, type SendFailure } from '../meta/send.ts';

/**
 * The Graph edge for a public reply to a comment. **UNVERIFIED** — see the module note.
 *
 * The well-established form, and the one Chatwoot's production handler uses. The
 * competing claim is `POST /{comment-id}` with a `message` parameter. If Meta returns a
 * 100 naming the path, that is the signal, and this constant is the fix.
 */
export const REPLY_EDGE = 'comments';

export type CommentSendOutcome =
  | { outcome: 'sent'; providerCommentId: string }
  | {
      outcome: 'failed';
      failure: SendFailure;
      retryable: boolean;
      code: number | null;
      subcode: number | null;
      status: number | null;
      detail: string;
    }
  /** The request left and the answer never arrived. Do not re-post. */
  | { outcome: 'indeterminate'; detail: string };

export type CommentSendInput = {
  /** The comment being replied to. */
  commentId: string;
  /** The tenant's own pinned line, already chosen. Never composed here. */
  body: string;
  token: string;
  graphVersion: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const MAX_RESPONSE_BYTES = 64 * 1024;

function errorCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur != null && depth < 5; depth += 1) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Only errors that PROVE nothing reached Meta. See `meta/send.ts` for the full argument. */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

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

const refuse = (detail: string): CommentSendOutcome => ({
  outcome: 'failed',
  failure: 'unknown',
  retryable: false,
  code: null,
  subcode: null,
  status: null,
  detail,
});

export async function sendCommentReply(input: CommentSendInput): Promise<CommentSendOutcome> {
  if (input.commentId === '') return refuse('no comment id');
  if (input.body.trim() === '') {
    // An empty public reply under a customer's comment is worse than none: it reads as the
    // salon posting nothing at all, deliberately, and it cannot be un-posted.
    return refuse('refusing to post an empty public reply');
  }

  const doFetch = input.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${input.graphVersion}/${encodeURIComponent(input.commentId)}/${REPLY_EDGE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        // The token lives here and nowhere else. Never a query parameter — a public
        // surface's access log is the last place a credential should end up.
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: input.body }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (e) {
    const code = errorCode(e);
    if (code !== null && NEVER_CONNECTED.has(code)) {
      return {
        outcome: 'failed', failure: 'transient', retryable: true,
        code: null, subcode: null, status: null,
        detail: `connection never established (${code})`,
      };
    }
    // A timeout or a reset. The comment may already be public; posting again would put
    // two identical replies under one customer's comment, permanently.
    return { outcome: 'indeterminate', detail: `reply did not complete (${code ?? (e as Error).name})` };
  } finally {
    clearTimeout(timer);
  }

  let raw: string;
  try {
    raw = await boundedText(res);
  } catch (e) {
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
    // A successful reply returns the new comment's id.
    const id = obj['id'];
    if (typeof id !== 'string' || id === '') {
      return { outcome: 'indeterminate', detail: 'reply returned 2xx with no comment id' };
    }
    return { outcome: 'sent', providerCommentId: id };
  }

  const err = (obj['error'] ?? {}) as Record<string, unknown>;
  const code = typeof err['code'] === 'number' ? err['code'] : null;
  const subcode = typeof err['error_subcode'] === 'number' ? err['error_subcode'] : null;
  const { failure, retryable } = classify(res.status, code);
  const trace = typeof err['fbtrace_id'] === 'string' ? err['fbtrace_id'] : null;

  // Meta's own message is not carried, for the same reason as in `meta/send.ts`: an auth
  // error is the one string most likely to quote the credential back, and this detail is
  // written to `outbound_messages.refused_reason`.
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
