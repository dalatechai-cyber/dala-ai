/**
 * Instagram comments, fetched rather than pushed (D-146, founder 2026-09-26).
 *
 * ## Why this exists
 *
 * Meta sends Instagram `comments` webhooks only to apps with ADVANCED access to
 * instagram_manage_comments. DALA_AI has Standard: Meta's dashboard Test comment reached the
 * route (webhook_events 883), and a real «1» under a @dalatech_ post never did. App Review is
 * later. Until then this worker, called by a QStash schedule, reads the account's recent posts
 * and turns every NEW comment into the entry a webhook would have carried.
 *
 * ## It changes nothing downstream, on purpose
 *
 * Each comment becomes one Instagram `comments` entry (`meta/comments.ts` reads it) and goes
 * through `handleMetaEntry` — the webhook route's own claim-and-queue — with `source = 'poll'`.
 * So the reception worker, the comment rules, «comment 1», the shadow switch, the tester list,
 * private-first and every dedup key are the ones D-144/D-145 built and tested. There is no
 * second comment pipeline to drift from the first.
 *
 * ## The three promises, and what keeps each
 *
 *  - **Never an old comment.** The first poll of a channel writes a watermark (`since`) and
 *    answers nothing; after that, only comments stamped at or after it are queued. Turning the
 *    comment switch off clears the state, so turning it on again starts a new watermark rather
 *    than answering the gap. And nothing older than Meta's 7-day private-reply window is
 *    queued, whatever the watermark says (a poller that was down for a week must not wake up
 *    and answer last week).
 *  - **Never twice.** A comment's event key is built from Meta's comment id exactly as the
 *    webhook's is (`identity.ts`), so polling it again is a duplicate of the same row, and a
 *    webhook for it after App Review is too. Below that sit the reply's own keys — one public
 *    reply per thread, one private message per person per post — which hold whatever the event
 *    key does.
 *  - **Cheap.** One Graph read per channel per run (the posts, with their comment counts); a
 *    post's comments are read only when its count went UP since the last run. A quiet minute is
 *    one database read, one token decrypt and one Graph call, and writes nothing to QStash.
 *    Meta's rate-limit codes back the channel off for fifteen minutes.
 *
 * ## What it cannot see, stated
 *
 *  - Only the 50 most recent posts are watched.
 *  - A comment added and another deleted between two runs leaves the count unchanged, so that
 *    new comment is missed.
 *  - Whether `comments_count` includes replies is Meta's to say; a reply-only change is picked
 *    up only if it moves the count.
 *  - A comment with no `from` (Meta withholds it in some cases) cannot be held to "one per
 *    person" and is skipped, counted.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EntryInput, EntryOutcome } from '../webhook/entry.ts';
import { parseGraphTime } from './lookup.ts';

/** Meta's window for a private reply to a comment, less an hour so a send is never late. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
/** Posts watched per channel: the most recent this many. */
export const MEDIA_WATCHED = 50;
/** Posts whose comments are read in one run; the rest keep their old count and wait a minute. */
export const MAX_MEDIA_READS_PER_RUN = 5;
/** Pages of 50 top-level comments read per post. */
export const MAX_COMMENT_PAGES = 4;
/** How long a rate-limited channel is left alone. */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
/** Stop starting new reads after this long, so the run ends inside the function's 60 s. */
export const RUN_BUDGET_MS = 40_000;

/** Graph's throttling codes: app, user, page, action-specific, and Instagram business-use-case. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);

export type PollState = {
  /** ISO. Nothing written before it is ever answered. */
  since: string;
  /** Each watched post's `comments_count` at the last complete read. */
  counts: Record<string, number>;
  lastRunAt?: string;
  lastError?: string | null;
  backoffUntil?: string | null;
};

export type GraphRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: number | null; detail: string };

