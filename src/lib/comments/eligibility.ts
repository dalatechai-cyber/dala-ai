/**
 * May we reply publicly to this comment, and with what? (§3.8.2, §3.8.3.)
 *
 * A pure decision over values. No database, no clock beyond the `now` handed in, no Graph
 * call — so every refusal below is reachable in a test, which matters more here than
 * anywhere else in the codebase: this is the only surface where a mistake is **public,
 * permanent, screenshot-able, and in the tenant's own voice under their own post**.
 *
 * ## The reply text cannot depend on the comment text. Structurally.
 *
 * `decideCommentReply` never receives the customer's words. It takes the tenant's pinned
 * line and returns it unchanged or refuses — there is no parameter through which a
 * question about prices could influence an answer, and no branch that could grow one
 * later without changing this signature.
 *
 * That is the whole safety argument for the feature, and it is deliberately a matter of
 * types rather than discipline. "Never answer prices, availability or treatment questions
 * in a comment regardless of what is asked" is not a rule the code follows; it is a
 * sentence that cannot be expressed in this function's inputs.
 *
 * ## A missing pinned line means silence, never a default
 *
 * If the tenant has no reviewed `comment_public_reply`, we do not reply. There is no
 * platform fallback and there must never be one: a sentence Dalatech wrote, posted under
 * a salon's post in the salon's voice, is the same failure as generated prose one step
 * removed. `reviewed_at` is the same gate every other pinned sentence passes.
 */

/** `tenant_channels.comment_policy`. V1 implements two of the four. */
export type CommentPolicy = 'none' | 'public_only' | 'private_only' | 'both';

export type CommentRefusal =
  /** The tenant has comments switched off. The default, and the safe one. */
  | 'comment_policy_off'
  /** `private_only` / `both` — designed in §3.8.4, not built. Refused rather than approximated. */
  | 'private_reply_not_implemented'
  /** A staff member's personal account, per `tenant_channels.ignore_commenter_ids`. */
  | 'commenter_ignored'
  /** A reply to one of our own comments: the loop, one level down. */
  | 'reply_to_self'
  /** The post is older than the tenant's window. Old posts attract spam. */
  | 'post_too_old'
  /** We could not date the comment. Unknown age is not young. */
  | 'comment_age_unknown'
  /** This thread already has its one public reply. */
  | 'thread_already_answered'
  /** No reviewed pinned line for this tenant and locale. Silence, never a default. */
  | 'no_reviewed_line';

export type CommentDecision =
  | { reply: true; body: string; threadId: string }
  | { reply: false; refusal: CommentRefusal; detail: string };

export type CommentChannelConfig = {
  policy: string;
  /** §3.8.2 rule 5. Default 30 — old posts attract spam and the tenant gets no value. */
  maxPostAgeDays: number;
  /** §3.8.2 rule 3. A stylist commenting from her personal account is a customer by id shape. */
  ignoreCommenterIds: readonly string[];
};

export type CommentDecisionInput = {
  config: CommentChannelConfig;
  /** The tenant's own pinned sentence, and whether a human has signed it off. */
  pinnedLine: { body: string; reviewedAt: string | null } | null;
  comment: {
    commentId: string;
    threadId: string;
    fromId: string;
    createdAt: Date;
    /** True when the parent comment is one of ours. Resolved by the caller from our rows. */
    parentIsOurs: boolean;
  };
  /** Whether this thread already carries a `comment_reply` outbound row. */
  threadAlreadyAnswered: boolean;
  now: Date;
};

/**
 * Every check, in the order a refusal should be attributed.
 *
 * Cheapest and most categorical first: a tenant with comments off should never produce a
 * counter that says "we declined because the post was old", because they did not decline
 * anything — they never opted in.
 */
export function decideCommentReply(input: CommentDecisionInput): CommentDecision {
  const { config, comment, now } = input;

  if (config.policy === 'none') {
    return { reply: false, refusal: 'comment_policy_off', detail: 'this channel does not answer comments' };
  }
  if (config.policy !== 'public_only') {
    // `private_only` and `both` need §3.8.4's single-use, seven-day, expiring private
    // reply, which is not built. Approximating it with a public reply would silently turn
    // a tenant's private-only choice into a public post under their own wall.
    return {
      reply: false,
      refusal: 'private_reply_not_implemented',
      detail: `comment_policy ${JSON.stringify(config.policy)} needs the private reply, which V1 does not have`,
    };
  }

  if (comment.parentIsOurs) {
    return { reply: false, refusal: 'reply_to_self', detail: 'this is a reply to our own comment' };
  }
  if (config.ignoreCommenterIds.includes(comment.fromId)) {
    // Not a customer. The bot must not talk over the salon's own staff on their own post.
    return { reply: false, refusal: 'commenter_ignored', detail: 'the commenter is on this channel ignore list' };
  }

  const ageMs = now.getTime() - comment.createdAt.getTime();
  if (Number.isNaN(ageMs)) {
    // An undated comment is not a young one. Refusing is the direction that cannot put a
    // reply under a four-year-old post.
    return { reply: false, refusal: 'comment_age_unknown', detail: 'the comment carries no usable created_time' };
  }
  if (ageMs > config.maxPostAgeDays * 86_400_000) {
    return {
      reply: false,
      refusal: 'post_too_old',
      detail: `${Math.floor(ageMs / 86_400_000)} days old; this channel's limit is ${config.maxPostAgeDays}`,
    };
  }

  if (input.threadAlreadyAnswered) {
    // Three comments in one thread get ONE reply. The database enforces this too — the
    // unique index on (tenant_id, kind, dedup_key) — and this check is what keeps the
    // common case from relying on a constraint violation.
    return { reply: false, refusal: 'thread_already_answered', detail: 'this thread already has its one public reply' };
  }

  const line = input.pinnedLine;
  if (line === null || line.reviewedAt === null || line.body.trim() === '') {
    return {
      reply: false,
      refusal: 'no_reviewed_line',
      detail: 'no reviewed comment_public_reply for this tenant and locale; refusing to invent one',
    };
  }

  // The tenant's sentence, unchanged. Nothing above read the comment's text, and nothing
  // here can transform it.
  return { reply: true, body: line.body, threadId: comment.threadId };
}
