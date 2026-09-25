import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAfterLookup, decideCommentReply, type CommentDecisionInput } from './eligibility.ts';

const NOW = new Date('2026-09-04T12:00:00Z');
const LINE = { body: 'Сайн байна уу! Дэлгэрэнгүйг хувийн мессежээр хүргэе.', reviewedAt: '2026-09-01T00:00:00Z' };

const base: CommentDecisionInput = {
  config: { policy: 'public_only', maxPostAgeDays: 30, ignoreCommenterIds: [], repliesPerPostPerDay: 1 },
  // The existing cases were all written before the classifier and all describe a comment
  // worth answering, so `reply` is the base. The verdict's own four cases are below.
  verdict: 'reply',
  pinnedLine: LINE,
  privateLine: { body: 'Сайн байна уу! Хүссэн зүйлээ асуугаарай.', reviewedAt: '2026-09-25T00:00:00Z' },
  comment: {
    commentId: 'c_1',
    threadId: 'c_1',
    postId: 'p_1',
    fromId: 'customer_1',
    createdAt: new Date('2026-09-04T11:50:00Z'),
    parentIsOurs: false,
  },
  threadAlreadyAnswered: false,
  personAlreadyAnswered: false,
  staff: { handled: false },
  postRepliesInWindow: 0,
  now: NOW,
};

const decide = (over: Partial<CommentDecisionInput> = {}) => decideCommentReply({ ...base, ...over });
const withComment = (over: Partial<CommentDecisionInput['comment']>) =>
  decide({ comment: { ...base.comment, ...over } });
const withConfig = (over: Partial<CommentDecisionInput['config']>) =>
  decide({ config: { ...base.config, ...over } });

// ---------------------------------------------------------------------------
// The safety property the whole feature rests on
// ---------------------------------------------------------------------------

test('DONE-TEST: the reply cannot depend on what the comment said', () => {
  // "Never answer prices, availability, or treatment questions in a comment regardless of
  // what is asked" is not a rule this code follows — it is a sentence that cannot be
  // expressed in `decideCommentReply`'s inputs. The comment's TEXT is not a parameter.
  //
  // This asserts the consequence: the decision is byte-identical for a price question, a
  // pregnancy-safety question, an injection attempt and a compliment, because none of them
  // can reach it.
  const outcomes = ['c_1', 'c_2', 'c_3', 'c_4'].map((commentId) =>
    withComment({ commentId, threadId: commentId }),
  );
  for (const o of outcomes) {
    assert.equal(o.reply, true);
    assert.equal(o.reply === true && o.publicBody, LINE.body, 'the tenant line, unchanged');
  }
  // And the signature itself carries no text field. If somebody adds one, this fails.
  assert.ok(!('text' in base.comment), 'the comment TEXT must never become an input here');
});

test('the pinned line is returned unchanged — never trimmed, wrapped or decorated', () => {
  const odd = { body: '  Сайн байна уу!  ', reviewedAt: '2026-09-01' };
  const r = decide({ pinnedLine: odd });
  assert.equal(r.reply === true && r.publicBody, '  Сайн байна уу!  ');
});

// ---------------------------------------------------------------------------
// Per-tenant configuration
// ---------------------------------------------------------------------------

test('comments are OFF unless the tenant turned them on', () => {
  const r = withConfig({ policy: 'none' });
  assert.equal(r.reply, false);
  assert.equal(r.reply === false && r.refusal, 'comment_policy_off');
});

test('D-122: the policy decides which lines go — public, private, or both', () => {
  const pub = withConfig({ policy: 'public_only' });
  assert.ok(pub.reply === true && pub.publicBody === LINE.body && pub.privateBody === null);
  const priv = withConfig({ policy: 'private_only' });
  assert.ok(priv.reply === true && priv.publicBody === null && priv.privateBody === base.privateLine?.body);
  const both = withConfig({ policy: 'both' });
  assert.ok(both.reply === true && both.publicBody === LINE.body && both.privateBody === base.privateLine?.body);
});

