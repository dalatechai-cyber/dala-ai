/**
 * Has a PERSON at the salon already answered this commenter? (D-122 addendum, founder,
 * 2026-09-25: "if the Page has already replied under a comment, or tagged that person under
 * the same post, the bot must not reply".)
 *
 * The salon's staff answer comments by hand, from the Page. Every one of those comments
 * reaches this platform through the same `feed` subscription as a customer's, with
 * `from.id` = the Page — measured: 35 of Matrix's 78 comment deliveries between 2026-09-20
 * and 2026-09-25 were the Page's own. So the evidence is already stored, in
 * `webhook_events.raw_payload`, and reading it costs no Graph request.
 *
 * ## Two facts, and what each one is read from
 *
 * (a) **The Page replied under this comment**: a Page comment whose `parent_id` is this
 *     comment's id. Facebook threads are two levels deep, so this can only be true of a
 *     top-level comment; a reply to a reply is filed under the thread root.
 * (b) **The Page tagged this commenter on the same post**: a Page comment on the same post
 *     whose text names the commenter. The webhook carries a tag ONLY as the person's display
 *     name inside `message` — 0 of 78 comment deliveries carry `message_tags` — so the name
 *     is what there is. When a Page replies to a reply, Facebook prefills the tag of the
 *     person being answered («Saran Tuul Баярлалаа💕»), which is why (b) also covers the
 *     reply-to-a-reply case (a) cannot see.
 *
 * Deliberately NOT a third fact: "the Page is somewhere in this thread". On 2026-09-24 a
 * customer replied «Tara salon яармаг салбар yarmagtaa bizdee hehe» inside a thread the
 * Page had answered two days earlier — to a DIFFERENT person — and the founder wants that
 * comment answered. The thread belonging to someone the staff answered does not mean this
 * person was.
 *
 * ## The name match
 *
 * Whole words, in order, compared on `messageWords` — NFC, `mn-MN` case fold, punctuation,
 * symbols and emoji removed, the same reduction every `has_word` rule runs on. A name
 * matches where its words occur as a contiguous run of the Page comment's words, anywhere
 * in it: the prefilled tag sits at the start, and a copy-pasted answer carries earlier tags
 * further in («Khongor Battulga Ogi Oyunaa 📍 Яармаг салбар…»). No `\b`, no `\w`:
 * a word here is a run between separators as Unicode defines them, so «Од» does not match
 * inside «Одгэрэл» and «Ogi Oyunaa» matches against «Ogi Oyunaa📍».
 *
 * A name is matched only WHOLE. Facebook lets the tagger shorten a tag to one name; that
 * shortened tag is not recognised, and the bot may then answer a person the staff answered —
 * the direction the founder asked to close, stated rather than discovered. Matching single
 * name parts would silence everyone called Bold on a post where one Bold was thanked.
 */
import { messageWords } from '../mn/match.ts';
import { nfc } from '../mn/text.ts';

/** One of the Page's own comments, as its webhook delivered it. */
export type PageComment = {
  commentId: string;
  postId: string;
  /** The post id for a top-level comment, the parent comment's id for a reply. */
  parentId: string;
  /** NFC. May be empty — a Page sticker. */
  text: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The Page's own comments in stored `feed` entries, in the order given.
 *
 * `add` and `edited` both count, the later text winning, because an edit can add a tag. A
 * `remove` withdraws the comment: a reply the staff deleted is not an answer the customer
 * can read. Anything not written by `pageId` is ignored — a stylist's personal account
 * thanking someone (webhook 484, «Khulan Erdene Баярлалаа💕») is not the Page, and the
 * ignore list, not this, is where a staff member's own account is named.
 */
export function pageCommentsIn(entries: readonly unknown[], pageId: string): PageComment[] {
  const byId = new Map<string, PageComment>();
  const removed = new Set<string>();
  for (const entry of entries) {
    const changes = asRecord(entry)?.['changes'];
    if (!Array.isArray(changes)) continue;
    for (const raw of changes) {
      const change = asRecord(raw);
      if (change === null || change['field'] !== 'feed') continue;
      const value = asRecord(change['value']);
      if (value === null || value['item'] !== 'comment') continue;
      const from = asRecord(value['from']);
      if (from === null || String(from['id'] ?? '') !== pageId) continue;
      const commentId = String(value['comment_id'] ?? '');
      const postId = String(value['post_id'] ?? '');
      if (commentId === '' || postId === '') continue;
      if (value['verb'] === 'remove') {
        removed.add(commentId);
        continue;
      }
      if (value['verb'] !== 'add' && value['verb'] !== 'edited') continue;
      const previous = byId.get(commentId);
      const text = typeof value['message'] === 'string' ? nfc(value['message']) : previous?.text ?? '';
      byId.set(commentId, {
        commentId,
        postId,
        parentId: typeof value['parent_id'] === 'string' ? value['parent_id'] : previous?.parentId ?? '',
        text,
      });
    }
  }
  return [...byId.values()].filter((c) => !removed.has(c.commentId));
}

/**
 * Does `text` name `person` — every word of the name, in order, as whole words?
 *
 * A name that reduces to no words (emoji only, punctuation only) names nobody.
 */
export function namesPerson(text: string, person: string): boolean {
  const want = messageWords(person);
  if (want.length === 0) return false;
  const have = messageWords(text);
  for (let i = 0; i + want.length <= have.length; i += 1) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

export type StaffCheck =
  | { handled: false }
  | {
      handled: true;
      /** (a) replied under this very comment, or (b) tagged this commenter on the post. */
      how: 'replied' | 'tagged';
      /** The Page comment that proves it — an id, never its text. */
      staffCommentId: string;
    }
  /**
   * The check could not be made. Unknown is not "nobody answered": refusing is the
   * direction that cannot put the bot's line under a customer a person already answered.
   */
  | { handled: null; detail: string };

/**
 * Decide (a) and (b) for one customer comment against the Page's comments.
 *
 * `ours` is the set of Page comment ids that are THIS PLATFORM's replies
 * (`outbound_messages.provider_message_id`): once comments are live, the bot's own line is a
 * Page comment too, and counting it as staff would re-attribute `thread_already_answered` to
 * a person who never typed anything.
 */
export function staffHandled(input: {
  comment: { commentId: string; postId: string; fromName: string | null };
  pageComments: readonly PageComment[];
  ours: ReadonlySet<string>;
}): StaffCheck {
  const staff = input.pageComments.filter((c) => c.postId === input.comment.postId && !input.ours.has(c.commentId));

  const reply = staff.find((c) => c.parentId === input.comment.commentId);
  if (reply !== undefined) return { handled: true, how: 'replied', staffCommentId: reply.commentId };

  const name = input.comment.fromName;
  if (name === null || messageWords(name).length === 0) {
    // Every comment on record carries `from.name` (78 of 78). Without it (b) cannot be
    // asked, and an unasked question does not answer "no".
    return { handled: null, detail: 'the comment carries no commenter name, so a tag by the Page cannot be ruled out' };
  }
  const tag = staff.find((c) => namesPerson(c.text, name));
  if (tag !== undefined) return { handled: true, how: 'tagged', staffCommentId: tag.commentId };

  return { handled: false };
}
