/**
 * Comments on a tenant's own Page posts, out of a `feed` webhook entry (§3.8.1).
 *
 * The mirror of `extract.ts`, and deliberately a separate function rather than a branch
 * inside it: a DM and a public comment are different surfaces with different rules, and
 * the one thing that must never happen is a code path where a comment can be handled as
 * though it were a DM. They share a stored entry and nothing else.
 *
 * ## `feed` is a firehose, and that is the design's word for it
 *
 * There is no dedicated `comments` field on the Page object. You subscribe to `feed` and
 * receive the Page's own posts, edits, reactions, hides, shares and likes **alongside**
 * comments, then filter. Every skip below is reported rather than dropped silently,
 * because the volume is the thing that has to be budgeted for and an unreported skip is a
 * volume you cannot see.
 *
 * ## The two loop-prevention filters live here, at the earliest possible point
 *
 * A bot that answers its own comments is not a bug that degrades gracefully — it is a
 * public thread on the tenant's own wall where the salon appears to be talking to itself,
 * permanently, in front of their customers. So `comment_self` is checked against the
 * channel's own external id, and a reply to one of OUR comments is dropped on the same
 * grounds. Neither is left to a later layer that might be reordered.
 */
import { nfc } from '../mn/text.ts';

export type CommentSkipReason =
  /** Not a comment at all: a post, a reaction, a share, a hide, a like. `feed` carries them all. */
  | 'not_a_comment'
  /** An edit or a removal. V1 answers `add` and nothing else. */
  | 'not_an_add'
  /** The Page itself commented. Answering it is the salon talking to itself. */
  | 'comment_self'
  /** Hidden by the tenant already; replying would un-bury it. */
  | 'hidden'
  /** Missing an id we need. Reported, never guessed at. */
  | 'malformed';

export type InboundComment = {
  commentId: string;
  /** The post the comment sits under, for the age check and for the operator. */
  postId: string;
  /** Who commented. Compared against the ignore list by the eligibility layer. */
  fromId: string;
  fromName: string | null;
  text: string;
  createdAt: Date;
  /**
   * The ROOT of the thread this comment belongs to — the dedup key for "one public reply
   * per thread, ever". A top-level comment is its own root; a reply to a comment carries
   * the parent's id.
   */
  threadId: string;
  /**
   * `value.post.permalink_url` when Meta sent it (it does on every comment on record), for
   * the link in a complaint alert. Null when absent — never guessed.
   */
  postPermalink: string | null;
};

export type CommentExtractResult = { comments: InboundComment[]; skipped: CommentSkipReason[] };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Meta sends `created_time` as UNIX **seconds** on the `feed` value, not milliseconds.
 *
 * Getting this wrong by a factor of 1000 does not throw: seconds read as milliseconds put
 * every comment in January 1970, so the post-age check refuses everything and comments
 * silently never work. The mirror error puts them in the year 57000 and the age check
 * passes everything, including the spam on a four-year-old post.
 */
function secondsToDate(v: unknown): Date {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : new Date(NaN);
}