export type PollEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (rawBody: string, signature: string | null) => Promise<boolean>;
  graphVersionDefault: () => string;
  /** The `page_token` of the channel the Instagram account sends through. Per run, never cached (rule 7). */
  loadToken: (ref: { tenantId: string; channelId: string }) => Promise<{ ok: true; token: string } | { ok: false; detail: string }>;
  /** GET `https://graph.facebook.com/{version}/{path}`; the token goes in the header. */
  graphGet: (input: { graphVersion: string; path: string; params: Record<string, string>; token: string }) => Promise<GraphRead>;
  /** `handleMetaEntry`, bound to the database and the queue. */
  handleEntry: (input: EntryInput) => Promise<EntryOutcome>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
  /** Milliseconds, for the run budget. Defaults to the real clock. */
  clock?: () => number;
};

export type PollJobResult = { status: number; body: Record<string, unknown> };

type Counters = {
  channels: number; baselined: number; polled: number; backedOff: number; failed: number;
  mediaRead: number; queued: number; alreadyQueued: number; old: number; ours: number; noFrom: number;
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parsePollState(raw: unknown): PollState | null {
  const r = asRecord(raw);
  if (r === null || typeof r['since'] !== 'string' || Number.isNaN(new Date(r['since']).getTime())) return null;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(r['counts']) ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
  }
  return {
    since: r['since'],
    counts,
    ...(typeof r['lastRunAt'] === 'string' ? { lastRunAt: r['lastRunAt'] } : {}),
    lastError: typeof r['lastError'] === 'string' ? r['lastError'] : null,
    backoffUntil: typeof r['backoffUntil'] === 'string' ? r['backoffUntil'] : null,
  };
}

export type WatchedMedia = { id: string; commentsCount: number };

export function watchedMedia(body: Record<string, unknown>): WatchedMedia[] {
  const out: WatchedMedia[] = [];
  for (const raw of asArray(body['data'])) {
    const m = asRecord(raw);
    if (m === null || typeof m['id'] !== 'string' || m['id'] === '') continue;
    const n = m['comments_count'];
    out.push({ id: m['id'], commentsCount: typeof n === 'number' && Number.isFinite(n) ? n : 0 });
  }
  return out;
}

/** Posts whose comment count went UP since the last complete read — the only ones worth a request. */
export function mediaToRead(media: readonly WatchedMedia[], counts: Readonly<Record<string, number>>): WatchedMedia[] {
  return media.filter((m) => m.commentsCount > (counts[m.id] ?? 0));
}

export type PolledComment = {
  id: string;
  text: string;
  timestamp: Date | null;
  fromId: string | null;
  fromUsername: string | null;
  parentId: string | null;
  /** Graph's `user`: present only when the account itself wrote the comment. */
  user: string | null;
};

function toComment(raw: unknown, parentFallback: string | null): PolledComment | null {
  const c = asRecord(raw);
  if (c === null || typeof c['id'] !== 'string' || c['id'] === '') return null;
  const from = asRecord(c['from']);
  const userRaw = c['user'];
  return {
    id: c['id'],
    text: typeof c['text'] === 'string' ? c['text'] : '',
    timestamp: parseGraphTime(c['timestamp']),
    fromId: from !== null && typeof from['id'] === 'string' && from['id'] !== '' ? from['id'] : null,
    fromUsername: from !== null && typeof from['username'] === 'string' ? from['username'] : null,
    parentId: typeof c['parent_id'] === 'string' && c['parent_id'] !== '' ? c['parent_id'] : parentFallback,
    user: typeof userRaw === 'string' ? userRaw : asRecord(userRaw) !== null ? String(asRecord(userRaw)?.['id'] ?? 'self') : null,
  };
}

/** A page of the comments edge, top-level comments and their nested replies, flattened. */
export function flattenComments(body: Record<string, unknown>): PolledComment[] {
  const out: PolledComment[] = [];
  for (const raw of asArray(body['data'])) {
    const top = toComment(raw, null);
    if (top === null) continue;
    out.push(top);
    for (const reply of asArray(asRecord(asRecord(raw)?.['replies'])?.['data'])) {
      const r = toComment(reply, top.id);
      if (r !== null) out.push(r);
    }
  }
  return out;
}

export type CommentVerdict = 'queue' | 'old' | 'ours' | 'no_from';

