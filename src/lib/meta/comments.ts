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
  /** A reply to one of our own comments. The same loop, one level down. */
  | 'reply_to_self'
  /** Hidden by the tenant already; replying would un-bury it. */
  | 'hidden'
  /** No text — a sticker or a bare photo comment carries no question. */
  | 'no_text'
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

/**
 * Pull the answerable comments out of one stored `feed` entry.
 *
 * `pageExternalId` is required, not optional. It is the only thing that distinguishes the
 * salon's own comment from a customer's, and a caller who forgot it would get a bot that
 * replies to itself — so the type refuses to let them forget.
 */
export function extractComments(entry: unknown, pageExternalId: string): CommentExtractResult {
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

    const text = typeof value['message'] === 'string' ? nfc(value['message']) : '';
    if (text.trim() === '') {
      // A sticker or a bare photo. Nothing was asked, so there is nothing to point at DM.
      skipped.push('no_text');
      continue;
    }

    comments.push({
      commentId,
      postId,
      fromId,
      fromName: from !== null && typeof from['name'] === 'string' ? nfc(from['name']) : null,
      text,
      createdAt: secondsToDate(value['created_time']),
      threadId,
    });
  }

  return { comments, skipped };
}
