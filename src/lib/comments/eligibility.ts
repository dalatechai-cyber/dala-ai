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

import type { CommentVerdict } from './classify.ts';
import type { StaffCheck } from './staff.ts';

/** `tenant_channels.comment_policy`. V1 implements two of the four. */
export type CommentPolicy = 'none' | 'public_only' | 'private_only' | 'both';

export type CommentRefusal =
  /** The tenant has comments switched off. The default, and the safe one. */
  | 'comment_policy_off'
  /** A staff member's personal account, per `tenant_channels.ignore_commenter_ids`. */
  | 'commenter_ignored'
  /** A reply to one of our own comments: the loop, one level down. */
  | 'reply_to_self'
  /**
   * The COMMENT is older than the tenant's window, and the name says so now (D-085).
   *
   * It read `post_too_old`, it is configured by `comment_max_post_age_days`, and §3.8.2
   * rule 5 justifies it as *old posts attract spam and the tenant gets no value* — but the
   * value it measures is `value.created_time` on the COMMENT. **A brand-new spam comment
   * on a four-year-old post has an age near zero and passes**, which is the exact case the
   * rule was written to stop, and the branch below says so in as many words one line up.
   *
   * What it does do is worth keeping, so it is kept and renamed rather than deleted: it
   * bounds how stale a DELIVERY this platform will act on, which is a real guarantee
   * against a replayed or long-delayed webhook.
   *
   * **The post-age rule is therefore NOT IMPLEMENTED**, and it cannot be from this payload:
   * the `feed` webhook carries `post_id` but no post creation time, and a Facebook post id
   * is not a timestamp. Closing it needs `GET /{post-id}?fields=created_time` — a Graph
   * read this platform does not make, cacheable per post, with its own failure mode on a
   * path that must fail closed. That is a design decision, not a rename.
   */
  | 'comment_too_old'
  /** We could not date the comment. Unknown age is not young. */
  | 'comment_age_unknown'
  /**
   * A person must look at this one. Posts NOTHING (docs/comments.md).
   *
   * The corpus has four of these in 71 messages — «Утсаа авахгүй байна», *you are not
   * answering the phone*. In a DM that is bad; in a public comment the pinned line, whose
   * whole content is *come to DM*, is close to the worst available answer: a brush-off to a
   * visible complaint, in the salon's own voice, permanently, under their own post.
   */
  | 'comment_escalated'
  /** A rule recognised this as noise — praise, a tag, an emoji. */
  | 'comment_not_worth_reply'
  /**
   * NO rule fired. Silent for the same reason, counted separately on purpose.
   *
   * Distinguishing this from `comment_not_worth_reply` is what makes the shadow phase
   * produce a stem list instead of a score: every row here is either a rule the tenant
   * should add or a silence that is correct, and only reading them says which. Merged into
   * the noise counter they would be unfindable under the volume of «гоё».
   */
  | 'comment_unclassified'
  /** This thread already has its one public reply. */
  | 'thread_already_answered'
  /**
   * The salon's staff already replied under this comment, from the Page (D-122 addendum,
   * `comments/staff.ts`). A person answered; the bot's line under theirs is a second answer
   * in the salon's own voice.
   */
  | 'staff_replied'
  /** The Page already tagged this commenter on this post — staff answered them there. */
  | 'staff_tagged_commenter'
  /** Whether staff answered could not be read. Unknown refuses, as `comment_lookup_unknown` does. */
  | 'staff_check_unknown'
  /**
   * This PERSON already has their reply on this post (D-122, founder: "at most one reply
   * per person per post"). Two separate comments by one customer under one post are two
   * threads, so the thread rule alone would answer both.
   */
  | 'person_already_answered'
  /**
   * The comment tags another person (D-122). Read from Graph's `message_tags`, because the
   * webhook carries a tag only as the person's name in plain text. «Bold, look at this» is
   * two friends talking under the salon's post; a salon line under it is an intrusion.
   * A tag of the salon's own Page is not a person and does not refuse.
   */
  | 'comment_tags_person'
  /** The POST is older than the channel's window — §3.8.2 rule 5, closed at last (D-122). */
  | 'post_too_old'
  /**
   * We could not read the post's age or the comment's tags. Unknown is not young and not
   * untagged: refusing is the direction that cannot put a line under a friend's tag or
   * resurface a four-year-old post.
   */
  | 'comment_lookup_unknown'
  /** This POST already has today's allowance of public replies, in any thread. */
  | 'post_cap_reached'
  /** No reviewed pinned line for this tenant and locale. Silence, never a default. */
  | 'no_reviewed_line';