/** Is this comment one to hand to the comment worker? */
export function pollVerdict(c: PolledComment, input: { accountId: string; since: Date; now: Date }): CommentVerdict {
  // Ours first: the account's own comments (our public replies included) are never answered.
  if (c.user !== null || c.fromId === input.accountId) return 'ours';
  if (c.timestamp === null) return 'old'; // undated is not young
  if (c.timestamp.getTime() < input.since.getTime()) return 'old';
  if (input.now.getTime() - c.timestamp.getTime() > PRIVATE_REPLY_WINDOW_MS) return 'old';
  if (c.fromId === null) return 'no_from';
  return 'queue';
}

/**
 * The entry a webhook would have carried for this comment (D-145's shape). `time` is the
 * comment's own time, because the extractor dates an Instagram comment by `entry.time` and a
 * comment fetched a minute late is not a minute younger.
 */
export function commentEntry(accountId: string, mediaId: string, c: PolledComment): Record<string, unknown> {
  const seconds = Math.floor((c.timestamp as Date).getTime() / 1000);
  return {
    id: accountId,
    time: seconds,
    changes: [{
      field: 'comments',
      value: {
        id: c.id,
        text: c.text,
        ...(c.parentId === null ? {} : { parent_id: c.parentId }),
        from: { id: c.fromId, ...(c.fromUsername === null ? {} : { username: c.fromUsername }) },
        media: { id: mediaId },
      },
    }],
  };
}

const COMMENT_FIELDS = 'id,text,timestamp,from,parent_id,user';

type ChannelRow = {
  id: string; tenantId: string; externalId: string; appSlug: string | null;
  viaChannelId: string | null; graphVersion: string | null; state: PollState | null;
};

function readChannel(raw: unknown): ChannelRow | null {
  const r = asRecord(raw);
  if (r === null || typeof r['id'] !== 'string' || typeof r['tenant_id'] !== 'string'
      || typeof r['external_id'] !== 'string' || r['external_id'] === '') return null;
  return {
    id: r['id'],
    tenantId: r['tenant_id'],
    externalId: r['external_id'],
    appSlug: typeof r['app_slug'] === 'string' && r['app_slug'] !== '' ? r['app_slug'] : null,
    viaChannelId: typeof r['via_channel_id'] === 'string' ? r['via_channel_id'] : null,
    graphVersion: typeof r['graph_version_override'] === 'string' && r['graph_version_override'] !== ''
      ? r['graph_version_override'] : null,
    state: parsePollState(r['comment_poll_state']),
  };
}

async function writeState(fx: PollEffects, ch: ChannelRow, state: PollState): Promise<void> {
  const { error } = await fx.db
    .from('tenant_channels')
    .update({ comment_poll_state: state })
    .eq('id', ch.id)
    .eq('tenant_id', ch.tenantId);
  if (error) fx.log('error', 'ig_comment_poll_state_unwritten', { channelId: ch.id, detail: error.message });
}

function failedState(prior: PollState | null, now: Date, detail: string, rateLimited: boolean): PollState | null {
  // A channel never baselined stays unbaselined: its watermark is set by a poll that WORKED.
  if (prior === null) return null;
  return {
    ...prior,
    lastRunAt: now.toISOString(),
    lastError: detail,
    backoffUntil: rateLimited ? new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS).toISOString() : null,
  };
}

