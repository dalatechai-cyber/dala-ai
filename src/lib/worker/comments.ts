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
import { canDeliverComments } from '../channel/delivery.ts';
import { extractComments, type InboundComment } from '../meta/comments.ts';
import { decideAfterLookup, decideCommentReply, type CommentChannelConfig, type CommentRefusal } from '../comments/eligibility.ts';
import type { CommentLookup } from '../comments/lookup.ts';
import { pageCommentsIn, staffHandled, type PageComment, type StaffCheck } from '../comments/staff.ts';
import { classifyComment, type CommentRule } from '../comments/classify.ts';
import { cpLength } from '../mn/text.ts';
import type { CommentSendOutcome } from '../comments/send.ts';
import { claim, draftOnce, markFailed, markIndeterminate, markRefused, markSent } from '../outbound/claim.ts';
import { MESSENGER_SEND_UNIT_COST } from '../../config/platform.ts';

/** The canned kind seeded by 0007. One sentence, per tenant, per locale. */
export const COMMENT_LINE_KIND = 'comment_public_reply';

/** The private message to the commenter (0045, D-122). One sentence, per tenant, per locale. */
export const PRIVATE_LINE_KIND = 'comment_private_reply';

/**
 * The dedup key of a private reply: one per person per post, enforced by the unique index
 * `outbound_messages_dedup (tenant_id, kind, dedup_key)` rather than by a read. Meta allows
 * one private reply per COMMENT; the founder allows one per person per post, which is
 * stricter, so the post and the person are the key.
 */
export function privateReplyDedupKey(postId: string, fromId: string): string {
  return `pr:${postId}:${fromId}`;
}

/** The link printed in a complaint alert: the post's permalink, pointed at the comment. */
export function commentLink(comment: { commentId: string; postId: string; postPermalink: string | null }): string {
  // Graph's comment id is `{post}_{comment}`; the `comment_id` query parameter wants the
  // second half. Facebook's own share links take this form.
  const tail = comment.commentId.includes('_') ? comment.commentId.slice(comment.commentId.indexOf('_') + 1) : comment.commentId;
  const base = comment.postPermalink ?? `https://www.facebook.com/${comment.postId}`;
  return `${base}${base.includes('?') ? '&' : '?'}comment_id=${encodeURIComponent(tail)}`;
}

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

/**
 * The flag written for a comment a person must answer (D-085 review).
 *
 * `docs/comments.md` said `escalate` "writes a flag for the operator" and nothing wrote
 * one — the verdict refused the reply, incremented a counter, and left no durable trace of
 * a public complaint anybody could find tomorrow. That is `meta/extract.ts`'s "everything
 * skipped is reported" exactly: a docstring asserting a mechanism that was never built,
 * and the counter made it look present.
 *
 * It carries the same ID-only payload as `UNCLASSIFIED_FLAG` and for the same reason —
 * `quality_flags` is not reached by `ops.purge_expired`, so the customer's words stay in
 * `webhook_events` where the retention policy can reach them.
 */
export const ESCALATED_FLAG = 'comment_escalated';

/**
 * The flag written for a comment the per-post cap silenced.
 *
 * `decideCommentReply` places this check AFTER the verdict on purpose, and its own comment
 * says why in as many words: the operator's question is *is a cap of 1 costing me
 * customers?*, they answer it **by counting `post_cap_reached`**, and putting the verdict
 * downstream would bury that number under every «гоё» arriving on a capped post.
 *
 * That reasoning was right and the counter it describes did not exist. The refusal went
 * into a return value and one log line, so a capped comment left NOTHING in the database —
 * the number the cap is meant to be judged by could not be read at all. Third instance of
 * the same shape in this neighbourhood: `meta/extract.ts` claiming everything skipped was
 * reported, `docs/comments.md` claiming an escalation wrote a flag, and now a comment
 * explaining how to count something uncountable.
 *
 * MEASURED, which is what moved it from tidy to necessary. Matrix's comment rehearsal
 * opened on 2026-09-20 and took six comments in its first 1h47m. Four were on one post.
 * Our own test comment at 02:32 drafted that post's single daily reply, and the only real
 * answerable customer comment of the night — «Яармаг хаяг хаана вэ» at 03:31 — was capped.
 * Nothing anywhere recorded it, and saying what real customers send is the rehearsal's
 * entire purpose.
 *
 * It is the ONLY structural refusal that gets a row, and the line is drawn where a reply
 * was WANTED AND LOST. `thread_already_answered` withholds nothing — the thread has its
 * reply. `comment_self`, `comment_too_old` and `comment_not_worth_reply` were never going
 * to be answered. `no_reviewed_line` is a per-tenant provisioning fault that would write
 * one identical row per comment for ever, which is volume rather than signal.
 *
 * Same ID-only payload as the other two, for the same retention reason, plus the two
 * numbers that let the row answer the question on its own instead of by joining.
 */