export type CommentDecision =
  | {
      reply: true;
      /** The public line, when the policy posts one. Null under `private_only`. */
      publicBody: string | null;
      /** The private message, when the policy sends one. Null under `public_only`. */
      privateBody: string | null;
      threadId: string;
      postId: string;
      fromId: string;
    }
  | { reply: false; refusal: CommentRefusal; detail: string };

export type CommentChannelConfig = {
  policy: string;
  /** §3.8.2 rule 5. Default 30 — old posts attract spam and the tenant gets no value. */
  maxPostAgeDays: number;
  /** §3.8.2 rule 3. A stylist commenting from her personal account is a customer by id shape. */
  ignoreCommenterIds: readonly string[];
  /**
   * §3.8.2 rule 4, as the founder settled it: **1**. Public replies allowed under one
   * post in any rolling 24 hours, across every thread on it.
   *
   * The per-thread rule alone does not stop this: five people commenting separately on
   * one post are five threads, so they would get five identical replies under it. The
   * reply is the same sentence every time and its whole job is "come to DM" — saying it
   * once is enough for everyone reading, and saying it five times reads as spam on the
   * tenant's own wall.
   */
  repliesPerPostPerDay: number;
};

export type CommentDecisionInput = {
  config: CommentChannelConfig;
  /**
   * What `classifyComment` decided — an ENUM, never the comment's text.
   *
   * This is the one field that carries any information about what the customer wrote, and
   * it carries four possible values. The docstring at the top of this file says the reply
   * text cannot depend on the comment text *structurally*; that is still true, because
   * there is no value of this field that selects a different sentence. It selects only
   * whether the tenant's one pinned line is sent at all.
   *
   * Passing the text here instead would have been the obvious wiring and would have ended
   * the guarantee — D-082's lesson, that the defect is a parameter which accepts a string.
   */
  verdict: CommentVerdict;
  /** The tenant's own pinned sentence, and whether a human has signed it off. */
  pinnedLine: { body: string; reviewedAt: string | null } | null;
  /** The tenant's private message to a commenter (`comment_private_reply`), same rules. */
  privateLine: { body: string; reviewedAt: string | null } | null;
  comment: {
    commentId: string;
    threadId: string;
    /** The post the comment sits under. What the daily cap is counted against. */
    postId: string;
    fromId: string;
    createdAt: Date;
    /** True when the parent comment is one of ours. Resolved by the caller from our rows. */
    parentIsOurs: boolean;
  };
  /** Whether this thread already carries a `comment_reply` outbound row. */
  threadAlreadyAnswered: boolean;
  /** Whether this commenter already has a comment reply or private reply on this post. */
  personAlreadyAnswered: boolean;
  /**
   * Whether a person at the salon already answered this commenter from the Page
   * (`staffHandled`). Required, never defaulted: a default of "nobody answered" would assert
   * that on behalf of a caller who forgot to look — D-083's reason.
   */
  staff: StaffCheck;
  /**
   * How many public replies this POST has already had in the window — from our own
   * `outbound_messages` rows, counted by the caller. Not a boolean, because the cap is a
   * number the tenant sets.
   */
  postRepliesInWindow: number;
  now: Date;
  /**
   * A post whose public replies are capped still gets the PRIVATE message (D-144). Set for a
   * rule with its own lines — the call to action, where the private message is the point and
   * everyone who answers the post is owed it. The public line is withheld as the cap says.
   * Absent or false: the cap refuses both, as it always has.
   */
  privateWhenCapped?: boolean;
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
  if (config.policy !== 'public_only' && config.policy !== 'private_only' && config.policy !== 'both') {
    // A value this code does not understand is not a value to post on.
    return {
      reply: false,
      refusal: 'comment_policy_off',
      detail: `unrecognised comment_policy ${JSON.stringify(config.policy)}`,
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
      refusal: 'comment_too_old',
      // Says which age it measured. The previous wording — and the refusal's previous
      // name — would have sent a reader looking for a post-age rule that is not there.
      detail: `the COMMENT is ${Math.floor(ageMs / 86_400_000)} days old; this channel's limit is ${config.maxPostAgeDays}. The POST's age is not checked — see comment_too_old`,
    };
  }

  // THE VERDICT, and it sits here on purpose — after the categorical facts about who wrote
  // this and when, before both counting rules.
  //
  // Putting it after `post_cap_reached` would be the natural reading of "cheapest first"
  // and it would corrupt the one number the cap exists to be judged by. The operator's
  // question is *is a cap of 1 costing me customers?*, and they answer it by counting
  // `post_cap_reached`. With the verdict downstream, every «гоё» arriving on a capped post
  // lands in that counter too, and the honest answer is buried under noise that was never
  // going to be replied to. Here, `post_cap_reached` and `thread_already_answered` mean
  // exactly *a comment worth answering that we declined for a structural reason* — which
  // is the number, and the only number, that should move the cap.
  //
  // It is also what keeps the allowance intact: a refusal never drafts a row, and the cap
  // is counted from drafted rows, so an escalated or ignored comment cannot consume it.
  if (input.verdict === 'escalate') {
    return {
      reply: false,
      refusal: 'comment_escalated',
      detail: 'a person must answer this one; the pinned line points at DM and this is not a DM question',
    };
  }
  if (input.verdict === 'ignore') {
    return { reply: false, refusal: 'comment_not_worth_reply', detail: 'a rule recognised this as noise' };
  }
  if (input.verdict === 'unclassified') {
    return { reply: false, refusal: 'comment_unclassified', detail: 'no rule fired; silent, and recorded so a rule can be written' };
  }

  // STAFF, after the verdict and before our own counting rules (D-122 addendum). After the
  // verdict so praise the staff thanked stays `comment_not_worth_reply` — that is the more
  // useful number, and nothing would have been sent either way — and so a complaint still
  // escalates to the founder whoever replied to it. Before the person and thread rules
  // because those count OUR rows, and on a delivering channel they trigger `resumePending`,
  // which would send a draft decided before the staff answered.
  if (input.staff.handled === null) {
    return { reply: false, refusal: 'staff_check_unknown', detail: input.staff.detail };
  }
  if (input.staff.handled) {
    return input.staff.how === 'replied'
      ? { reply: false, refusal: 'staff_replied', detail: `the Page already replied under this comment (${input.staff.staffCommentId})` }
      : { reply: false, refusal: 'staff_tagged_commenter', detail: `the Page already tagged this commenter on this post (${input.staff.staffCommentId})` };
  }

  if (input.personAlreadyAnswered) {
    // Checked before the thread rule because it is the rule the founder named, and the
    // more specific truth when both hold: the same person, the same post.
    return { reply: false, refusal: 'person_already_answered', detail: 'this person already has their reply on this post' };
  }
  if (input.threadAlreadyAnswered) {
    // Three comments in one thread get ONE reply. The database enforces this too — the
    // unique index on (tenant_id, kind, dedup_key) — and this check is what keeps the
    // common case from relying on a constraint violation.
    return { reply: false, refusal: 'thread_already_answered', detail: 'this thread already has its one public reply' };
  }

  // The post cap is checked AFTER the thread rule, not before, and the ordering is about
  // attribution rather than safety — both must pass either way. A second comment in an
  // already-answered thread is `thread_already_answered`, which is the more specific
  // truth; `post_cap_reached` is then reserved for what the thread rule does not catch,
  // which is the case this cap exists for: separate people, separate threads, one post.
  const capped = input.postRepliesInWindow >= config.repliesPerPostPerDay;
  const privateOnly = capped && input.privateWhenCapped === true
    && (config.policy === 'private_only' || config.policy === 'both');
  if (capped && !privateOnly) {
    return {
      reply: false,
      refusal: 'post_cap_reached',
      detail:
        `this post has had ${input.postRepliesInWindow} public repl${input.postRepliesInWindow === 1 ? 'y' : 'ies'} ` +
        `in the last 24 hours; this channel allows ${config.repliesPerPostPerDay}`,
    };
  }

  const wantsPublic = config.policy === 'public_only' || config.policy === 'both';
  const wantsPrivate = config.policy === 'private_only' || config.policy === 'both';
  const usable = (l: { body: string; reviewedAt: string | null } | null): l is { body: string; reviewedAt: string } =>
    l !== null && l.reviewedAt !== null && l.body.trim() !== '';
  // BOTH lines the policy names must be reviewed, or neither is sent. Half of "both" is a
  // different policy from the one the tenant chose: a public "message us" line with no
  // private message behind it sends the customer to an inbox nobody has written in.
  if (wantsPublic && !usable(input.pinnedLine)) {
    return {
      reply: false,
      refusal: 'no_reviewed_line',
      detail: 'no reviewed comment_public_reply for this tenant and locale; refusing to invent one',
    };
  }
  if (wantsPrivate && !usable(input.privateLine)) {
    return {
      reply: false,
      refusal: 'no_reviewed_line',
      detail: 'no reviewed comment_private_reply for this tenant and locale; refusing to invent one',
    };
  }

  // The tenant's sentences, unchanged. Nothing above read the comment's text, and nothing
  // here can transform it.
  return {
    reply: true,
    publicBody: wantsPublic && !privateOnly && input.pinnedLine !== null ? input.pinnedLine.body : null,
    privateBody: wantsPrivate && input.privateLine !== null ? input.privateLine.body : null,
    threadId: comment.threadId,
    postId: comment.postId,
    fromId: comment.fromId,
  };
}