async function pollChannel(fx: PollEffects, ch: ChannelRow, n: Counters, deadline: number, clock: () => number): Promise<void> {
  const { now } = fx;
  const prior = ch.state;
  if (prior?.backoffUntil && new Date(prior.backoffUntil).getTime() > now.getTime()) {
    n.backedOff += 1;
    return;
  }

  const fail = async (detail: string, rateLimited = false): Promise<void> => {
    n.failed += 1;
    fx.log(rateLimited ? 'warn' : 'error', 'ig_comment_poll_failed', { channelId: ch.id, detail });
    const next = failedState(prior, now, detail, rateLimited);
    if (next !== null) await writeState(fx, ch, next);
  };

  const token = await fx.loadToken({ tenantId: ch.tenantId, channelId: ch.viaChannelId ?? ch.id });
  if (!token.ok) return fail(`no credential: ${token.detail}`);
  const graphVersion = ch.graphVersion ?? fx.graphVersionDefault();

  const mediaRead = await fx.graphGet({
    graphVersion, path: `${ch.externalId}/media`, token: token.token,
    params: { fields: 'id,timestamp,comments_count', limit: String(MEDIA_WATCHED) },
  });
  if (!mediaRead.ok) return fail(`media: ${mediaRead.detail}`, mediaRead.code !== null && RATE_LIMIT_CODES.has(mediaRead.code));
  const media = watchedMedia(mediaRead.body);

  // First poll: the watermark, and nothing answered. Every comment that exists now is "old".
  if (prior === null) {
    await writeState(fx, ch, {
      since: now.toISOString(),
      counts: Object.fromEntries(media.map((m) => [m.id, m.commentsCount])),
      lastRunAt: now.toISOString(),
      lastError: null,
      backoffUntil: null,
    });
    n.baselined += 1;
    fx.log('info', 'ig_comment_poll_baselined', { channelId: ch.id, media: media.length });
    return;
  }

  n.polled += 1;
  const since = new Date(prior.since);
  const needed = mediaToRead(media, prior.counts);
  const toRead = needed.slice(0, MAX_MEDIA_READS_PER_RUN);
  const complete = new Set<string>();
  const errors: string[] = [];
  let rateLimited = false;

  for (const m of toRead) {
    if (clock() > deadline || rateLimited) break;
    n.mediaRead += 1;
    let ok = true;
    let after: string | null = null;
    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const read = await fx.graphGet({
        graphVersion, path: `${m.id}/comments`, token: token.token,
        params: {
          fields: `${COMMENT_FIELDS},replies.limit(50){${COMMENT_FIELDS}}`,
          limit: '50',
          ...(after === null ? {} : { after }),
        },
      });
      if (!read.ok) {
        ok = false;
        errors.push(`comments of ${m.id}: ${read.detail}`);
        if (read.code !== null && RATE_LIMIT_CODES.has(read.code)) rateLimited = true;
        break;
      }
      for (const c of flattenComments(read.body)) {
        const verdict = pollVerdict(c, { accountId: ch.externalId, since, now });
        if (verdict === 'old') { n.old += 1; continue; }
        if (verdict === 'ours') { n.ours += 1; continue; }
        if (verdict === 'no_from') { n.noFrom += 1; continue; }
        const outcome = await fx.handleEntry({
          provider: 'instagram',
          entry: commentEntry(ch.externalId, m.id, c) as EntryInput['entry'],
          // Index 0 and the channel's slug: the key Meta's own one-comment delivery would get,
          // so a webhook after App Review is a duplicate of this row rather than a second event.
          index: 0,
          matchedAppSlug: ch.appSlug ?? 'poll',
          source: 'poll',
        });
        if (outcome.outcome === 'queued') n.queued += 1;
        else if (outcome.outcome === 'already_queued') n.alreadyQueued += 1;
        else {
          // Not queued and not already queued: this post's count is NOT advanced, so the
          // next run reads it again. A duplicate that did reach the queue costs nothing then.
          ok = false;
          errors.push(`comment ${c.id}: ${outcome.outcome}`);
        }
      }
      const cursors = asRecord(asRecord(read.body['paging'])?.['cursors']);
      const next = asRecord(read.body['paging'])?.['next'];
      after = typeof next === 'string' && typeof cursors?.['after'] === 'string' ? cursors['after'] : null;
      if (after === null) break;
    }
    if (ok) complete.add(m.id);
  }

  // Counts only for posts in today's list: a post that fell off the end stops being tracked.
  // A post that needed reading and was not read to the end (a failure, the per-run cap, the
  // time budget) keeps its OLD count, so the next run reads it again. Every other post takes
  // today's count — including one that went DOWN after a deletion.
  const pending = new Set(needed.filter((m) => !complete.has(m.id)).map((m) => m.id));
  const counts: Record<string, number> = {};
  for (const m of media) counts[m.id] = pending.has(m.id) ? prior.counts[m.id] ?? 0 : m.commentsCount;
  if (errors.length > 0) fx.log('error', 'ig_comment_poll_incomplete', { channelId: ch.id, errors });
  await writeState(fx, ch, {
    since: prior.since,
    counts,
    lastRunAt: now.toISOString(),
    lastError: errors.length > 0 ? errors.join('; ').slice(0, 500) : null,
    backoffUntil: rateLimited ? new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS).toISOString() : null,
  });
}