test('D-122: "both" with either line unreviewed sends neither — half a policy is a different policy', () => {
  const noPrivate = decide({ config: { ...base.config, policy: 'both' }, privateLine: { body: 'x', reviewedAt: null } });
  assert.equal(noPrivate.reply === false && noPrivate.refusal, 'no_reviewed_line');
  const noPublic = decide({ config: { ...base.config, policy: 'both' }, pinnedLine: null });
  assert.equal(noPublic.reply === false && noPublic.refusal, 'no_reviewed_line');
  // public_only does not need the private line at all.
  assert.equal(decide({ privateLine: null }).reply, true);
});

test('D-122: one reply per person per post', () => {
  const r = decide({ personAlreadyAnswered: true });
  assert.equal(r.reply === false && r.refusal, 'person_already_answered');
  // Named before the thread rule: the same person on the same post is the more specific truth.
  const both = decide({ personAlreadyAnswered: true, threadAlreadyAnswered: true });
  assert.equal(both.reply === false && both.refusal, 'person_already_answered');
  // And the verdict still comes first: a second complaint by the same person is escalated.
  const complaint = decide({ personAlreadyAnswered: true, verdict: 'escalate' });
  assert.equal(complaint.reply === false && complaint.refusal, 'comment_escalated');
});

test('D-122: after the Graph read — a tag of a person refuses; unknown refuses; an old post refuses', () => {
  const now = new Date('2026-09-25T00:00:00Z');
  const young = new Date('2026-09-20T00:00:00Z');
  assert.deepEqual(decideAfterLookup({ tagsPerson: false, postCreatedAt: young, maxPostAgeDays: 30, now }), { ok: true });
  const tagged = decideAfterLookup({ tagsPerson: true, postCreatedAt: young, maxPostAgeDays: 30, now });
  assert.equal(!tagged.ok && tagged.refusal, 'comment_tags_person');
  for (const [tagsPerson, postCreatedAt] of [[null, young], [false, null], [false, new Date(NaN)]] as const) {
    const r = decideAfterLookup({ tagsPerson, postCreatedAt, maxPostAgeDays: 30, now });
    assert.equal(!r.ok && r.refusal, 'comment_lookup_unknown');
  }
  const old = decideAfterLookup({ tagsPerson: false, postCreatedAt: new Date('2022-01-01T00:00:00Z'), maxPostAgeDays: 30, now });
  assert.equal(!old.ok && old.refusal, 'post_too_old');
  // The boundary: exactly the limit is still young.
  const edge = decideAfterLookup({ tagsPerson: false, postCreatedAt: new Date(now.getTime() - 30 * 86_400_000), maxPostAgeDays: 30, now });
  assert.equal(edge.ok, true);
});

test('an unrecognised policy does not reply', () => {
  // A value added to the constraint later is non-replying until somebody decides
  // otherwise — the same positive-allow-list posture as `channel/delivery.ts`.
  for (const policy of ['', 'PUBLIC_ONLY', 'public', 'on']) {
    assert.equal(decide({ config: { ...base.config, policy } }).reply, false, JSON.stringify(policy));
  }
});

test("a staff member's personal account is skipped, per channel config", () => {
  const r = decide({
    config: { ...base.config, ignoreCommenterIds: ['stylist_personal', 'owner_personal'] },
    comment: { ...base.comment, fromId: 'stylist_personal' },
  });
  assert.equal(r.reply === false && r.refusal, 'commenter_ignored');
  // And a customer with a similar id is not caught by it.
  assert.equal(withConfig({ ignoreCommenterIds: ['stylist_personal'] }).reply, true);
});

// ---------------------------------------------------------------------------
// Loop prevention
// ---------------------------------------------------------------------------

test('DONE-TEST: a reply to our own comment is never answered', () => {
  // Without this the salon appears to be talking to itself, publicly, under its own post,
  // permanently, in front of its customers.
  const r = withComment({ parentIsOurs: true });
  assert.equal(r.reply === false && r.refusal, 'reply_to_self');
});

test('DONE-TEST: three comments in one thread get ONE reply', () => {
  const first = withComment({ commentId: 'c_1', threadId: 't_1' });
  assert.equal(first.reply, true);
  for (const commentId of ['c_2', 'c_3']) {
    const later = decide({
      comment: { ...base.comment, commentId, threadId: 't_1' },
      threadAlreadyAnswered: true,
    });
    assert.equal(later.reply === false && later.refusal, 'thread_already_answered', commentId);
  }
});

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

