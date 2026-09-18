/**
 * The comment path: one stored `feed` entry in, public replies out.
 *
 * Separate from `worker/reception.ts` and called by it, for the reason that runs through
 * this whole feature: a DM and a public post are different surfaces, and there must be no
 * branch where one can be handled as the other. They share a stored entry and the tenant's
 * credential; nothing else.
 *
 * ## Where the one-reply-per-thread rule actually lives
 *
 * In two places, and the second one is the database. `decideCommentReply` refuses when it
 * already knows the thread is answered — that is the common case and it costs one read.
 * `draftOnce` then writes an `outbound_messages` row with `kind='comment_reply'` and
 * `dedup_key = threadId`, under the unique index that was already there, so two workers
 * racing the same redelivery cannot both post: one loses the insert and re-reads the
 * winner's row.
 *
 * Belt and braces on a public surface is not paranoia. A duplicate DM is an embarrassment
 * in a private thread; a duplicate public reply is two identical comments under a
 * customer's question on the salon's own wall, permanently, where their other customers
 * are reading.
 *
 * ## Generate and deliver are two questions, and this file used to ask only one
 *
 * `canDeliver` answers both: `shadow` is `{ generate: true, deliver: false }` — decide the
 * reply, write it down, withhold it — and `off` is false for both. This function read only
 * `deliver` and returned before drafting, so a mirroring channel produced refusal counters
 * and no rows.
 *
 * That mattered more here than anywhere. The DM path's fourteen withheld days are where
 * D-066's gate-label leak, D-068's discarded booking reply and D-069's «Хаяг»-over-a-phone
 * label were found — three defects that no test produced, on the surface where a mistake is
 * private and recoverable. The public surface, where a mistake is permanent and under the
 * salon's own post, was the one that could not be rehearsed at all.
 *
 * The withhold now sits AFTER `draftOnce` and after the two in-entry counters, so a shadow
 * run exercises the thread rule and the per-post cap rather than stubbing them: what the
 * corpus shows is what going live would have done. The row stays `draft` and therefore
 * claimable, which is the same disposition `worker/reception.ts` gives a withheld DM.
 *
 * ## Why the reply text is read here and not in the reception context
 *
 * `loadReceptionContext` compiles a prompt snapshot, gate rules, deterministic replies and
 * business hours — all of it for a reply that is one fixed sentence chosen without reading
 * the customer's words. The comment path needs exactly one `canned_responses` row, so it
 * reads exactly one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canDeliver } from '../channel/delivery.ts';
import { extractComments, type InboundComment } from '../meta/comments.ts';
import { decideCommentReply, type CommentChannelConfig, type CommentRefusal } from '../comments/eligibility.ts';
import { classifyComment, type CommentRule } from '../comments/classify.ts';
import { cpLength } from '../mn/text.ts';
import type { CommentSendOutcome } from '../comments/send.ts';
import { claim, draftOnce, markFailed, markIndeterminate, markSent } from '../outbound/claim.ts';
import { MESSENGER_SEND_UNIT_COST } from '../../config/platform.ts';

/** The canned kind seeded by 0007. One sentence, per tenant, per locale. */
export const COMMENT_LINE_KIND = 'comment_public_reply';

/**
 * The flag written for a comment no rule fired on (D-085).
 *
 * It carries the comment's IDS and its shape, and deliberately **not its text**.
 * `quality_flags` is not reached by `ops.purge_expired` — that function deletes and nulls
 * `webhook_events` — so a copy of a customer's words here would be a second store of the
 * same PII under weaker rules than the first. The text is already in
 * `webhook_events.raw_payload`, already governed by the tenant's retention and already
 * nulled by the purge; the operator's tool joins back to it by `comment_id` for as long as
 * it exists, and after that the text is gone, which is correct rather than unfortunate.
 */
export const UNCLASSIFIED_FLAG = 'comment_unclassified';

