/**
 * The two outbound Handover Protocol calls: `pass_thread_control`, `take_thread_control`.
 *
 * `docs/handover.md` holds the design. This file is the plumbing only — it makes a Graph
 * call and classifies the answer. It decides nothing about WHEN control should move, and
 * nothing here is wired to a caller yet: the reclaim sweeper is what turns these into a
 * feature, and `docs/handover.md` is explicit that the reclaim ships with the pass or the
 * pass does not ship.
 *
 * ## `{"success": true}` is not proof, and this repository has already paid for that
 *
 * D-062: `POST /{page-id}/subscribed_apps` answers `{"success": true}` when the app has
 * never enabled the field on the object, and the page-level read then agrees with the
 * tenant config and reports healthy — eleven days of a dead channel behind two green
 * checks. It is the same product surface and the same shape of answer, so the same
 * caution applies: a 200 here means Graph ACCEPTED the call, never that thread ownership
 * moved.
 *
 * What proves a pass is the handover WEBHOOK event that follows it, which `recordHandover`
 * already consumes and `applyThreadControl` already writes. So the outcome below says
 * `accepted`, not `passed` — the word is the claim, and the claim we can support is that
 * Graph took the request.
 *
 * ## An indeterminate handover is read the OPPOSITE way to an indeterminate send
 *
 * `meta/send.ts` treats `indeterminate` as "do not re-send": the risk is a duplicate
 * message. Here the risk runs the other way. If a pass may have succeeded, the Page Inbox
 * may already own the thread, and a bot that keeps talking is talking over a person —
 * which is the failure the whole feature exists to prevent. So the caller must treat
 * `indeterminate` on a PASS as "assume it happened, go quiet" and `indeterminate` on a
 * TAKE as "assume it did not, stay quiet". Both resolve towards silence, and that is
 * stated here because the type alone cannot say it.
 *
 * ## `take_thread_control` needs the primary receiver role, and we cannot check that here
 *
 * Meta only lets the primary receiver take control back. Whether this platform holds that
 * role on Matrix's Page is exactly what `docs/handover.md` lists as unverified —
 * `developers.facebook.com` is 403 through this environment's egress proxy, re-measured
 * 2026-09-17 and again 2026-09-19. So no Graph code for "not the primary receiver" is
 * mapped below: inventing one would be a rule nobody has seen fire. It falls to `classify`
 * and lands as `unknown`/non-retryable on a 4xx, which is the correct shape for a call
 * Meta will refuse identically next time.
 */
import { classify, DEFAULT_SEND_TIMEOUT_MS, type SendFailure } from '../meta/send.ts';

/** Enough for any Graph error; a body larger than this is not one we should be parsing. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Only these prove the request never reached Meta. A timeout or a reset can happen after
 * Graph acted, so they are deliberately absent and become `indeterminate`. Kept in step
 * with `meta/send.ts`'s list by `graph.test.ts`.
 */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export type HandoverCall = 'pass_thread_control' | 'take_thread_control';

export type HandoverOutcome =
  /** Graph took the request. NOT proof that control moved — see this file's header. */
  | { outcome: 'accepted' }
  | {
      outcome: 'failed';
      failure: SendFailure;
      retryable: boolean;
      code: number | null;
      subcode: number | null;
      status: number | null;
      detail: string;
    }
  /** The request left and no answer arrived. Resolve towards silence; see the header. */
  | { outcome: 'indeterminate'; detail: string };

export type HandoverInput = {
  /** The channel's `external_id`. The literal `me` is refused, as in `sendMessage`. */
  pageId: string;
  /** The customer's PSID: the thread whose control moves. */
  psid: string;
  token: string;
  graphVersion: string;
  /**
   * Passed through to the receiving app and echoed back on the webhook event, so a pass we
   * made is distinguishable from one a person made in the Page Inbox. Optional because
   * Meta treats it as optional, and absent rather than empty when not given: `""` is a
   * value and would be echoed as one.
   */
  metadata?: string;
  timeoutMs?: number;
  /** Test seam. Production passes nothing and gets the platform `fetch`. */
  fetchImpl?: typeof fetch;
};

function refuse(detail: string): HandoverOutcome {
  return { outcome: 'failed', failure: 'unknown', retryable: false, code: null, subcode: null, status: null, detail };
}

function errorCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur != null && depth < 5; depth += 1) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

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

async function graphPost(
  call: HandoverCall,
  input: HandoverInput,
  extra: Record<string, unknown>,
): Promise<HandoverOutcome> {
  // `me` resolves the Page from the token, so a token/tenant mismatch would move thread
  // control on the WRONG salon's Page and answer 200. Same refusal as `sendMessage`.
  if (input.pageId === '' || input.pageId === 'me') {
    return refuse(`refusing ${call} on '/me': the page id must be explicit`);
  }
  if (input.psid === '') return refuse(`refusing ${call}: no thread`);
  if (input.token === '') return refuse(`refusing ${call}: no token`);

  const doFetch = input.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${input.graphVersion}/${encodeURIComponent(input.pageId)}/${call}`;
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
        recipient: { id: input.psid },
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...extra,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (e) {
    const code = errorCode(e);
    // Provably never connected → nothing moved, and the caller may retry.
    if (code !== null && NEVER_CONNECTED.has(code)) {
      return { outcome: 'failed', failure: 'transient', retryable: true, code: null, subcode: null, status: null, detail: `${call}: ${code}` };
    }
    return { outcome: 'indeterminate', detail: `${call}: ${code ?? 'no answer'}` };
  } finally {
    clearTimeout(timer);
  }

  const text = await boundedText(res);
  if (res.ok) return { outcome: 'accepted' };

  let code: number | null = null;
  let subcode: number | null = null;
  try {
    const err = (JSON.parse(text) as { error?: { code?: unknown; error_subcode?: unknown } }).error;
    if (typeof err?.code === 'number') code = err.code;
    if (typeof err?.error_subcode === 'number') subcode = err.error_subcode;
  } catch {
    // A body that is not JSON is not a Graph error object. Classified by status alone,
    // which is what `classify` does with a null code.
  }
  const { failure, retryable } = classify(res.status, code);
  return { outcome: 'failed', failure, retryable, code, subcode, status: res.status, detail: `${call}: HTTP ${res.status}` };
}

/**
 * Hand this thread to another app — in practice the Page Inbox, so a person can answer.
 *
 * `targetAppId` is required and must be non-empty: Meta's own parameter is optional, and
 * omitting it asks Graph to choose, which on a Page with more than one secondary receiver
 * is a silent decision about who now owns a customer. This platform does not make that
 * call implicitly.
 */
export async function passThreadControl(
  input: HandoverInput & { targetAppId: string },
): Promise<HandoverOutcome> {
  if (input.targetAppId === '') return refuse('refusing pass_thread_control: no target app');
  return graphPost('pass_thread_control', input, { target_app_id: input.targetAppId });
}

/**
 * Take this thread back. Only the primary receiver may; see this file's header on why no
 * code for "not the primary receiver" is mapped.
 */
export async function takeThreadControl(input: HandoverInput): Promise<HandoverOutcome> {
  return graphPost('take_thread_control', input, {});
}