test('a COMMENT older than the tenant window is not answered', () => {
  // Renamed with the refusal (D-085). The old name said "a comment on a post older than
  // the tenant window" while constructing an old COMMENT — the test, the code, the config
  // name and the docstring all agreed with each other and all four were wrong about which
  // age was being measured.
  const old = withComment({ createdAt: new Date('2026-07-01T00:00:00Z') });
  assert.equal(old.reply === false && old.refusal, 'comment_too_old');
  assert.match(old.reply === false ? old.detail : '', /limit is 30/);

  // The window is per channel: a tenant who wants a year gets a year.
  const generous = decide({
    config: { ...base.config, maxPostAgeDays: 365 },
    comment: { ...base.comment, createdAt: new Date('2026-07-01T00:00:00Z') },
  });
  assert.equal(generous.reply, true);
});

test('an undated comment is refused — unknown age is not young', () => {
  const r = withComment({ createdAt: new Date(Number.NaN) });
  assert.equal(r.reply === false && r.refusal, 'comment_age_unknown');
});

test('a comment from the near future is answered, not dropped on clock skew', () => {
  const r = withComment({ createdAt: new Date(NOW.getTime() + 5_000) });
  assert.equal(r.reply, true);
});

// ---------------------------------------------------------------------------
// The line itself
// ---------------------------------------------------------------------------

test('DONE-TEST: no reviewed line means SILENCE, never a platform default', () => {
  // A sentence Dalatech wrote, posted under a salon's post in the salon's voice, is
  // generated prose in public one step removed. There is no fallback and there must not be.
  for (const line of [null, { body: 'Сайн байна уу!', reviewedAt: null }, { body: '   ', reviewedAt: '2026-09-01' }]) {
    const r = decide({ pinnedLine: line });
    assert.equal(r.reply, false, JSON.stringify(line));
    assert.equal(r.reply === false && r.refusal, 'no_reviewed_line');
  }
});

// ---------------------------------------------------------------------------
// Attribution order
// ---------------------------------------------------------------------------

test('a tenant with comments off is attributed to that, not to a later check', () => {
  // A counter that said "we declined because the post was old" for a tenant who never
  // opted in would be a lie in an operator's dashboard.
  const r = decide({
    config: { policy: 'none', maxPostAgeDays: 30, ignoreCommenterIds: ['customer_1'], repliesPerPostPerDay: 1 },
    comment: { ...base.comment, createdAt: new Date('2020-01-01'), parentIsOurs: true },
    threadAlreadyAnswered: true,
    postRepliesInWindow: 99,
    pinnedLine: null,
  });
  assert.equal(r.reply === false && r.refusal, 'comment_policy_off');
});

test('every refusal carries a detail a person could act on', () => {
  const inputs: Partial<CommentDecisionInput>[] = [
    { config: { ...base.config, policy: 'none' } },
    { personAlreadyAnswered: true },
    { config: { ...base.config, ignoreCommenterIds: ['customer_1'] } },
    { comment: { ...base.comment, parentIsOurs: true } },
    { comment: { ...base.comment, createdAt: new Date('2020-01-01') } },
    { comment: { ...base.comment, createdAt: new Date(Number.NaN) } },
    { threadAlreadyAnswered: true },
    { pinnedLine: null },
  ];
  const seen = new Set<string>();
  for (const over of inputs) {
    const r = decide(over);
    assert.equal(r.reply, false);
    if (r.reply === false) {
      assert.ok(r.detail.length > 10, r.refusal);
      seen.add(r.refusal);
    }
  }
  assert.equal(seen.size, inputs.length, 'every refusal reason is reachable and distinct');
});

// ---------------------------------------------------------------------------
// The per-post daily cap (§3.8.2 rule 4; the founder's number is 1)
// ---------------------------------------------------------------------------

test('DONE-TEST: a post that already had its reply today gets no second one, in ANY thread', () => {
  // The case the per-thread rule cannot catch and the whole reason this cap exists: five
  // people commenting separately on one post are five threads. The reply is the same
  // sentence every time, so five of them under one post is spam on the tenant's own wall.
  const r = decide({ postRepliesInWindow: 1, comment: { ...base.comment, commentId: 'c_9', threadId: 'c_9' } });
  assert.equal(r.reply, false);
  assert.equal(r.reply === false && r.refusal, 'post_cap_reached');
});