export type CommentEffects = {
  db: SupabaseClient;
  now: Date;
  /**
   * Carries the tenant and channel because the credential is resolved PER CALL — the route
   * binding cannot close over them, since it is built before the job body is parsed, and
   * hoisting the token to where it could be closed over is exactly the module-scope
   * credential cache CLAUDE.md rule 7 forbids.
   */
  replyToComment: (args: {
    tenantId: string;
    channelId: string;
    commentId: string;
    body: string;
    graphVersion: string;
  }) => Promise<CommentSendOutcome>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

export type CommentJobInput = {
  tenantId: string;
  channelId: string;
  /** The channel's `external_id`: the Page. Used to spot the Page's own comments. */
  pageExternalId: string;
  deliveryMode: string;
  graphVersion: string;
  locale: string;
  config: CommentChannelConfig;
  rawPayload: unknown;
};

export type CommentJobResult = {
  /** Public replies actually posted. */
  replied: number;
  /**
   * Replies decided and written as `draft`, then withheld because the channel is mirroring.
   *
   * Separate from `replied` because the difference is the entire safety of the mirror: a
   * number here means rows exist on a wall nobody can see, and a number in `replied` means
   * rows exist on a wall the salon's customers are reading.
   */
  drafted: number;
  /** Comments seen and deliberately not answered, by reason. */
  refused: Partial<Record<
    CommentRefusal | 'not_generating' | 'not_delivering' | 'send_failed' | 'indeterminate',
    number
  >>;
  /** Extractor skips — the `feed` firehose, counted so its volume is visible. */
  skipped: string[];
  /** True when something transient failed and the caller must 503. */
  retry: boolean;
};

/** The tenant's pinned public line, or null. Never a platform default — see eligibility.ts. */
async function readPinnedLine(
  db: SupabaseClient,
  input: { tenantId: string; locale: string },
): Promise<{ ok: true; line: { body: string; reviewedAt: string | null } | null } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('canned_responses')
    .select('body, reviewed_at')
    .eq('tenant_id', input.tenantId)
    .eq('kind', COMMENT_LINE_KIND)
    .eq('locale', input.locale)
    .maybeSingle();
  if (error) return { ok: false, detail: `canned_responses unreadable: ${error.message}` };
  if (data === null) return { ok: true, line: null };
  const row = data as Record<string, unknown>;
  return {
    ok: true,
    line: { body: String(row['body'] ?? ''), reviewedAt: row['reviewed_at'] === null ? null : String(row['reviewed_at']) },
  };
}

/**
 * The tenant's enabled comment rules (D-085).
 *
 * `enabled` is filtered HERE rather than in `classifyComment`, so the classifier is handed
 * the rules that are live and cannot be made to reason about ones that are not. A tenant
 * whose rows all happen to be disabled therefore reaches `classifyComment` with an empty
 * list and refuses with `no_rules` — which is the intended reading: a switched-on comment
 * channel with no live rule is not a channel that ignores everything, it is a channel
 * nobody finished configuring.
 */
async function readCommentRules(
  db: SupabaseClient,
  input: { tenantId: string },
): Promise<{ ok: true; rules: CommentRule[] } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('comment_rules')
    .select('rule_key, verdict, matcher')
    .eq('tenant_id', input.tenantId)
    .eq('enabled', true);
  if (error) return { ok: false, detail: `comment_rules unreadable: ${error.message}` };
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    rules: rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        ruleKey: String(row['rule_key']),
        // The CHECK constraint is the guarantee; this cast carries it across the seam. A
        // value outside the three would make `classifyComment` treat the rule as matching
        // nothing, which is why the constraint and not the cast is what is relied on.
        verdict: String(row['verdict']) as CommentRule['verdict'],
        matcher: row['matcher'],
      };
    }),
  };
}

/**
 * Record a comment no rule fired on, so the shadow phase produces a stem list.
 *
 * Failure here does NOT fail the job. The row is an instrument, and a tenant losing one
 * line of their own to-do list is not a reason to stop answering customers — the opposite
 * trade from every refusal in `eligibility.ts`, because nothing downstream reads this.
 * It is logged so the loss is visible rather than assumed away.
 */
async function recordUnclassified(
  fx: CommentEffects,
  input: { tenantId: string; comment: InboundComment },
): Promise<void> {
  const { error } = await fx.db.from('quality_flags').insert({
    tenant_id: input.tenantId,
    flag: UNCLASSIFIED_FLAG,
    detail: {
      comment_id: input.comment.commentId,
      post_id: input.comment.postId,
      // Shape, not content — see UNCLASSIFIED_FLAG. Characters, never bytes (rule 6).
      chars: cpLength(input.comment.text),
      has_cyrillic: HAS_CYRILLIC.test(input.comment.text),
    },
    at: fx.now.toISOString(),
  });
  if (error) fx.log('warn', 'comment_unclassified_unrecorded', { detail: error.message });
}

