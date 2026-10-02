/**
 * A Page inbox label on a chat that needs a person (founder, 2026-10-02; proposal
 * `docs/proposals/tara-staff-handoff.md`, option A).
 *
 * ## Why
 *
 * D-158 pages the founder when a customer complains, asks for a person, sends a voice message
 * or is served the hand-off line. The tenant's own staff are told nothing: Tara has no bot of
 * her own by the founder's choice, and of 8 Tara chats paged in the week to 2026-10-02 none
 * got a staff reply within 24 hours, although her staff replied in the inbox 22 times that
 * fortnight. They work in the Page inbox; they just could not see which chats were waiting.
 * So the chat gets a label there, which staff can filter by in Meta Business Suite.
 *
 * ## What it is, and is not
 *
 * - Off unless the tenant has `tenants.needs_person_page_label` (0079). NULL on every tenant.
 * - Messenger only. Custom labels are a Messenger Platform feature; an Instagram or website
 *   chat is not labelled.
 * - It changes nothing the customer sees, and nothing about who holds the thread. The founder
 *   is paged exactly as before; the label is in addition.
 * - Three Graph calls at most: find the label by name (`GET /{page}/custom_labels`), create
 *   it if missing (`POST /{page}/custom_labels`), put it on the customer
 *   (`POST /{label}/label`). All inside one 5-second budget, after the reply has gone.
 * - It never throws and never retries. A failure is logged with the step that failed; the
 *   page to the founder is the signal that still reaches a person.
 *
 * ## Not verified
 *
 * That custom labels work for this app and its permissions on a real Page. The endpoints are
 * Meta's documented Messenger Platform ones, but `developers.facebook.com` is blocked here and
 * no call has been made to a live Page. The founder proves it once on DalaTech's own Page
 * before setting the column for Tara.
 */
import { nfc } from '../mn/text.ts';

/** The whole find, create and attach, after the reply has been sent. */
export const PAGE_LABEL_BUDGET_MS = 5_000;
/** Pages of existing labels read before giving up looking for ours (100 each). */
const MAX_LABEL_PAGES = 3;
const MAX_RESPONSE_CHARS = 64 * 1024;

export type LabelStep = 'find' | 'create' | 'attach';

export type LabelOutcome =
  | { outcome: 'labelled'; labelId: string; created: boolean }
  | { outcome: 'skipped'; reason: 'no_label_set' | 'not_messenger' | 'no_thread' | 'label_unreadable' | 'no_credential'; detail?: string }
  | { outcome: 'failed'; step: LabelStep; status: number | null; code: number | null; detail: string; meta?: MetaError };

/**
 * Meta's whole error object, for the log only (founder, 2026-10-02): what Meta support asks
 * for (`fbtrace_id`) and what tells a permission or terms refusal from a passing fault
 * (`error_subcode`, `type`, the user-facing title and message, which may carry a link).
 */
export type MetaError = {
  code: number | null; subcode: number | null; type: string | null; fbtraceId: string | null;
  message: string | null; userTitle: string | null; userMessage: string | null; isTransient: boolean | null;
};