test('the cap is the tenant\'s number, not a constant', () => {
  for (const [cap, already, expected] of [
    [1, 0, true], [1, 1, false],
    [3, 2, true], [3, 3, false],
    [10, 9, true], [10, 10, false],
  ] as [number, number, boolean][]) {
    const r = decide({ config: { ...base.config, repliesPerPostPerDay: cap }, postRepliesInWindow: already });
    assert.equal(r.reply, expected, `cap ${cap}, already ${already}`);
  }
});

test('DONE-TEST: the per-thread rule stays the inner guard and keeps its own attribution', () => {
  // Both rules refuse this comment. `thread_already_answered` is the more specific truth
  // and is what an operator should see; `post_cap_reached` is reserved for what the thread
  // rule does not catch. Swapping the two checks makes this fail.
  const r = decide({ threadAlreadyAnswered: true, postRepliesInWindow: 5 });
  assert.equal(r.reply === false && r.refusal, 'thread_already_answered');
});

test('the cap is checked before the pinned line, so a capped post is never attributed to missing text', () => {
  const r = decide({ postRepliesInWindow: 1, pinnedLine: null });
  assert.equal(r.reply === false && r.refusal, 'post_cap_reached');
});

test('the decision carries the post id, so the count can be written with the draft', () => {
  const r = decide();
  assert.equal(r.reply === true && r.postId, 'p_1');
  assert.equal(r.reply === true && r.threadId, 'c_1', 'and the thread, which is the dedup key');
});

test('DONE-TEST: the POST\u2019s age is NOT checked, and this is the case that proves it', () => {
  // §3.8.2 rule 5 exists because *old posts attract spam and the tenant gets no value*.
  // A brand-new comment on a four-year-old post is exactly that case, and it passes every
  // check — because the only date the `feed` payload carries is the COMMENT's.
  //
  // Asserted rather than left as a docstring so the gap is a red test the day somebody
  // adds the Graph read that closes it, instead of a paragraph nobody re-reads.
  const freshCommentOnAncientPost = withComment({
    createdAt: new Date(NOW.getTime() - 60_000),   // one minute old
    postId: 'p_from_2022',
  });
  assert.equal(freshCommentOnAncientPost.reply, true,
    'the post-age rule is not implemented; closing it needs GET /{post-id}?fields=created_time');
});

// ---------------------------------------------------------------------------
// Staff already answered (D-122 addendum)
// ---------------------------------------------------------------------------

test('D-122 addendum: the Page replied under the comment — refused, with its own reason', () => {
  const r = decide({ staff: { handled: true, how: 'replied', staffCommentId: 's1' } });
  assert.equal(r.reply, false);
  assert.equal(!r.reply && r.refusal, 'staff_replied');
  assert.match(!r.reply ? r.detail : '', /s1/);
});

test('D-122 addendum: the Page tagged the commenter on the post — refused, a different reason', () => {
  const r = decide({ staff: { handled: true, how: 'tagged', staffCommentId: 's2' } });
  assert.equal(!r.reply && r.refusal, 'staff_tagged_commenter');
});

test('D-122 addendum: an unreadable staff check refuses — unknown is not "nobody answered"', () => {
  const r = decide({ staff: { handled: null, detail: 'no name' } });
  assert.equal(!r.reply && r.refusal, 'staff_check_unknown');
});

test('D-122 addendum: the verdict is attributed first — praise the staff thanked stays noise, a complaint still escalates', () => {
  const staff = { handled: true, how: 'replied', staffCommentId: 's1' } as const;
  const praise = decide({ verdict: 'ignore', staff });
  assert.equal(!praise.reply && praise.refusal, 'comment_not_worth_reply');
  const complaint = decide({ verdict: 'escalate', staff });
  assert.equal(!complaint.reply && complaint.refusal, 'comment_escalated');
});

test('D-122 addendum: staff is decided BEFORE our own person and thread rules', () => {
  // Those two trigger `resumePending` on a delivering channel, which would send a draft
  // decided before the staff answered. Staff first means the resume is never reached.
  const r = decide({
    staff: { handled: true, how: 'tagged', staffCommentId: 's2' },
    personAlreadyAnswered: true,
    threadAlreadyAnswered: true,
  });
  assert.equal(!r.reply && r.refusal, 'staff_tagged_commenter');
});