export async function runInstagramCommentPoll(
  fx: PollEffects,
  input: { rawBody: string; signature: string | null },
): Promise<PollJobResult> {
  if (!(await fx.verifySignature(input.rawBody, input.signature))) {
    return { status: 401, body: { error: 'bad_signature' } };
  }
  const clock = fx.clock ?? (() => Date.now());
  const deadline = clock() + RUN_BUDGET_MS;

  // A switch turned off forgets its watermark, so turning it on again answers nothing from
  // the time it was off. Writes nothing when there is nothing to clear.
  const cleared = await fx.db
    .from('tenant_channels')
    .update({ comment_poll_state: null })
    .eq('provider', 'instagram')
    .not('comment_poll_state', 'is', null)
    .or('comment_delivery_mode.eq.off,comment_policy.eq.none');
  if (cleared.error) fx.log('error', 'ig_comment_poll_clear_failed', { detail: cleared.error.message });

  const { data, error } = await fx.db
    .from('tenant_channels')
    .select('id, tenant_id, external_id, app_slug, via_channel_id, graph_version_override, comment_poll_state')
    .eq('provider', 'instagram')
    .neq('comment_delivery_mode', 'off')
    .neq('comment_policy', 'none');
  if (error) return { status: 503, body: { error: 'unavailable', detail: `tenant_channels unreadable: ${error.message}` } };

  const n: Counters = {
    channels: 0, baselined: 0, polled: 0, backedOff: 0, failed: 0,
    mediaRead: 0, queued: 0, alreadyQueued: 0, old: 0, ours: 0, noFrom: 0,
  };
  for (const raw of Array.isArray(data) ? data : []) {
    const ch = readChannel(raw);
    if (ch === null) continue;
    n.channels += 1;
    if (clock() > deadline) break;
    await pollChannel(fx, ch, n, deadline, clock);
  }
  if (n.queued > 0 || n.failed > 0) fx.log(n.failed > 0 ? 'warn' : 'info', 'ig_comment_poll_run', { ...n });
  // 200 even when a channel failed: its state row carries the error, and a QStash retry of the
  // whole run would only repeat the failing read a few seconds later. The next minute is the retry.
  return { status: 200, body: { ...n } };
}

const GRAPH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_CHARS = 512 * 1024;

/**
 * The real Graph GET: token in the header (never the query string), a timeout, and Meta's
 * error CODE carried but never its message — an auth error is the string most likely to quote
 * the credential back (`comments/lookup.ts` does the same).
 */
export async function graphGetJson(
  input: { graphVersion: string; path: string; params: Record<string, string>; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GraphRead> {
  const qs = new URLSearchParams(input.params).toString();
  const url = `https://graph.facebook.com/${input.graphVersion}/${input.path}${qs === '' ? '' : `?${qs}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET', headers: { authorization: `Bearer ${input.token}` }, signal: controller.signal, cache: 'no-store',
    });
    const raw = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let parsed: unknown = null;
    try { parsed = raw === '' ? null : JSON.parse(raw); } catch { parsed = null; }
    const obj = asRecord(parsed);
    if (!res.ok || obj === null || obj['error'] !== undefined) {
      const code = asRecord(obj?.['error'])?.['code'];
      return {
        ok: false,
        code: typeof code === 'number' ? code : null,
        detail: `graph ${res.status} code=${typeof code === 'number' ? code : '?'}`,
      };
    }
    return { ok: true, body: obj };
  } catch (e) {
    return { ok: false, code: null, detail: `graph read did not complete (${(e as Error).name})` };
  } finally {
    clearTimeout(timer);
  }
}