/** An https permalink from `value.post`, or null. Anything else is not a link we will print. */
function permalinkOf(post: unknown): string | null {
  const p = asRecord(post);
  const url = p === null ? null : p['permalink_url'];
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

/**
 * Pull the answerable comments out of one stored `feed` entry.
 *
 * `pageExternalId` is required, not optional. It is the only thing that distinguishes the
 * salon's own comment from a customer's, and a caller who forgot it would get a bot that
 * replies to itself — so the type refuses to let them forget.
 */
export function extractComments(
  entry: unknown, pageExternalId: string, provider: 'facebook_page' | 'instagram' = 'facebook_page',
): CommentExtractResult {
  if (provider === 'instagram') return extractInstagramComments(entry, pageExternalId);
  const comments: InboundComment[] = [];
  const skipped: CommentSkipReason[] = [];

  const e = asRecord(entry);
  const changes = e === null ? null : e['changes'];
  if (!Array.isArray(changes)) return { comments, skipped };

  for (const rawChange of changes) {
    const change = asRecord(rawChange);
    if (change === null) {
      skipped.push('malformed');
      continue;
    }
    if (change['field'] !== 'feed') {
      skipped.push('not_a_comment');
      continue;
    }

    const value = asRecord(change['value']);
    if (value === null) {
      skipped.push('malformed');
      continue;
    }

    // `item` distinguishes a comment from a post, a reaction, a share or a like — all of
    // which arrive on this same field.
    if (value['item'] !== 'comment') {
      skipped.push('not_a_comment');
      continue;
    }
    // `add` only. An `edited` comment is a different event and answering it would post a
    // second reply to a thread already answered; `remove` has nothing to answer.
    if (value['verb'] !== 'add') {
      skipped.push('not_an_add');
      continue;
    }
    if (value['is_hidden'] === true) {
      // The tenant hid it. A public reply would drag it back into view under their post.
      skipped.push('hidden');
      continue;
    }

    const commentId = String(value['comment_id'] ?? '');
    const postId = String(value['post_id'] ?? '');
    const from = asRecord(value['from']);
    const fromId = from === null ? '' : String(from['id'] ?? '');
    if (commentId === '' || postId === '' || fromId === '') {
      skipped.push('malformed');
      continue;
    }

    // LOOP PREVENTION, half one: the Page commented on its own post.
    if (fromId === pageExternalId) {
      skipped.push('comment_self');
      continue;
    }

    const parentId = typeof value['parent_id'] === 'string' ? value['parent_id'] : '';

    // LOOP PREVENTION, half two: a reply to one of OUR comments. We cannot tell from the
    // payload who wrote the parent, so this is the caller's job — `parentAuthorIsUs` is
    // resolved by the eligibility layer against our own outbound rows. What IS decidable
    // here is the thread root.
    //
    // `parent_id` is the post id for a top-level comment and the parent COMMENT's id for a
    // reply. Comparing it to `post_id` separates the two without parsing Facebook's
    // `{owner}_{object}` id structure, which is undocumented and has changed before.
    const isReply = parentId !== '' && parentId !== postId;
    const threadId = isReply ? parentId : commentId;

    // A comment with NO TEXT is returned, not skipped (D-085 review).
    //
    // It used to push `no_text` into a `string[]` that carries no comment_id, no post_id
    // and no author — so a photograph under the salon's own post became the word
    // "no_text" in a counter and was unfindable. That is D-070 exactly, on the surface
    // where it costs most: a customer posting a picture of the colour they want is the
    // most valuable comment a salon receives, and it looked identical to a thumbs-up.
    //
    // Returned with `text: ''`, it reaches `classifyComment`, fires no matcher, and comes
    // back `unclassified` — which is silent, and which WRITES A ROW carrying the ids. The
    // operator can find it; the platform still says nothing, because no rule claimed it.
    const text = typeof value['message'] === 'string' ? nfc(value['message']) : '';

    comments.push({
      commentId,
      postId,
      fromId,
      fromName: from !== null && typeof from['name'] === 'string' ? nfc(from['name']) : null,
      text,
      createdAt: secondsToDate(value['created_time']),
      threadId,
      postPermalink: permalinkOf(value['post']),
    });
  }

  return { comments, skipped };
}

/**
 * Instagram comments (D-145): `object: instagram`, `entry.id` = the Instagram account,
 * `changes[].field = 'comments'`, and a value that is NOT the Page `feed` shape —
 *
 *     { id | comment_id, text, parent_id?, from: { id, username, self_ig_scoped_id? },
 *       media: { id, media_product_type, ad_id?, ... } }
 *
 * (Meta's Instagram webhooks reference; the example pages disagree on `id` vs `comment_id`,
 * so both are read). There is no verb: every change is a new comment. The comment carries no
 * time of its own, so `entry.time` — when Meta sent it — stands in; a missing one is an
 * invalid date, which the eligibility layer refuses as `comment_age_unknown`.
 *
 * `accountId` is the Instagram account's id. A comment from it, or carrying
 * `self_ig_scoped_id` (Meta marks the account commenting on its own media that way), is
 * our own and skipped as `comment_self`, exactly as the Page's own comment is on Facebook.
 */
export function extractInstagramComments(entry: unknown, accountId: string): CommentExtractResult {
  const comments: InboundComment[] = [];
  const skipped: CommentSkipReason[] = [];
  const e = asRecord(entry);
  const changes = e === null ? null : e['changes'];
  if (!Array.isArray(changes)) return { comments, skipped };
  const time = e === null ? undefined : e['time'];
  const createdAt = typeof time === 'string' && /^\d+$/u.test(time) ? secondsToDate(Number(time)) : secondsToDate(time);

  for (const rawChange of changes) {
    const change = asRecord(rawChange);
    if (change === null) { skipped.push('malformed'); continue; }
    if (change['field'] !== 'comments') { skipped.push('not_a_comment'); continue; }
    const value = asRecord(change['value']);
    if (value === null) { skipped.push('malformed'); continue; }

    const commentId = String(value['id'] ?? value['comment_id'] ?? '');
    const postId = String(asRecord(value['media'])?.['id'] ?? '');
    const from = asRecord(value['from']);
    const fromId = from === null ? '' : String(from['id'] ?? '');
    if (commentId === '' || postId === '' || fromId === '') { skipped.push('malformed'); continue; }
    if (fromId === accountId || (from !== null && from['self_ig_scoped_id'] !== undefined)) {
      skipped.push('comment_self');
      continue;
    }
    const parentId = typeof value['parent_id'] === 'string' ? value['parent_id'] : '';
    comments.push({
      commentId,
      postId,
      fromId,
      fromName: from !== null && typeof from['username'] === 'string' ? nfc(from['username']) : null,
      text: typeof value['text'] === 'string' ? nfc(value['text']) : '',
      createdAt,
      threadId: parentId !== '' ? parentId : commentId,
      postPermalink: null,
    });
  }
  return { comments, skipped };
}