export const CAPPED_FLAG = 'comment_post_cap_reached';

/**
 * The flag written when the salon's staff already answered this commenter from the Page
 * (D-122 addendum). A reply that was WANTED and not sent, like `CAPPED_FLAG` — but here the
 * customer was answered, by a person, and the row is what lets the founder count how often
 * the staff got there first. Written at decision time, and again if the check before a live
 * send refuses (`at` says which). Carries ids only: which Page comment proved it, never its
 * text and never the commenter's name.
 */
export const STAFF_FLAG = 'comment_staff_answered';

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
  /**
   * The private message to the commenter (D-122): `POST /{page-id}/messages` with
   * `recipient.comment_id`. Same per-call credential rule as `replyToComment`.
   */
  sendPrivateReply: (args: {
    tenantId: string;
    channelId: string;
    pageId: string;
    commentId: string;
    body: string;
    graphVersion: string;
  }) => Promise<PrivateReplyOutcome>;
  /** Tags and post age from Graph (`comments/lookup.ts`). Never throws; unknown is null. */
  lookupComment: (args: {
    tenantId: string;
    channelId: string;
    pageId: string;
    commentId: string;
    postId: string;
    graphVersion: string;
  }) => Promise<CommentLookup>;
  /**
   * Tell the founder a complaint landed on the wall (D-122). Best effort: the flag row is
   * the durable record, and an alert that could not be sent is logged, never retried by
   * failing the job — a retry would re-run every comment in the entry.
   */
  alertComplaint: (args: { tenantId: string; commentId: string; text: string; link: string }) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

/** What a private reply's send returned — `meta/send.ts`'s outcome, narrowed to what is read. */
export type PrivateReplyOutcome =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'failed'; retryable: boolean; failure: string; detail: string }
  | { outcome: 'indeterminate'; detail: string };

export type CommentJobInput = {
  tenantId: string;
  channelId: string;
  /** The channel's `external_id`: the Page. Used to spot the Page's own comments. */
  pageExternalId: string;
  /** `tenant_channels.comment_delivery_mode` — the comment switch, NOT the DM one (D-122). */
  commentMode: string;
  /** `tenant_channels.token_status`: live comments post only while it is `active`. */
  tokenStatus: string;
  graphVersion: string;
  locale: string;
  config: CommentChannelConfig;
  rawPayload: unknown;
};

export type CommentJobResult = {
  /** Public replies actually posted. */
  replied: number;
  /** Private messages actually sent to commenters (D-122). */
  privateSent: number;
  /** Private messages drafted and withheld because comments are in shadow. */
  privateDrafted: number;
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
    CommentRefusal | 'not_generating' | 'not_delivering' | 'send_failed' | 'indeterminate'
      | 'private_send_failed' | 'private_indeterminate',
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
  input: { tenantId: string; locale: string; kind?: string },
): Promise<{ ok: true; line: { body: string; reviewedAt: string | null } | null } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('canned_responses')
    .select('body, reviewed_at')
    .eq('tenant_id', input.tenantId)
    .eq('kind', input.kind ?? COMMENT_LINE_KIND)
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
async function recordCommentFlag(
  fx: CommentEffects,
  input: {
    tenantId: string; comment: InboundComment; flag: string;
    /** Numbers and ids a particular flag needs. Never the customer's words or name. */
    extra?: Record<string, number | string> | undefined;
  },
): Promise<void> {
  const { error } = await fx.db.from('quality_flags').insert({
    tenant_id: input.tenantId,
    flag: input.flag,
    detail: {
      comment_id: input.comment.commentId,
      post_id: input.comment.postId,
      // Shape, not content — see UNCLASSIFIED_FLAG. Characters, never bytes (rule 6).
      chars: cpLength(input.comment.text),
      has_cyrillic: HAS_CYRILLIC.test(input.comment.text),
      ...(input.extra ?? {}),
    },
    at: fx.now.toISOString(),
  });
  if (error) fx.log('warn', 'comment_flag_unrecorded', { flag: input.flag, detail: error.message });
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

/**
 * This comment's own row of one kind, when it is still waiting to be sent (D-122).
 *
 * `draft` or `failed`: decided and never delivered. Read only on the resume path, so it
 * costs nothing on an ordinary comment.
 */
async function readPending(
  db: SupabaseClient,
  input: { tenantId: string; kind: 'comment_reply' | 'private_reply'; dedupKey: string },
): Promise<{ ok: true; id: string | null } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('outbound_messages')
    .select('id, state')
    .eq('tenant_id', input.tenantId)
    .eq('kind', input.kind)
    .eq('dedup_key', input.dedupKey)
    .maybeSingle();
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const row = data as Record<string, unknown> | null;
  if (row === null) return { ok: true, id: null };
  const state = String(row['state'] ?? '');
  return { ok: true, id: state === 'draft' || state === 'failed' ? String(row['id']) : null };
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
 * Which (post, person) pairs already have a comment reply or a private reply (D-122).
 *
 * Counted over the same states as the per-post cap and for the same reason: a `failed` or
 * `refused` row proves nothing reached the person, and must not silence them for good;
 * `draft` and `indeterminate` may be (or become) visible, so they count. Unlike the cap
 * there is no time window — "one reply per person per post" has no expiry.
 */
async function answeredPersons(
  db: SupabaseClient,
  input: { tenantId: string; postIds: readonly string[]; fromIds: readonly string[] },
): Promise<{ ok: true; answered: Set<string> } | { ok: false; detail: string }> {
  if (input.postIds.length === 0 || input.fromIds.length === 0) return { ok: true, answered: new Set() };
  const { data, error } = await db
    .from('outbound_messages')
    .select('comment_post_id, comment_from_id')
    .eq('tenant_id', input.tenantId)
    .in('kind', ['comment_reply', 'private_reply'])
    .in('comment_post_id', [...input.postIds])
    .in('comment_from_id', [...input.fromIds])
    .in('state', ['draft', 'claiming', 'sending', 'sent', 'indeterminate']);
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const answered = new Set<string>();
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>;
    answered.add(personKey(String(r['comment_post_id']), String(r['comment_from_id'])));
  }
  return { ok: true, answered };
}