/**
 * Does this text carry any Cyrillic at all?
 *
 * Recorded because 52% of the DM corpus does not, and a silence that is all Latin means
 * something different from one that is all Cyrillic: the first says the tenant's stem list
 * is missing the romanised spellings (D-067), the second says it is missing a word.
 */
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * Is the comment this one replies to one of OURS?
 *
 * The loop the thread rule alone does not close. A customer comments (thread C1); we reply
 * R1; somebody replies to R1. That third comment's thread root is R1, which has no
 * outbound row of its own — so `threadAlreadyAnswered` is false and we would answer it,
 * and then answer the answer. The salon talking to itself, in public, forever.
 *
 * `provider_message_id` is the id Meta gave our reply when it was posted, so a parent that
 * matches one is a parent we wrote.
 */
async function parentsWeWrote(
  db: SupabaseClient,
  input: { tenantId: string; parentIds: readonly string[] },
): Promise<{ ok: true; ours: Set<string> } | { ok: false; detail: string }> {
  if (input.parentIds.length === 0) return { ok: true, ours: new Set() };
  const { data, error } = await db
    .from('outbound_messages')
    .select('provider_message_id')
    .eq('tenant_id', input.tenantId)
    .eq('kind', 'comment_reply')
    .in('provider_message_id', [...input.parentIds]);
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const rows = Array.isArray(data) ? data : [];
  return { ok: true, ours: new Set(rows.map((r) => String((r as Record<string, unknown>)['provider_message_id']))) };
}

/** Which of these threads already carry their one public reply. */
async function answeredThreads(
  db: SupabaseClient,
  input: { tenantId: string; threadIds: readonly string[] },
): Promise<{ ok: true; answered: Set<string> } | { ok: false; detail: string }> {
  if (input.threadIds.length === 0) return { ok: true, answered: new Set() };
  const { data, error } = await db
    .from('outbound_messages')
    .select('dedup_key')
    .eq('tenant_id', input.tenantId)
    .eq('kind', 'comment_reply')
    .in('dedup_key', [...input.threadIds]);
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const rows = Array.isArray(data) ? data : [];
  return { ok: true, answered: new Set(rows.map((r) => String((r as Record<string, unknown>)['dedup_key']))) };
}

/**
 * How many public replies each of these posts has had in the last 24 hours.
 *
 * Counted from `outbound_messages` itself rather than from a counter kept beside it. 0007
 * argued against a second table for the per-thread rule because the two would disagree the
 * first time a worker died between them, and a counter incremented next to the row it
 * counts is exactly that pair. One table answers both questions and there is nothing to
 * reconcile.
 *
 * A draft row is written BEFORE the send, so a worker that dies mid-send leaves the count
 * one too high and the post under-replied. That is the direction to fail in on a wall the
 * tenant's customers are reading.
 */
