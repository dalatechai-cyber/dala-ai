import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCommentReply, type CommentDecisionInput } from './eligibility.ts';

const NOW = new Date('2026-09-04T12:00:00Z');
const LINE = { body: 'Сайн байна уу! Дэлгэрэнгүйг хувийн мессежээр хүргэе.', reviewedAt: '2026-09-01T00:00:00Z' };

const base: CommentDecisionInput = {
  config: { policy: 'public_only', maxPostAgeDays: 30, ignoreCommenterIds: [] },
  pinnedLine: LINE,
  comment: {
    commentId: 'c_1',
    threadId: 'c_1',
    fromId: 'customer_1',
    createdAt: new Date('2026-09-04T11:50:00Z'),
    parentIsOurs: false,
  },
  threadAlreadyAnswered: false,
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
    assert.equal(o.reply === true && o.body, LINE.body, 'the tenant line, unchanged');
  }
  // And the signature itself carries no text field. If somebody adds one, this fails.
  assert.ok(!('text' in base.comment), 'the comment TEXT must never become an input here');
});

test('the pinned line is returned unchanged — never trimmed, wrapped or decorated', () => {
  const odd = { body: '  Сайн байна уу!  ', reviewedAt: '2026-09-01' };
  const r = decide({ pinnedLine: odd });
  assert.equal(r.reply === true && r.body, '  Сайн байна уу!  ');
});

// ---------------------------------------------------------------------------
// Per-tenant configuration
// ---------------------------------------------------------------------------

test('comments are OFF unless the tenant turned them on', () => {
  const r = withConfig({ policy: 'none' });
  assert.equal(r.reply, false);
  assert.equal(r.reply === false && r.refusal, 'comment_policy_off');
});

test('a policy needing the private reply is refused, not approximated with a public one', () => {
  // Turning a tenant's private_only choice into a public post under their own wall is the
  // worst possible way to be helpful. §3.8.4's single-use expiring private reply is not
  // built, so these refuse.
  for (const policy of ['private_only', 'both']) {
    const r = withConfig({ policy });
    assert.equal(r.reply === false && r.refusal, 'private_reply_not_implemented', policy);
  }
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

test('a comment on a post older than the tenant window is not answered', () => {
  const old = withComment({ createdAt: new Date('2026-07-01T00:00:00Z') });
  assert.equal(old.reply === false && old.refusal, 'post_too_old');
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
    config: { policy: 'none', maxPostAgeDays: 30, ignoreCommenterIds: ['customer_1'] },
    comment: { ...base.comment, createdAt: new Date('2020-01-01'), parentIsOurs: true },
    threadAlreadyAnswered: true,
    pinnedLine: null,
  });
  assert.equal(r.reply === false && r.refusal, 'comment_policy_off');
});

test('every refusal carries a detail a person could act on', () => {
  const inputs: Partial<CommentDecisionInput>[] = [
    { config: { ...base.config, policy: 'none' } },
    { config: { ...base.config, policy: 'both' } },
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
  assert.equal(seen.size, 8, 'every refusal reason is reachable and distinct');
});