function personKey(postId: string, fromId: string): string {
  return `${postId}\u0000${fromId}`;
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
    // Only rows that ARE public or still might become public (D-085 review).
    //
    // There was no state filter, and with a cap of ONE that is not a rounding error: a
    // `failed` row proves a reply was NOT posted — `markFailed` writes it after the Graph
    // call was refused — and a `refused` row proves we decided not to. Either one silenced
    // the post for the next 24 hours, so a single transient Graph error cost the salon
    // every public answer on that post for a day, and the counter that hid it read as the
    // cap working.
    //
    // `draft` stays, and deliberately: it is what a shadow run writes, and it is the
    // die-mid-send direction this function's docstring defends — count one too many rather
    // than post one too many. `indeterminate` stays for the same reason, because it may
    // already be public.
    .in('state', ['draft', 'claiming', 'sending', 'sent', 'indeterminate'])
    .gte('created_at', input.since.toISOString());
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const counts = new Map<string, number>();
  for (const row of Array.isArray(data) ? data : []) {
    const id = String((row as Record<string, unknown>)['comment_post_id']);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { ok: true, counts };
}

/**
 * The Page's own comments on these posts, from the webhook events this platform already
 * stored (D-122 addendum, `comments/staff.ts`), and which of them are OUR replies.
 *
 * One read per post, filtered by jsonb containment on the stored entry, so the database
 * returns only entries carrying a comment by the Page on that post. Ordered by id so an
 * edit or a removal is applied after the comment it changes.
 *
 * What it cannot see, stated: a Page comment whose webhook never arrived (before the `feed`
 * subscription on 2026-09-20, or a delivery Meta dropped), and one whose `raw_payload` the
 * purge has already nulled (`tenants.retention_days_raw_events`, 30 for Matrix). Both read
 * as "nobody answered". A Graph read of the thread would see them and is not made: the
 * decision follows the comment by seconds and a staff reply's webhook arrives within seconds
 * of it (measured: 6 s), and a fail-closed Graph gate on the live send that cannot be
 * exercised from where it is written would be a gate nobody has seen work (D-122 addendum).
 */
async function readStaffActivity(
  db: SupabaseClient,
  input: { tenantId: string; pageId: string; postIds: readonly string[] },
): Promise<{ ok: true; pageComments: PageComment[]; ours: Set<string> } | { ok: false; detail: string }> {
  if (input.postIds.length === 0) return { ok: true, pageComments: [], ours: new Set() };
  const entries: unknown[] = [];
  for (const postId of input.postIds) {
    const { data, error } = await db
      .from('webhook_events')
      .select('raw_payload')
      .eq('tenant_id', input.tenantId)
      .not('raw_payload', 'is', null)
      .contains('raw_payload', { changes: [{ value: { item: 'comment', post_id: postId, from: { id: input.pageId } } }] })
      .order('id', { ascending: true });
    if (error) return { ok: false, detail: `webhook_events unreadable: ${error.message}` };
    for (const row of Array.isArray(data) ? data : []) entries.push((row as Record<string, unknown>)['raw_payload']);
  }
  const pageComments = pageCommentsIn(entries, input.pageId);
  if (pageComments.length === 0) return { ok: true, pageComments, ours: new Set() };
  const { data, error } = await db
    .from('outbound_messages')
    .select('provider_message_id')
    .eq('tenant_id', input.tenantId)
    .eq('kind', 'comment_reply')
    .in('provider_message_id', pageComments.map((c) => c.commentId));
  if (error) return { ok: false, detail: `outbound_messages unreadable: ${error.message}` };
  const ours = new Set((Array.isArray(data) ? data : []).map((r) => String((r as Record<string, unknown>)['provider_message_id'])));
  return { ok: true, pageComments, ours };
}

/** The flag payload for a staff refusal: which proof, never whose name. */
function staffFlagExtra(staff: StaffCheck, at: 'decision' | 'before_send'): Record<string, string> {
  if (staff.handled === true) return { how: staff.how, staff_comment_id: staff.staffCommentId, at };
  return { how: 'unknown', at };
}

function staffRefusal(staff: StaffCheck): CommentRefusal | null {
  if (staff.handled === false) return null;
  if (staff.handled === null) return 'staff_check_unknown';
  return staff.how === 'replied' ? 'staff_replied' : 'staff_tagged_commenter';
}

/**
 * The staff check again, IMMEDIATELY before a live send (D-122 addendum).
 *
 * The decision was made when the comment arrived, and staff answer by hand. Anything the
 * Page wrote since is in `webhook_events` by now, so the read is repeated for this comment's
 * post, after the row is claimed and before the Graph call. Memoised per comment: the public
 * line and the private message are held to one reading, and a refusal writes one flag.
 *
 * Measured, so nobody overestimates it: the Page's 29 replies on record came 47 s to 7.5 h
 * after the comment they answer, and a live send follows its decision by about a second. So
 * this catches a staff reply inside that second, and — the case that matters — a draft sent
 * LATER by `resumePending`, which was decided before the staff answered. Catching the
 * 47-second reply needs a hold before sending, which is a separate decision.
 */
type StaffGate = 'clear' | 'handled' | 'unreadable';

function staffGateFor(
  fx: CommentEffects, input: CommentJobInput, comment: InboundComment, result: CommentJobResult,
): () => Promise<StaffGate> {
  let memo: Promise<StaffGate> | null = null;
  return () => {
    memo ??= (async (): Promise<StaffGate> => {
      const activity = await readStaffActivity(fx.db, {
        tenantId: input.tenantId, pageId: input.pageExternalId, postIds: [comment.postId],
      });
      if (!activity.ok) {
        fx.log('error', 'comment_staff_unreadable_before_send', { commentId: comment.commentId, detail: activity.detail });
        return 'unreadable';
      }
      const staff = staffHandled({ comment, pageComments: activity.pageComments, ours: activity.ours });
      const refusal = staffRefusal(staff);
      if (refusal === null) return 'clear';
      count(result.refused, refusal);
      fx.log('info', 'comment_staff_answered', { commentId: comment.commentId, refusal, at: 'before_send' });
      await recordCommentFlag(fx, { tenantId: input.tenantId, comment, flag: STAFF_FLAG, extra: staffFlagExtra(staff, 'before_send') });
      return 'handled';
    })();
    return memo;
  };
}

/**
 * Apply the gate to a row this worker holds. `send` goes ahead; `refused` parks the row
 * where no claim can reach it (`refused` is not claimable, and it is not counted by the
 * person rule or the cap, so the next comment is decided afresh); `retry` hands the row
 * back as `failed` and asks for a 503, because an unread check is not a clear one.
 */
async function holdForStaff(
  fx: CommentEffects, input: CommentJobInput, held: { id: string; attempts: number },
  result: CommentJobResult, gate: () => Promise<StaffGate>,
): Promise<'send' | 'refused' | 'retry'> {
  const g = await gate();
  if (g === 'clear') return 'send';
  if (g === 'handled') {
    await markRefused(fx.db, { id: held.id, tenantId: input.tenantId, reason: 'staff answered this commenter from the Page before the send' });
    return 'refused';
  }
  await markFailed(fx.db, { id: held.id, tenantId: input.tenantId, attempts: held.attempts, reason: 'staff check unreadable before the send' });
  result.retry = true;
  return 'retry';
}

/** The cap's window. A rolling 24 hours: see 0009 for why not a calendar day. */
export const POST_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

function count(into: CommentJobResult['refused'], key: keyof CommentJobResult['refused']): void {
  into[key] = (into[key] ?? 0) + 1;
}

export async function runCommentJob(fx: CommentEffects, input: CommentJobInput): Promise<CommentJobResult> {
  const result: CommentJobResult = {
    replied: 0, privateSent: 0, drafted: 0, privateDrafted: 0, refused: {}, skipped: [], retry: false,
  };

  const { comments, skipped } = extractComments(input.rawPayload, input.pageExternalId);
  result.skipped = skipped;
  if (comments.length === 0) return result;

  // The COMMENT switch, not the DM one (D-122). `shadow` generates and withholds, exactly
  // as the DM mirror does, so what the drafts show is what going live would have done;
  // `live` posts only while the token is `active`.
  const delivery = canDeliverComments(input.commentMode, input.tokenStatus);
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
  const privateLine = await readPinnedLine(fx.db, { tenantId: input.tenantId, locale: input.locale, kind: PRIVATE_LINE_KIND });
  if (!privateLine.ok) {
    fx.log('error', 'comment_private_line_unreadable', { tenantId: input.tenantId, detail: privateLine.detail });
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

  const persons = await answeredPersons(fx.db, {
    tenantId: input.tenantId,
    postIds: [...new Set(comments.map((c) => c.postId))],
    fromIds: [...new Set(comments.map((c) => c.fromId))],
  });
  if (!persons.ok) {
    fx.log('error', 'comment_persons_unreadable', { tenantId: input.tenantId, detail: persons.detail });
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

  // What the salon's staff already wrote from the Page on these posts (D-122 addendum).
  // One query per post, read with the thread and person reads because the decision below
  // needs it in the same breath.
  const staffActivity = await readStaffActivity(fx.db, {
    tenantId: input.tenantId,
    pageId: input.pageExternalId,
    postIds: [...new Set(comments.map((c) => c.postId))],
  });
  if (!staffActivity.ok) {
    fx.log('error', 'comment_staff_unreadable', { tenantId: input.tenantId, detail: staffActivity.detail });
    result.retry = true;
    return result;
  }

  // Threads, people and posts answered within THIS entry, so two comments arriving together
  // still produce one reply. The database would catch the thread and the private reply a
  // moment later (unique keys); catching them here means the second never becomes a row.
  const answeredNow = new Set(answered.answered);
  const personsNow = new Set(persons.answered);
  const postCounts = new Map(perPost.counts);

  for (const comment of comments) {
    // A comment carries no attachment kinds on this surface: `extractComments` returns a
    // sticker or bare-photo comment with empty text, so there is nothing for a
    // `has_attachment` rule to read. Passed explicitly as empty rather than defaulted, for
    // D-083's reason — a default asserts "no attachment" on behalf of a caller who forgot.
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
    const staff = staffHandled({ comment, pageComments: staffActivity.pageComments, ours: staffActivity.ours });
    const decision = decideCommentReply({
      config: input.config,
      verdict: classified.verdict,
      pinnedLine: line.line,
      privateLine: privateLine.line,
      comment: {
        commentId: comment.commentId,
        threadId: comment.threadId,
        postId: comment.postId,
        fromId: comment.fromId,
        createdAt: comment.createdAt,
        parentIsOurs: parents.ours.has(comment.threadId),
      },
      threadAlreadyAnswered: answeredNow.has(comment.threadId),
      personAlreadyAnswered: personsNow.has(personKey(comment.postId, comment.fromId)),
      staff,
      postRepliesInWindow: postCounts.get(comment.postId) ?? 0,
      now: fx.now,
    });

    if (!decision.reply) {
      // Every refusal is counted rather than logged one line each: on a viral post the
      // log would be the volume problem, and a counter is what an operator reads anyway.
      count(result.refused, decision.refusal);

      // Three of them also get a durable row. Written from HERE rather than beside the
      // classifier (D-085 review): `decideCommentReply` refuses on policy, self-reply, the
      // ignore list and age BEFORE it ever looks at the verdict, so writing at the
      // classifier put a row on the operator's to-do list for a staff member's own comment
      // and for spam under an ancient post — work nobody should be handed.
      const byStaff = staffRefusal(staff) === decision.refusal;
      const flag = decision.refusal === 'comment_unclassified' ? UNCLASSIFIED_FLAG
        : decision.refusal === 'comment_escalated' ? ESCALATED_FLAG
        : decision.refusal === 'post_cap_reached' ? CAPPED_FLAG
        : byStaff ? STAFF_FLAG
        : null;
      if (flag !== null) {
        await recordCommentFlag(fx, {
          tenantId: input.tenantId,
          comment,
          flag,
          extra: flag === CAPPED_FLAG
            ? { replies_in_window: postCounts.get(comment.postId) ?? 0, cap: input.config.repliesPerPostPerDay }
            : byStaff ? staffFlagExtra(staff, 'decision')
            : undefined,
        });
      }
      if (byStaff) fx.log('info', 'comment_staff_answered', { commentId: comment.commentId, refusal: decision.refusal, at: 'decision' });
      // A complaint on the wall is the one comment a person must see TODAY (D-122). The
      // row above is the record; this is the tap on the shoulder, with the link. Raised in
      // shadow too: nothing is posted either way, and a complaint is no less real because
      // the bot is rehearsing.
      // FINISH WHAT WAS STARTED (D-122). A thread or a person counts as answered from the
      // moment its rows are DRAFTED, which is the over-count direction every rule here fails
      // in. The cost is the retry: the public line went out, the private message hit a 613,
      // the job 503'd — and on the redelivery the person reads as answered, so without this
      // the private message is never sent. "A row exists" was read as "the work was done",
      // which is D-029's sentence. On a delivering channel, a refusal for being already
      // answered therefore looks for this thread's and this person's rows still waiting
      // (`draft` or `failed`) and sends them; a row already sent is left alone, and the
      // claim's CAS keeps a second worker from sending the same row twice.
      if (delivery.deliver
          && (decision.refusal === 'thread_already_answered' || decision.refusal === 'person_already_answered')) {
        const resumed = await resumePending(fx, input, comment, result);
        if (resumed === 'retry') return result;
      }
      if (decision.refusal === 'comment_escalated') {
        try {
          await fx.alertComplaint({
            tenantId: input.tenantId,
            commentId: comment.commentId,
            text: comment.text,
            link: commentLink(comment),
          });
        } catch (e) {
          fx.log('error', 'comment_complaint_alert_failed', {
            commentId: comment.commentId, detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
      continue;
    }

    // --- The two facts the webhook does not carry: tags and the post's age (D-122). ---
    //
    // Read only now, for a comment already worth answering, so praise costs no request.
    const lookup = await safeLookup(fx, input, comment);
    if (lookup.problems.length > 0) {
      fx.log('warn', 'comment_lookup_incomplete', { commentId: comment.commentId, problems: lookup.problems });
    }
    const confirmed = decideAfterLookup({
      tagsPerson: lookup.tagsPerson,
      postCreatedAt: lookup.postCreatedAt,
      maxPostAgeDays: input.config.maxPostAgeDays,
      now: fx.now,
    });
    if (!confirmed.ok) {
      count(result.refused, confirmed.refusal);
      fx.log('info', 'comment_refused_after_lookup', { commentId: comment.commentId, refusal: confirmed.refusal, detail: confirmed.detail });
      continue;
    }

    // --- Draft BOTH rows before sending either. -----------------------------------------
    //
    // Written down first, so a shadow run exercises every counting rule and a worker that
    // dies mid-send leaves rows that count against the post and the person — the
    // over-count direction every rule here is built to fail in.
    const publicDraft = decision.publicBody === null ? null : await draftOnce(fx.db, {
      tenantId: input.tenantId,
      kind: 'comment_reply',
      // The thread, not the comment. Three comments in one thread share one key.
      dedupKey: decision.threadId,
      body: decision.publicBody,
      channelId: input.channelId,
      commentPostId: decision.postId,
      commentFromId: decision.fromId,
    });
    if (publicDraft !== null && !publicDraft.ok) {
      fx.log('error', 'comment_draft_failed', { detail: publicDraft.detail });
      result.retry = true;
      return result;
    }
    const privateDraft = decision.privateBody === null ? null : await draftOnce(fx.db, {
      tenantId: input.tenantId,
      kind: 'private_reply',
      dedupKey: privateReplyDedupKey(decision.postId, decision.fromId),
      body: decision.privateBody,
      channelId: input.channelId,
      commentPostId: decision.postId,
      commentFromId: decision.fromId,
    });
    if (privateDraft !== null && !privateDraft.ok) {
      fx.log('error', 'comment_private_draft_failed', { detail: privateDraft.detail });
      result.retry = true;
      return result;
    }
    answeredNow.add(decision.threadId);
    personsNow.add(personKey(decision.postId, decision.fromId));
    if (publicDraft?.ok === true && publicDraft.created) {
      postCounts.set(decision.postId, (postCounts.get(decision.postId) ?? 0) + 1);
    }

    // Decided and written down, and deliberately not posted. The rows stay `draft`, so the
    // day the switch goes live they are claimable rather than lost — the same disposition
    // `worker/reception.ts` gives a withheld DM.
    if (!delivery.deliver) {
      fx.log('info', 'comments_not_delivering', {
        tenantId: input.tenantId, threadId: decision.threadId, detail: delivery.detail,
      });
      count(result.refused, 'not_delivering');
      if (publicDraft !== null) result.drafted += 1;
      if (privateDraft !== null) result.privateDrafted += 1;
      continue;
    }

    // --- The public line. ----------------------------------------------------------------
    //
    // Straight to the claim whether or not WE wrote the row: `claim`'s CAS distinguishes
    // sent, leased, failed and draft, and refusing before it would turn every retry of a
    // `failed` row into a redelivery that did nothing.
    const gate = staffGateFor(fx, input, comment, result);
    if (publicDraft !== null && publicDraft.ok) {
      const outcome = await sendPublic(fx, input, comment.commentId, publicDraft.row.id, result, gate);
      if (outcome === 'retry') return result;
    }

    // --- The private message, at the same time. -----------------------------------------
    //
    // Independent of the public line's outcome: a public reply Meta refused is no reason
    // to withhold the private one, and vice versa. Each row has its own claim and its own
    // at-most-once guarantee.
    if (privateDraft !== null && privateDraft.ok) {
      const outcome = await sendPrivate(fx, input, comment.commentId, privateDraft.row.id, result, gate);
      if (outcome === 'retry') return result;
    }
  }

  return result;
}

/**
 * The Graph read, with a throw turned into two unknowns. The effect is written not to throw;
 * this is what makes that a property of the job rather than of one binding, because a throw
 * here would 500 the whole entry and re-run every comment in it.
 */
async function safeLookup(fx: CommentEffects, input: CommentJobInput, comment: InboundComment): Promise<CommentLookup> {
  try {
    return await fx.lookupComment({
      tenantId: input.tenantId, channelId: input.channelId, pageId: input.pageExternalId,
      commentId: comment.commentId, postId: comment.postId, graphVersion: input.graphVersion,
    });
  } catch (e) {
    return { tagsPerson: null, postCreatedAt: null, problems: [`lookup threw: ${e instanceof Error ? e.name : 'unknown'}`] };
  }
}

/**
 * Send this comment's rows that were decided and never delivered. See the call site.
 *
 * The tag and post-age read runs again first: the comment in hand may be a different one in
 * the same thread, and a reply under it must pass the same checks a fresh one would.
 */
async function resumePending(
  fx: CommentEffects, input: CommentJobInput, comment: InboundComment, result: CommentJobResult,
): Promise<'done' | 'retry'> {
  const wantsPrivate = input.config.policy === 'both' || input.config.policy === 'private_only';
  const wantsPublic = input.config.policy === 'both' || input.config.policy === 'public_only';
  const pub = wantsPublic
    ? await readPending(fx.db, { tenantId: input.tenantId, kind: 'comment_reply', dedupKey: comment.threadId })
    : { ok: true as const, id: null };
  const priv = wantsPrivate
    ? await readPending(fx.db, { tenantId: input.tenantId, kind: 'private_reply', dedupKey: privateReplyDedupKey(comment.postId, comment.fromId) })
    : { ok: true as const, id: null };
  if (!pub.ok || !priv.ok) {
    fx.log('error', 'comment_pending_unreadable', { commentId: comment.commentId, detail: !pub.ok ? pub.detail : (priv as { detail: string }).detail });
    result.retry = true;
    return 'retry';
  }
  if (pub.id === null && priv.id === null) return 'done';

  const lookup = await safeLookup(fx, input, comment);
  const confirmed = decideAfterLookup({
    tagsPerson: lookup.tagsPerson, postCreatedAt: lookup.postCreatedAt,
    maxPostAgeDays: input.config.maxPostAgeDays, now: fx.now,
  });
  if (!confirmed.ok) {
    count(result.refused, confirmed.refusal);
    return 'done';
  }
  fx.log('info', 'comment_resuming', { commentId: comment.commentId, public: pub.id !== null, private: priv.id !== null });
  // A resumed row was decided earlier, possibly before the staff answered, so this is where
  // the check before sending matters most.
  const gate = staffGateFor(fx, input, comment, result);
  if (pub.id !== null && (await sendPublic(fx, input, comment.commentId, pub.id, result, gate)) === 'retry') return 'retry';
  if (priv.id !== null && (await sendPrivate(fx, input, comment.commentId, priv.id, result, gate)) === 'retry') return 'retry';
  return 'done';
}

/** Claim and post one public reply. 'retry' means the job must 503; the caller returns. */
async function sendPublic(
  fx: CommentEffects, input: CommentJobInput, commentId: string, rowId: string, result: CommentJobResult,
  gate: () => Promise<StaffGate>,
): Promise<'done' | 'retry'> {
  const held = await claim(fx.db, { id: rowId, tenantId: input.tenantId, now: fx.now });
  if (held.outcome === 'unavailable') {
    fx.log('error', 'comment_claim_unavailable', { detail: held.detail });
    result.retry = true;
    return 'retry';
  }
  if (held.outcome !== 'claimed') {
    // Already sent, or another worker holds a live lease. Neither is an error.
    count(result.refused, 'thread_already_answered');
    return 'done';
  }
  // Held, and not yet posted: the last moment the staff check can still stop it.
  const hold = await holdForStaff(fx, input, held, result, gate);
  if (hold !== 'send') return hold === 'retry' ? 'retry' : 'done';
  const sent = await fx.replyToComment({
    tenantId: input.tenantId,
    channelId: input.channelId,
    commentId,
    // The STORED body, as everywhere else: a redelivery re-posts what was written.
    body: held.body,
    graphVersion: input.graphVersion,
  });
  if (sent.outcome === 'sent') {
    await markSent(fx.db, {
      id: held.id, tenantId: input.tenantId, providerMessageId: sent.providerCommentId,
      unitCost: MESSENGER_SEND_UNIT_COST, now: fx.now,
    });
    result.replied += 1;
    return 'done';
  }
  if (sent.outcome === 'indeterminate') {
    // It may already be public. Re-posting would put two identical replies under one
    // customer's comment, so this is parked outside CLAIMABLE for a person to look at.
    await markIndeterminate(fx.db, { id: held.id, tenantId: input.tenantId, reason: sent.detail });
    fx.log('warn', 'comment_reply_indeterminate', { commentId, detail: sent.detail });
    count(result.refused, 'indeterminate');
    return 'done';
  }
  await markFailed(fx.db, { id: held.id, tenantId: input.tenantId, attempts: held.attempts, reason: sent.detail });
  count(result.refused, 'send_failed');
  if (sent.retryable) {
    fx.log('warn', 'comment_reply_retryable', { commentId, failure: sent.failure });
    result.retry = true;
    return 'retry';
  }
  fx.log('error', 'comment_reply_terminal', { commentId, failure: sent.failure, detail: sent.detail });
  return 'done';
}

/** Claim and send one private reply. Same shape as `sendPublic`, on the Messenger send. */
async function sendPrivate(
  fx: CommentEffects, input: CommentJobInput, commentId: string, rowId: string, result: CommentJobResult,
  gate: () => Promise<StaffGate>,
): Promise<'done' | 'retry'> {
  const held = await claim(fx.db, { id: rowId, tenantId: input.tenantId, now: fx.now });
  if (held.outcome === 'unavailable') {
    fx.log('error', 'comment_private_claim_unavailable', { detail: held.detail });
    result.retry = true;
    return 'retry';
  }
  if (held.outcome !== 'claimed') return 'done';
  const hold = await holdForStaff(fx, input, held, result, gate);
  if (hold !== 'send') return hold === 'retry' ? 'retry' : 'done';
  const sent = await fx.sendPrivateReply({
    tenantId: input.tenantId,
    channelId: input.channelId,
    pageId: input.pageExternalId,
    commentId,
    body: held.body,
    graphVersion: input.graphVersion,
  });
  if (sent.outcome === 'sent') {
    await markSent(fx.db, {
      id: held.id, tenantId: input.tenantId, providerMessageId: sent.providerMessageId,
      unitCost: MESSENGER_SEND_UNIT_COST, now: fx.now,
    });
    result.privateSent += 1;
    return 'done';
  }
  if (sent.outcome === 'indeterminate') {
    // Meta allows one private reply per comment, so a re-send would at best be refused and
    // at worst be a second message; parked, never retried.
    await markIndeterminate(fx.db, { id: held.id, tenantId: input.tenantId, reason: sent.detail });
    fx.log('warn', 'comment_private_indeterminate', { commentId, detail: sent.detail });
    count(result.refused, 'private_indeterminate');
    return 'done';
  }
  await markFailed(fx.db, { id: held.id, tenantId: input.tenantId, attempts: held.attempts, reason: sent.detail });
  count(result.refused, 'private_send_failed');
  if (sent.retryable) {
    fx.log('warn', 'comment_private_retryable', { commentId, failure: sent.failure });
    result.retry = true;
    return 'retry';
  }
  fx.log('error', 'comment_private_terminal', { commentId, failure: sent.failure, detail: sent.detail });
  return 'done';
}

export type { InboundComment };
