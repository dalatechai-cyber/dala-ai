/**
 * The salon comment-rule template against every real comment and every written example
 * (D-122). Permanent: a rule edit that answers praise or a tag, or stops answering a
 * question, fails here before it can reach a tenant's wall.
 *
 * Runs the REAL chain — `classifyComment` over the template's rows, then
 * `decideCommentReply`, then `decideAfterLookup` with what Graph would say about tags —
 * because a test of the rules alone would miss the tag and loop checks that sit after them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyComment, type CommentRule } from './classify.ts';
import { decideAfterLookup, decideCommentReply } from './eligibility.ts';
import { parseMatcher } from '../gate/match.ts';
import { EXAMPLES, REAL_COMMENTS, type CorpusEntry, type Expect } from './salonCorpus.fixtures.ts';

const TEMPLATE = JSON.parse(readFileSync(new URL('../../../scripts/provision/templates/comment_rules.salon.json', import.meta.url), 'utf8')) as {
  rules: { rule_key: string; verdict: CommentRule['verdict']; matcher: unknown }[];
};
const RULES: CommentRule[] = TEMPLATE.rules.map((r) => ({ ruleKey: r.rule_key, verdict: r.verdict, matcher: r.matcher }));

const NOW = new Date('2026-09-25T03:00:00Z');
const LINE = { body: 'Сайн байна уу! Манай хуудас руу мессеж бичвэл дэлгэрэнгүй хариулъя 😊', reviewedAt: '2026-09-25T00:00:00Z' };
const PRIVATE = { body: 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.', reviewedAt: '2026-09-25T00:00:00Z' };

/** What the whole chain does with one comment on a fresh post. */
export function outcome(entry: CorpusEntry): { got: Expect; fired: string[] } {
  const c = classifyComment({ text: entry.text, attachments: [] }, RULES);
  if (!c.ok) throw new Error(c.detail);
  const d = decideCommentReply({
    config: { policy: 'both', maxPostAgeDays: 30, ignoreCommenterIds: [], repliesPerPostPerDay: 20 },
    verdict: c.verdict,
    pinnedLine: LINE,
    privateLine: PRIVATE,
    comment: {
      commentId: 'c', threadId: 'c', postId: 'p', fromId: 'f',
      createdAt: new Date(NOW.getTime() - 60_000), parentIsOurs: false,
    },
    threadAlreadyAnswered: false,
    personAlreadyAnswered: false,
    postRepliesInWindow: 0,
    now: NOW,
  });
  if (!d.reply) return { got: d.refusal === 'comment_escalated' ? 'escalate' : 'silent', fired: c.firedRules };
  const after = decideAfterLookup({
    tagsPerson: entry.tagsPerson ?? false,
    postCreatedAt: new Date(NOW.getTime() - 86_400_000),
    maxPostAgeDays: 30,
    now: NOW,
  });
  return { got: after.ok ? 'reply' : 'silent', fired: c.firedRules };
}

function check(entries: readonly CorpusEntry[], label: string): void {
  const wrong = entries
    .map((en) => ({ en, ...outcome(en) }))
    .filter((r) => r.got !== r.en.expect)
    .map((r) => `  ${label}: «${r.en.text}» expected ${r.en.expect}, got ${r.got} [${r.fired.join(', ')}]`);
  assert.deepEqual(wrong, [], `\n${wrong.join('\n')}`);
}

test('the template parses: every matcher is valid, every verdict is one of three', () => {
  assert.ok(RULES.length > 0);
  for (const r of RULES) {
    const p = parseMatcher(r.matcher);
    assert.ok(p.ok, `${r.ruleKey}: ${p.ok ? '' : p.detail}`);
    assert.ok(['escalate', 'reply', 'ignore'].includes(r.verdict), r.ruleKey);
  }
  assert.equal(new Set(RULES.map((r) => r.ruleKey)).size, RULES.length, 'rule keys are unique');
});

test('D-122: every REAL comment on Matrix’s wall gets the founder’s outcome', () => {
  assert.equal(REAL_COMMENTS.length, 42, '72 deliveries less the Page\u2019s own 30');
  check(REAL_COMMENTS, 'real');
});

for (const [kind, entries] of Object.entries(EXAMPLES)) {
  test(`D-122: ${kind} — ${entries.length} examples, each with its outcome`, () => {
    assert.ok(entries.length >= 30, `${kind} has ${entries.length}; the founder asked for at least 30`);
    check(entries, kind);
  });
}

test('D-122: ZERO replies to praise or to tags — asserted as a count, not only per example', () => {
  const replies = [...EXAMPLES.praise, ...EXAMPLES.tag].filter((en) => outcome(en).got === 'reply');
  assert.equal(replies.length, 0);
  const realPraise = REAL_COMMENTS.filter((en) => en.expect === 'silent');
  assert.equal(realPraise.filter((en) => outcome(en).got === 'reply').length, 0);
});

test('D-122: a tag is silenced by the Graph answer, not by luck in the words', () => {
  // At least some tag examples ask a real question; the classifier alone would answer them,
  // and only `message_tags` stops it. If none did, this suite would not be testing the tag.
  const wouldAnswer = EXAMPLES.tag.filter((en) => outcome({ ...en, tagsPerson: false }).got === 'reply');
  assert.ok(wouldAnswer.length >= 5, `only ${wouldAnswer.length} tag examples exercise the lookup`);
});