async function repliesPerPost(
  db: SupabaseClient,
  input: { tenantId: string; postIds: readonly string[]; since: Date },
): Promise<{ ok: true; counts: Map<string, number> } | { ok: false; detail: string }> {
  if (input.postIds.length === 0) return { ok: true, counts: new Map() };
  const { data, error } = await db
    .from('outbound_messages')
    .select('comment_post_id')
    .eq('tenant_id', input.tenantId)
    .eq('kind', 'comment_reply')
    .in('comment_post_id', [...input.postIds])
    .gte('created_at', input.since.toISOString());
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const counts = new Map<string, number>();
  for (const row of Array.isArray(data) ? data : []) {
    const id = String((row as Record<string, unknown>)['comment_post_id']);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { ok: true, counts };
}

/** The cap's window. A rolling 24 hours: see 0009 for why not a calendar day. */
export const POST_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

function count(into: CommentJobResult['refused'], key: keyof CommentJobResult['refused']): void {
  into[key] = (into[key] ?? 0) + 1;
}

export async function runCommentJob(fx: CommentEffects, input: CommentJobInput): Promise<CommentJobResult> {
  const result: CommentJobResult = { replied: 0, drafted: 0, refused: {}, skipped: [], retry: false };

  const { comments, skipped } = extractComments(input.rawPayload, input.pageExternalId);
  result.skipped = skipped;
  if (comments.length === 0) return result;

  // The same gate the DM path uses, SPLIT the same way — and the split is the whole point.
  //
  // `canDeliver('shadow')` answers `{ generate: true, deliver: false }`, and this function
  // used to read only the second half and return before drafting anything. So a shadowing
  // channel produced counters and no rows: the fourteen days of withheld drafts that found
  // D-066's gate-label leak, D-068's thrown-away booking reply and D-069's «Хаяг» label had
  // no equivalent here at all. The one surface where a mistake is public was the one surface
  // that could not be rehearsed.
  //
  // `off`, `halted` and an unrecognised mode still stop here: nothing is generated for a
  // channel that cannot receive it, which is what `generate` means.
  const delivery = canDeliver(input.deliveryMode);
  if (!delivery.generate) {
    fx.log('info', 'comments_not_generating', { tenantId: input.tenantId, detail: delivery.detail });
    for (const _ of comments) count(result.refused, 'not_generating');
    return result;
  }

  const line = await readPinnedLine(fx.db, { tenantId: input.tenantId, locale: input.locale });
  if (!line.ok) {
    fx.log('error', 'comment_line_unreadable', { tenantId: input.tenantId, detail: line.detail });
    result.retry = true;
    return result;
  }

  // The rules, before anything is decided. A tenant with no live rule refuses the whole
  // job rather than classifying every comment as noise — D-070's rule applied before the
  // mechanism ships: "the classifier has no rules" and "every comment was noise" must not
  // produce the same counters, because the first is a configuration the operator has to
  // finish and the second is a quiet day.
  const rules = await readCommentRules(fx.db, { tenantId: input.tenantId });
  if (!rules.ok) {
    fx.log('error', 'comment_rules_unreadable', { tenantId: input.tenantId, detail: rules.detail });
    result.retry = true;
    return result;
  }

  const parents = await parentsWeWrote(fx.db, {
    tenantId: input.tenantId,
    // Only replies have a parent that could be ours: a top-level comment is its own root.
    parentIds: comments.filter((c) => c.threadId !== c.commentId).map((c) => c.threadId),
  });
  if (!parents.ok) {
    fx.log('error', 'comment_parents_unreadable', { tenantId: input.tenantId, detail: parents.detail });
    result.retry = true;
    return result;
  }

  const answered = await answeredThreads(fx.db, {
    tenantId: input.tenantId,
    threadIds: comments.map((c) => c.threadId),
  });
  if (!answered.ok) {
    fx.log('error', 'comment_threads_unreadable', { tenantId: input.tenantId, detail: answered.detail });
    result.retry = true;
    return result;
  }

  const perPost = await repliesPerPost(fx.db, {
    tenantId: input.tenantId,
    postIds: [...new Set(comments.map((c) => c.postId))],
    since: new Date(fx.now.getTime() - POST_CAP_WINDOW_MS),
  });
  if (!perPost.ok) {
    fx.log('error', 'comment_post_counts_unreadable', { tenantId: input.tenantId, detail: perPost.detail });
    result.retry = true;
    return result;
  }

  // Threads answered within THIS entry, so two comments arriving together in one thread
  // still produce one reply. The database would catch it a moment later; catching it here
  // means the second one never becomes a draft row at all.
  const answeredNow = new Set(answered.answered);
  // The same, one level out: five people commenting on ONE post in one delivery are five
  // threads, and without this they would get five identical replies under it.
  const postCounts = new Map(perPost.counts);

  for (const comment of comments) {
    // A comment carries no attachment kinds on this surface: `extractComments` skips a
    // sticker or bare-photo comment as `no_text` before it reaches here, so there is
    // nothing for a `has_attachment` rule to read. Passed explicitly as empty rather than
    // defaulted, for D-083's reason — a default asserts "no attachment" on behalf of a
    // caller who forgot, and the case it would get wrong is the one the field exists for.
    const classified = classifyComment({ text: comment.text, attachments: [] }, rules.rules);
    if (!classified.ok) {
      // A malformed or missing rule set refuses the JOB, not the comment. Continuing would
      // answer a complaint as a sales enquiry with nothing anywhere going red, which is the
      // failure `parseMatcher` refuses to commit one layer down.
      fx.log('error', 'comment_classify_refused', {
        tenantId: input.tenantId, code: classified.code, detail: classified.detail,
      });
      result.retry = true;
      return result;
    }
    if (classified.verdict === 'unclassified') await recordUnclassified(fx, { tenantId: input.tenantId, comment });

    const decision = decideCommentReply({
      config: input.config,
      verdict: classified.verdict,
      pinnedLine: line.line,
      comment: {
        commentId: comment.commentId,
        threadId: comment.threadId,
        postId: comment.postId,
        fromId: comment.fromId,
        createdAt: comment.createdAt,
        parentIsOurs: parents.ours.has(comment.threadId),
      },
      threadAlreadyAnswered: answeredNow.has(comment.threadId),
      postRepliesInWindow: postCounts.get(comment.postId) ?? 0,
      now: fx.now,
    });

    if (!decision.reply) {
      // Every refusal is counted rather than logged one line each: on a viral post the
      // log would be the volume problem, and a counter is what an operator reads anyway.
      count(result.refused, decision.refusal);
      continue;
    }

    const drafted = await draftOnce(fx.db, {
      tenantId: input.tenantId,
      kind: 'comment_reply',
      // The thread, not the comment. Three comments in one thread share one key, so the
      // second and third lose the insert race and find the first one's row.
      dedupKey: decision.threadId,
      body: decision.body,
      channelId: input.channelId,
      // What the per-post cap is counted from. Written with the draft, i.e. before the
      // send, so the count is high rather than low if this worker dies next.
      commentPostId: decision.postId,
    });
    if (!drafted.ok) {
      fx.log('error', 'comment_draft_failed', { detail: drafted.detail });
      result.retry = true;
      return result;
    }
    answeredNow.add(decision.threadId);
    if (drafted.created) postCounts.set(decision.postId, (postCounts.get(decision.postId) ?? 0) + 1);

    // Decided and written down, and deliberately not posted. The row stays `draft`, so the
    // day the channel goes live it is claimable rather than lost — the same disposition
    // `worker/reception.ts` gives a withheld DM, and the reason the mirror is worth running:
    // a draft nobody sent is still a decision somebody can read.
    //
    // AFTER `draftOnce` and after the two in-entry counters above, so a shadow run exercises
    // the thread rule and the per-post cap rather than stubbing them. What the corpus shows
    // is then what going live would actually have done, which is the only version of it
    // worth reading.
    if (!delivery.deliver) {
      fx.log('info', 'comments_not_delivering', {
        tenantId: input.tenantId, threadId: decision.threadId, detail: delivery.detail,
      });
      count(result.refused, 'not_delivering');
      result.drafted += 1;
      continue;
    }

    // Straight to the claim whether or not WE wrote the row, which is what the DM path in
    // `worker/reception.ts` does and for the same reason. A short-circuit on
    // `!drafted.created` reads as "somebody else has this", and for a `sent`, `sending` or
    // `indeterminate` row it is right — but `failed` is also somebody else's row, and it
    // is one this job asked to be retried. The CAS in `claim` already distinguishes all
    // four (`CLAIMABLE` is draft and failed), so refusing before it turned every
    // `retry: true` on this path into a redelivery that did nothing.
    const held = await claim(fx.db, { id: drafted.row.id, tenantId: input.tenantId, now: fx.now });
    if (held.outcome === 'unavailable') {
      fx.log('error', 'comment_claim_unavailable', { detail: held.detail });
      result.retry = true;
      return result;
    }
    if (held.outcome !== 'claimed') {
      // Already sent, or another worker holds a live lease. Neither is an error.
      count(result.refused, 'thread_already_answered');
      continue;
    }

    const sent = await fx.replyToComment({
      tenantId: input.tenantId,
      channelId: input.channelId,
      commentId: comment.commentId,
      // The STORED body, as everywhere else: a redelivery re-posts what was written, and
      // there is nothing to regenerate because nothing was ever generated.
      body: held.body,
      graphVersion: input.graphVersion,
    });

    if (sent.outcome === 'sent') {
      await markSent(fx.db, {
        id: held.id,
        tenantId: input.tenantId,
        providerMessageId: sent.providerCommentId,
        unitCost: MESSENGER_SEND_UNIT_COST,
        now: fx.now,
      });
      result.replied += 1;
      continue;
    }
    if (sent.outcome === 'indeterminate') {
      // It may already be public. Re-posting would put two identical replies under one
      // customer's comment, so this is parked outside CLAIMABLE for a person to look at.
      await markIndeterminate(fx.db, { id: held.id, tenantId: input.tenantId, reason: sent.detail });
      fx.log('warn', 'comment_reply_indeterminate', { commentId: comment.commentId, detail: sent.detail });
      count(result.refused, 'indeterminate');
      continue;
    }

    await markFailed(fx.db, { id: held.id, tenantId: input.tenantId, attempts: held.attempts, reason: sent.detail });
    count(result.refused, 'send_failed');
    if (sent.retryable) {
      fx.log('warn', 'comment_reply_retryable', { commentId: comment.commentId, failure: sent.failure });
      result.retry = true;
      return result;
    }
    fx.log('error', 'comment_reply_terminal', { commentId: comment.commentId, failure: sent.failure, detail: sent.detail });
  }

  return result;
}

export type { InboundComment };
