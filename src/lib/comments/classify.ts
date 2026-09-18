/**
 * Which public comments deserve a reply (docs/comments.md).
 *
 * ## This function returns an ENUM, and that is the whole safety argument
 *
 * `eligibility.ts` rests on one property: `decideCommentReply` never receives the
 * customer's words, so "never answer a price in a comment regardless of what is asked" is
 * not a rule the code follows — it is a sentence that cannot be expressed in that
 * function's inputs.
 *
 * A classifier reads the comment text, so the naive wiring destroys exactly that. D-082
 * names the shape: *the bug was not that somebody chose the wrong string, it was that the
 * parameter accepted one.* So the reading happens HERE, the result is one of four values,
 * and the decision downstream takes the value. There is still no path from a question
 * about prices to the bytes of a reply.
 *
 * ## It is deterministic rows, and on this surface that is a security property
 *
 * A public comment is attacker-controlled text from anyone with a Facebook account. With a
 * fixed reply and an enum verdict the worst a crafted comment can achieve is a wrong enum;
 * it cannot produce prose. A model in this loop would put attacker-supplied text in front
 * of a model on the one surface where the output is public, permanent and in the tenant's
 * own voice. Cost says the same thing from the other side — a popular post draws dozens of
 * comments and each would be a cold classification (D-072: $0.0406) for a reply that is one
 * fixed sentence.
 *
 * ## The cap makes this a prioritiser, not a filter
 *
 * `comment_replies_per_post_per_day` is 1 and replies are decided first-come-first-served.
 * So a false positive is not one wasted comment — it is the day's single allowance spent,
 * and the «хэдэн төгрөг вэ» that arrives an hour later gets nothing. **Precision matters
 * more than recall here, which is the opposite of the DM surface**, and silence is a
 * decision to hold the allowance rather than a failure to answer.
 */
import { matcherFires, parseMatcher, type MatchSubject } from '../gate/match.ts';

/**
 * Four values, not two, and the fourth is the instrument.
 *
 * `ignore` means a rule recognised this as noise. `unclassified` means nothing fired.
 * Both stay silent, and collapsing them would destroy the only thing the shadow phase
 * produces: the list of comments the tenant has no rule for. Swamped by «гоё», that list
 * is unreadable — which is D-070's rule (a mechanism whose correct behaviour and its worst
 * behaviour look identical from outside is not yet a mechanism) applied before the
 * mechanism ships rather than after it fails.
 */
export type CommentVerdict = 'escalate' | 'reply' | 'ignore' | 'unclassified';

/**
 * Verdict precedence, strongest first. A rule may declare any of the first three; the
 * fourth is the absence of a rule and can never be written in a row.
 *
 * **This is a total order in code, not a `priority` column.** D-075's rule is that
 * ambiguity must be a verdict and never a tie broken silently — with a declared total
 * order there is no tie to break, and no row can reorder it. The ordering is load-bearing
 * rather than tidy: one of the four complaints in the corpus, «ai bish huntei holbogdmoor
 * bna» (*I want to talk to a human, not an AI*), contains `holbog` and is caught by the
 * contact topic. Under any order where `reply` can win, a customer explicitly asking not
 * to talk to a bot is answered "come to DM" on the salon's public wall. It is D-066's
 * ordering lesson: the check that re-attributes runs before every other check.
 */
const PRECEDENCE: readonly CommentVerdict[] = ['escalate', 'reply', 'ignore'];

/** A rule's verdict. `unclassified` is structurally unavailable — see `CommentVerdict`. */
export type RuleVerdict = 'escalate' | 'reply' | 'ignore';

export type CommentRule = {
  /** ASCII key for the operator and the counters — `price`, `complaint`, `praise`. */
  ruleKey: string;
  verdict: RuleVerdict;
  /** The raw `matcher` jsonb, the SAME shape `out_of_scope_topics` carries. */
  matcher: unknown;
};

export type ClassifyResult =
  | {
      ok: true;
      verdict: CommentVerdict;
      /**
       * Every rule that fired, in row order, for the operator's reading. The verdict is
       * decided by precedence over these, never by the first one.
       */
      firedRules: string[];
    }
  /**
   * The caller must refuse the whole job. Both codes fail CLOSED — nothing is posted.
   *
   * `no_rules` is not "classify everything as ignore". A tenant whose rules failed to load,
   * or who was switched on before anyone wrote any, would otherwise look exactly like a
   * tenant whose customers all happened to say «гоё» — and the counters would agree.
   */
  | { ok: false; code: 'no_rules' | 'malformed_rule'; detail: string };

/**
 * Classify one comment against the tenant's rules.
 *
 * EVERY rule is evaluated; there is no early exit on the first match. `matchRules` gives
 * the reason one file over — Mongolian customer messages bundle constantly, and
 * «Сайн байна уу, үнэ нь хэд вэ?» is a greeting AND a price question. Stopping at the
 * first fired rule would make the verdict depend on row order, which is the silent tie
 * `PRECEDENCE` exists to make impossible.
 *
 * A malformed matcher REFUSES rather than being skipped, for `parseMatcher`'s own reason:
 * a skipped `escalate` rule is a complaint quietly reclassified as a sales enquiry and
 * answered with a brush-off, with nothing anywhere going red.
 */
export function classifyComment(subject: MatchSubject, rules: readonly CommentRule[]): ClassifyResult {
  if (rules.length === 0) {
    return { ok: false, code: 'no_rules', detail: 'this tenant has no comment rules; refusing rather than treating every comment as noise' };
  }

  const fired: { ruleKey: string; verdict: RuleVerdict }[] = [];
  for (const rule of rules) {
    const parsed = parseMatcher(rule.matcher);
    if (!parsed.ok) {
      return { ok: false, code: 'malformed_rule', detail: `comment rule ${rule.ruleKey}: ${parsed.detail}` };
    }
    if (matcherFires(subject, parsed.spec)) fired.push({ ruleKey: rule.ruleKey, verdict: rule.verdict });
  }

  const verdict = PRECEDENCE.find((v) => fired.some((f) => f.verdict === v)) ?? 'unclassified';
  return { ok: true, verdict, firedRules: fired.map((f) => f.ruleKey) };
}
