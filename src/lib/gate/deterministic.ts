/**
 * The deterministic pre-model layer (§6.8).
 *
 * Every message answered without a model call costs ₮0 and returns in ~200ms instead of
 * ~3s. §6.3.8 prices the replies this absorbs — where the model is paid to retype a
 * `canned_responses` row — at **₮26,300/tenant-month**, the largest single saving in the
 * design.
 *
 * ## When in doubt, DO NOT FIRE — and that is the opposite of the gate matcher
 *
 * The two matchers look alike and their failure directions are mirror images, which is
 * worth stating plainly because getting it backwards is silent in both cases:
 *
 * | | Skipping a malformed rule means | So on doubt |
 * |---|---|---|
 * | `gate/match.ts` | a refusal the tenant asked for stops firing, and the topic becomes discussable | **refuse the whole match** |
 * | here | one message costs a model call it could have avoided | **skip the rule** |
 *
 * A short-circuit that fires wrongly refuses a paying customer with **no model in the
 * loop to recover**. A short-circuit that fails to fire costs ₮39 and the model handles
 * the message perfectly. Those are not comparable, so every ambiguity here resolves
 * towards the model.
 *
 * ## The ancestor's two live defects, both verified by execution
 *
 *  - `detectShortcutIntent('Уучлаарай асуумаар байна', {hasHistory:false})` → `'greeting'`.
 *    `GREETING_REGEX` is `/^(сайн|байна|уу|hi|hello|hey)/i` — anchored left, open right —
 *    so any message beginning `уу` matched, and «Уучлаарай» is among the commonest
 *    openers in Mongolian customer service. That customer's question was never answered.
 *  - `detectShortcutIntent('Facebook хаяг байна уу', {hasHistory:true})` → `'location'`.
 *    `хаяг` matched anywhere, on every message, so an address shortcut stole a question
 *    about the Facebook page.
 *
 * Both are prefix or substring matching where whole-message matching was needed, which is
 * why `whole_message` is the default and the only mode a greeting may use.
 */
import { containsStem, wholeMessageMatches } from '../mn/match.ts';
import { cpLength } from '../mn/text.ts';
import { isTenantConfirmed } from '../provenance.ts';
import { MIN_STEM_CHARS } from './match.ts';

export type DeterministicRule = {
  intent: string;
  /** The sentence to send. Tenant data, and subject to the same review as any other. */
  body: string;
  enabled: boolean;
  matchMode: 'whole_message' | 'contains_stem';
  stems: readonly string[];
  requiresEmptyHistory: boolean;
  /**
   * `provenance`, raw as the row holds it (D-020). Required and undefaulted, as the column
   * is.
   *
   * This is the one table where an unconfirmed row is WITHHELD rather than counted, and
   * the reason is what the row is rather than which table it sits in: `body` is sent to
   * the customer **verbatim, with no model in the loop and no `reviewed_at` gate on this
   * table** — `canned_responses` has one, `deterministic_replies` does not. So an invented
   * sentence here reaches a customer as the salon's own words.
   *
   * Not firing costs exactly one model call, which is the cost this whole table exists to
   * avoid and the cost the header above already calls acceptable on any doubt.
   */
  provenance: unknown;
};

/**
 * What we know about the conversation so far.
 *
 * **`known: false` is not `empty: true`.** The ancestor's `getHistory` returns `null` when
 * Redis is unreachable and `[]` only when it genuinely answered "no turns", and
 * `messengerProcess.js:59` treats `null` as "assume ongoing conversation". Collapsing the
 * two makes a storage hiccup greet an existing customer from scratch — mid-conversation,
 * as though the last ten minutes had not happened.
 */
export type HistoryState = { known: true; empty: boolean } | { known: false };

export type DeterministicHit = { intent: string; body: string };

/** Why a rule did not fire. Reported so an operator can see a dead row. */
export type SkipReason = 'disabled' | 'no_stems' | 'stem_too_short' | 'history_not_empty' | 'history_unknown' | 'no_match';

export type DeterministicOutcome = {
  hit: DeterministicHit | null;
  /** One entry per rule that could have fired and did not, with the reason. */
  skipped: { intent: string; reason: SkipReason }[];
  /**
   * Rules that MATCHED this message and were withheld for provenance (D-020).
   *
   * Separate from `skipped` deliberately. `skipped` is "this rule was not applicable";
   * this is "this rule had the answer and was not allowed to give it", which is the only
   * one of the two an operator must act on — either confirm the row or delete it.
   */
  suppressed: string[];
};

export function matchDeterministic(
  text: string,
  rules: readonly DeterministicRule[],
  history: HistoryState,
): DeterministicOutcome {
  const skipped: { intent: string; reason: SkipReason }[] = [];
  const suppressed: string[] = [];

  /**
   * A match, resolved against the row's provenance.
   *
   * Checked AFTER matching rather than before, so an unconfirmed rule that was never going
   * to fire on this message stays quiet. `suppressed` then means precisely what it says:
   * this row would have answered.
   */
  const answer = (rule: DeterministicRule): DeterministicHit | null => {
    if (isTenantConfirmed(rule.provenance)) return { intent: rule.intent, body: rule.body };
    suppressed.push(rule.intent);
    return null;
  };

  for (const rule of rules) {
    if (!rule.enabled) { skipped.push({ intent: rule.intent, reason: 'disabled' }); continue; }
    if (rule.stems.length === 0) { skipped.push({ intent: rule.intent, reason: 'no_stems' }); continue; }

    if (rule.requiresEmptyHistory) {
      // Unknown is NOT empty. Firing here would greet a customer mid-conversation because
      // a read failed, which is worse than the model answering their message.
      if (!history.known) { skipped.push({ intent: rule.intent, reason: 'history_unknown' }); continue; }
      if (!history.empty) { skipped.push({ intent: rule.intent, reason: 'history_not_empty' }); continue; }
    }

    if (rule.matchMode === 'whole_message') {
      if (wholeMessageMatches(text, rule.stems)) {
        const hit = answer(rule);
        if (hit !== null) return { hit, skipped, suppressed };
        continue;
      }
      skipped.push({ intent: rule.intent, reason: 'no_match' });
      continue;
    }

    // `contains_stem` carries the same over-matching risk as the gate's matcher, so it
    // carries the same floor. A rule below it is SKIPPED rather than refusing everything:
    // here a bad rule costs a model call, not a disarmed refusal.
    const short = rule.stems.filter((s) => cpLength(s) < MIN_STEM_CHARS);
    if (short.length > 0) { skipped.push({ intent: rule.intent, reason: 'stem_too_short' }); continue; }

    if (rule.stems.some((stem) => containsStem(text, stem))) {
      const hit = answer(rule);
      if (hit !== null) return { hit, skipped, suppressed };
      continue;
    }
    skipped.push({ intent: rule.intent, reason: 'no_match' });
  }

  return { hit: null, skipped, suppressed };
}
