/**
 * Two facts about a comment that its webhook does not carry (D-122), read from Graph.
 *
 * 1. **Does it tag a person?** The `feed` webhook carries a tag only as the tagged person's
 *    name inside `message` — measured on every one of Matrix's 72 real comment deliveries,
 *    none has `message_tags` — so «Bold Bat энийг хар» and «Bold Bat хаана байдаг вэ» are
 *    indistinguishable from their text. `GET /{comment-id}?fields=message_tags` is where the
 *    tag actually lives.
 * 2. **How old is the post?** §3.8.2 rule 5 (docs/comments.md): without it, one person with
 *    a list of archived post ids gets a public reply under every one of them in a day.
 *    The payload has `post_id` and no creation time; `GET /{post-id}?fields=created_time`.
 *
 * Every failure is `null` for the fact it could not read — never `false` — so the caller
 * refuses (`comment_lookup_unknown`). Read only for a comment already decided worth
 * answering, so praise and emoji cost no request.
 *
 * The token is an argument, loaded per call by the route (rule 7). It goes in the header,
 * never the query string, exactly as `meta/send.ts` does.
 */
export const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_CHARS = 64 * 1024;

export type CommentLookup = {
  /** True when the comment tags anyone but the Page itself; null when unreadable. */
  tagsPerson: boolean | null;
  /** When the post was created; null when unreadable. */
  postCreatedAt: Date | null;
  /** Why a field is null, for the log. Never contains the token or Meta's message text. */
  problems: string[];
};

export type LookupInput = {
  commentId: string;
  postId: string;
  /** The Page's own id: a tag of the salon's Page is not a person. */
  pageId: string;
  token: string;
  graphVersion: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

async function graphGet(
  input: LookupInput, objectId: string, fields: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; detail: string }> {
  const doFetch = input.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${input.graphVersion}/${encodeURIComponent(objectId)}?fields=${fields}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.token}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const raw = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let parsed: unknown = null;
    try { parsed = raw === '' ? null : JSON.parse(raw); } catch { parsed = null; }
    const obj = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
    if (!res.ok || obj === null) {
      const err = obj === null ? null : obj['error'];
      const code = typeof err === 'object' && err !== null ? (err as Record<string, unknown>)['code'] : undefined;
      // Meta's own message is not carried: an auth error is the string most likely to
      // quote the credential back.
      return { ok: false, detail: `graph ${res.status} code=${typeof code === 'number' ? code : '?'} reading ${fields}` };
    }
    return { ok: true, body: obj };
  } catch (e) {
    return { ok: false, detail: `graph read of ${fields} did not complete (${(e as Error).name})` };
  } finally {
    clearTimeout(timer);
  }
}

/** Graph writes `+0000`; not every Date parser accepts an offset without a colon. */
export function parseGraphTime(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Does this `message_tags` value tag anyone but the Page?
 *
 * Absent means no tags — Graph omits the field on an untagged comment — and is `false`.
 * Present but not an array is unreadable and `null`. A tag counts as a PERSON unless it is
 * typed `page` or carries the Page's own id; a group or an unknown type is not the salon
 * either, so it refuses too.
 */
export function tagsAPerson(messageTags: unknown, pageId: string): boolean | null {
  if (messageTags === undefined) return false;
  if (!Array.isArray(messageTags)) return null;
  return messageTags.some((t) => {
    if (typeof t !== 'object' || t === null) return true;
    const tag = t as Record<string, unknown>;
    return !(tag['type'] === 'page' || String(tag['id'] ?? '') === pageId);
  });
}

export async function lookupComment(input: LookupInput): Promise<CommentLookup> {
  const [comment, post] = await Promise.all([
    graphGet(input, input.commentId, 'message_tags'),
    graphGet(input, input.postId, 'created_time'),
  ]);
  const problems: string[] = [];
  let tagsPerson: boolean | null = null;
  if (comment.ok) {
    tagsPerson = tagsAPerson(comment.body['message_tags'], input.pageId);
    if (tagsPerson === null) problems.push('message_tags was not an array');
  } else {
    problems.push(comment.detail);
  }
  let postCreatedAt: Date | null = null;
  if (post.ok) {
    postCreatedAt = parseGraphTime(post.body['created_time']);
    if (postCreatedAt === null) problems.push('post created_time missing or unparseable');
  } else {
    problems.push(post.detail);
  }
  return { tagsPerson, postCreatedAt, problems };
}