/**
 * The two checks that need a Graph read (D-122), decided on what the read returned.
 *
 * Split from `decideCommentReply` because the read costs a round trip and is made only for
 * a comment that function already decided to answer — praise and tags between friends are
 * the bulk of a salon's comments, and none of them should cost a request.
 *
 * `null` means the read did not answer that question, and unknown refuses.
 */
export function decideAfterLookup(input: {
  tagsPerson: boolean | null;
  postCreatedAt: Date | null;
  maxPostAgeDays: number;
  now: Date;
}): { ok: true } | { ok: false; refusal: CommentRefusal; detail: string } {
  if (input.tagsPerson === null || input.postCreatedAt === null || Number.isNaN(input.postCreatedAt.getTime())) {
    return {
      ok: false,
      refusal: 'comment_lookup_unknown',
      detail: `could not read ${input.tagsPerson === null ? 'the comment’s tags' : 'the post’s age'}; unknown refuses`,
    };
  }
  if (input.tagsPerson) {
    return { ok: false, refusal: 'comment_tags_person', detail: 'the comment tags another person; it is addressed to them' };
  }
  const ageMs = input.now.getTime() - input.postCreatedAt.getTime();
  if (ageMs > input.maxPostAgeDays * 86_400_000) {
    return {
      ok: false,
      refusal: 'post_too_old',
      detail: `the POST is ${Math.floor(ageMs / 86_400_000)} days old; this channel's limit is ${input.maxPostAgeDays}`,
    };
  }
  return { ok: true };
}