export type PageLabelInput = {
  /** The channel's `external_id`. `me` is refused, as everywhere a Page is addressed. */
  pageId: string;
  psid: string;
  labelName: string;
  token: string;
  graphVersion: string;
  budgetMs?: number;
  /** Test seam. Production passes nothing and gets the platform `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type GraphAnswer = { ok: true; json: unknown } | { ok: false; status: number | null; code: number | null; detail: string; meta?: MetaError };

async function graph(
  input: PageLabelInput, deadline: number, method: 'GET' | 'POST', path: string,
  query: Record<string, string>, body: Record<string, unknown> | null,
): Promise<GraphAnswer> {
  const now = input.now ?? Date.now;
  const left = deadline - now();
  if (left <= 0) return { ok: false, status: null, code: null, detail: 'out of time' };
  const url = new URL(`https://graph.facebook.com/${input.graphVersion}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), left);
  try {
    const res = await (input.fetchImpl ?? fetch)(url.toString(), {
      method,
      // The token lives here and nowhere else. Never a query parameter.
      headers: { authorization: `Bearer ${input.token}`, ...(body === null ? {} : { 'content-type': 'application/json' }) },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not JSON: classified by status below */ }
    if (res.ok) return { ok: true, json };
    const err = (json as { error?: Record<string, unknown> } | null)?.error;
    // Graph has been seen to repeat the access token inside an error message (a malformed-token
    // 190), so every string from Meta is redacted before it can reach a log.
    const clean = (v: string): string => (input.token === '' ? v : v.split(input.token).join('[token]'));
    const txt = (v: unknown, n = 500): string | null => (typeof v === 'string' ? clean(v).slice(0, n) : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return {
      ok: false, status: res.status, code: num(err?.['code']),
      detail: `HTTP ${res.status}${typeof err?.['message'] === 'string' ? `: ${clean(err['message']).slice(0, 200)}` : ''}`,
      ...(err === undefined || err === null ? {} : {
        meta: {
          code: num(err['code']), subcode: num(err['error_subcode']), type: txt(err['type'], 100),
          // The trace id from the body, else Meta's response header.
          fbtraceId: txt(err['fbtrace_id'], 100) ?? txt(res.headers?.get('x-fb-trace-id'), 100),
          message: txt(err['message']), userTitle: txt(err['error_user_title']), userMessage: txt(err['error_user_msg']),
          isTransient: typeof err['is_transient'] === 'boolean' ? err['is_transient'] : null,
        },
      }),
    };
  } catch (e) {
    return { ok: false, status: null, code: null, detail: e instanceof Error ? e.name === 'AbortError' ? 'timed out' : e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function failed(step: LabelStep, a: Extract<GraphAnswer, { ok: false }>): LabelOutcome {
  return { outcome: 'failed', step, status: a.status, code: a.code, detail: a.detail, ...(a.meta === undefined ? {} : { meta: a.meta }) };
}

/** Find the Page's label with exactly this name (NFC, trimmed), or null. */
async function findLabel(input: PageLabelInput, deadline: number, name: string): Promise<{ ok: true; id: string | null } | Extract<GraphAnswer, { ok: false }>> {
  let after: string | null = null;
  for (let page = 0; page < MAX_LABEL_PAGES; page += 1) {
    const r = await graph(input, deadline, 'GET', `${encodeURIComponent(input.pageId)}/custom_labels`,
      { fields: 'id,page_label_name', limit: '100', ...(after === null ? {} : { after }) }, null);
    if (!r.ok) return r;
    const j = r.json as { data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } } | null;
    for (const row of Array.isArray(j?.data) ? j.data : []) {
      const rec = row as { id?: unknown; page_label_name?: unknown };
      if (typeof rec.id === 'string' && typeof rec.page_label_name === 'string' && nfc(rec.page_label_name).trim() === name) {
        return { ok: true, id: rec.id };
      }
    }
    const next = j?.paging?.cursors?.after;
    if (typeof j?.paging?.next !== 'string' || typeof next !== 'string') return { ok: true, id: null };
    after = next;
  }
  return { ok: true, id: null };
}

/** Put the label on the customer. Never throws. */
export async function labelThread(input: PageLabelInput): Promise<LabelOutcome> {
  const name = nfc(input.labelName).trim();
  if (name === '') return { outcome: 'skipped', reason: 'no_label_set' };
  // `me` resolves the Page from the token: a token/tenant mismatch would label the wrong
  // salon's inbox and answer 200. Same refusal as `sendMessage`.
  if (input.pageId === '' || input.pageId === 'me' || input.psid === '') return { outcome: 'skipped', reason: 'no_thread' };
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? PAGE_LABEL_BUDGET_MS);

  const found = await findLabel(input, deadline, name);
  if (!found.ok) return failed('find', found);
  let labelId = found.id;
  const created = labelId === null;
  if (labelId === null) {
    const c = await graph(input, deadline, 'POST', `${encodeURIComponent(input.pageId)}/custom_labels`, {}, { page_label_name: name });
    if (!c.ok) return failed('create', c);
    const id = (c.json as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') return { outcome: 'failed', step: 'create', status: null, code: null, detail: 'no label id in the answer' };
    labelId = id;
  }
  const a = await graph(input, deadline, 'POST', `${encodeURIComponent(labelId)}/label`, {}, { user: input.psid });
  if (!a.ok) return failed('attach', a);
  // `{"success": true}` is Graph accepting the call, not proof the label shows (D-062's lesson):
  // what proves it is a person seeing it in the inbox, checked once on DalaTech's own Page.
  return { outcome: 'labelled', labelId, created };
}

/**
 * The tenant's label, or null when it has none. `unreadable` is not "none": the caller logs
 * it, and the founder's page has already gone either way.
 */
export function labelFromRow(row: unknown): string | null {
  const v = (row as Record<string, unknown> | null)?.['needs_person_page_label'];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The chat a page is about, as the worker has it. */
export type NeedsPersonThread = { channelId: string; pageId: string; psid: string; tokenChannelId?: string };

export type LabelDeps = {
  /** `tenants.needs_person_page_label`: the name, null for none, `unreadable` on a read error. */
  readLabel: (tenantId: string) => Promise<string | null | 'unreadable'>;
  /** The Page token, loaded per call (never cached: `secrets/tenantSecret.ts`). */
  loadToken: (tenantId: string, channelId: string) => Promise<{ ok: true; token: string } | { ok: false; detail: string }>;
  /** Read only once a label is set, so a tenant without one never needs it. */
  graphVersion: () => string;
  fetchImpl?: typeof fetch;
};

/**
 * After a needs-person page: label the chat when the tenant has a label set. Every branch
 * returns an outcome for the log; nothing here throws or changes the reply.
 */
export async function labelNeedsPerson(
  deps: LabelDeps,
  input: { tenantId: string; provider: string; thread?: NeedsPersonThread },
): Promise<LabelOutcome> {
  try {
    // An allowlist: custom labels are Messenger's. Instagram, the website, SMS and any channel
    // added later are never labelled and never open a Page token.
    if (input.provider !== 'facebook_page') return { outcome: 'skipped', reason: 'not_messenger' };
    if (input.thread === undefined) return { outcome: 'skipped', reason: 'no_thread' };
    const label = await deps.readLabel(input.tenantId);
    if (label === 'unreadable') return { outcome: 'skipped', reason: 'label_unreadable' };
    if (label === null) return { outcome: 'skipped', reason: 'no_label_set' };
    const t = await deps.loadToken(input.tenantId, input.thread.tokenChannelId ?? input.thread.channelId);
    if (!t.ok) return { outcome: 'skipped', reason: 'no_credential', detail: t.detail };
    return await labelThread({
      pageId: input.thread.pageId, psid: input.thread.psid, labelName: label, token: t.token,
      graphVersion: deps.graphVersion(), ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  } catch (e) {
    return { outcome: 'failed', step: 'find', status: null, code: null, detail: e instanceof Error ? e.message : String(e) };
  }
}
