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
import { containsStem, coversMessage, wholeMessageMatches } from '../mn/match.ts';
import { cpLength } from '../mn/text.ts';
import { isTenantConfirmed } from '../provenance.ts';
import { MIN_STEM_CHARS } from './match.ts';

export type DeterministicRule = {
  intent: string;
  /** The sentence to send. Tenant data, and subject to the same review as any other. */
  body: string;
  enabled: boolean;
  /**
   * `on_topic` (`0042`): `stems` are gate `topic_key`s, and the row fires when one of those
   * topics fired on this message. The gate decides what the message is about; this row only
   * says what to add when it is.
   */
  matchMode: 'whole_message' | 'contains_stem' | 'covers_message' | 'on_topic';
  stems: readonly string[];
  /**
   * `covers_message` only: whole words that may sit beside a stem (`0041`). Every word of
   * the message must be a stem hit or one of these, which is what lets a row answer a
   * question that is ONLY about its topic — «Энэ Тара салон мөн үү?» — and stay silent for
   * «Tara salon hayag haana baidag ve?», which is about the address.
   */
  coverWords: readonly string[];
  /**
   * `replace` answers with this row and nothing else — every row before `0041`.
   * `append` never answers on its own: the reply is produced as it would have been, and
   * the body is added at the END. Founder, 2026-09-24: *"The Tara line must never replace
   * an answer."*
   */
  placement: 'replace' | 'append';
  /**
   * Price-list service names whose rows open the reply, in THIS order, before `body`
   * (`0041`). Empty for a row that is its body alone. The rows are read from the compiled
   * price list at request time, so this table never holds a price.
   */
  quoteServices: readonly string[];
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

export type DeterministicHit = {
  intent: string;
  body: string;
  quoteServices: readonly string[];
  /** Fired by a gate topic, not by the words (`on_topic`). Not added to a refusal line. */
  onTopic?: boolean;
};

/** Why a rule did not fire. Reported so an operator can see a dead row. */
export type SkipReason =
  | 'disabled' | 'no_stems' | 'stem_too_short' | 'history_not_empty' | 'history_unknown' | 'no_match'
  /** A `covers_message` row reads the words, and a message carrying a picture is not only
   *  its words — «зураг» with a photograph attached is not a question about sending one. */
  | 'has_attachment';

export type DeterministicOutcome = {
  /** The `replace` row that answers this message, or null. */
  hit: DeterministicHit | null;
  /**
   * Every `append` row that matched, in rule order. Never an answer on its own: the caller
   * adds each body at the end of whatever it serves. Collected even when `hit` is set, and
   * a body the reply already ends with is not added twice (`withAppended`).
   */
  appends: DeterministicHit[];
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
  opts: { hasAttachment: boolean; topics?: readonly string[] } = { hasAttachment: false },
): DeterministicOutcome {
  const skipped: { intent: string; reason: SkipReason }[] = [];
  const suppressed: string[] = [];
  const appends: DeterministicHit[] = [];
  let hit: DeterministicHit | null = null;

  /**
   * A match, resolved against the row's provenance.
   *
   * Checked AFTER matching rather than before, so an unconfirmed rule that was never going
   * to fire on this message stays quiet. `suppressed` then means precisely what it says:
   * this row would have answered.
   */
  const answer = (rule: DeterministicRule): DeterministicHit | null => {
    if (isTenantConfirmed(rule.provenance)) {
      return {
        intent: rule.intent, body: rule.body, quoteServices: rule.quoteServices,
        ...(rule.matchMode === 'on_topic' ? { onTopic: true } : {}),
      };
    }
    suppressed.push(rule.intent);
    return null;
  };

  /** Did this rule's matcher fire? `null` means it was skipped, with the reason recorded. */
  const fires = (rule: DeterministicRule): boolean | null => {
    if (rule.matchMode === 'whole_message') return wholeMessageMatches(text, rule.stems);
    // Topic keys are identifiers the gate emitted, not customer text, so no stem floor.
    if (rule.matchMode === 'on_topic') return rule.stems.some((k) => (opts.topics ?? []).includes(k));
    // `contains_stem` and `covers_message` carry the gate matcher's over-matching risk on
    // their stems, so they carry its floor. A rule below it is SKIPPED rather than refusing
    // everything: here a bad rule costs a model call, not a disarmed refusal.
    const short = rule.stems.filter((s) => cpLength(s) < MIN_STEM_CHARS);
    if (short.length > 0) { skipped.push({ intent: rule.intent, reason: 'stem_too_short' }); return null; }
    if (rule.matchMode === 'covers_message') {
      if (opts.hasAttachment) { skipped.push({ intent: rule.intent, reason: 'has_attachment' }); return null; }
      return coversMessage(text, rule.stems, rule.coverWords);
    }
    return rule.stems.some((stem) => containsStem(text, stem));
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

    const fired = fires(rule);
    if (fired === null) continue;
    if (!fired) { skipped.push({ intent: rule.intent, reason: 'no_match' }); continue; }

    // The FIRST replace row answers, as before. Every rule is still evaluated, because an
    // append row later in the list must be collected whatever answered.
    if (rule.placement === 'append') {
      const a = answer(rule);
      if (a !== null) appends.push(a);
    } else if (hit === null) {
      hit = answer(rule);
    }
  }

  return { hit, appends, skipped, suppressed };
}

/**
 * A reply with the `append` bodies added at the END.
 *
 * A body the model already wrote somewhere else in the reply is MOVED to the end rather
 * than sent twice. That is not an edit of the model's words: the only text removed is a
 * byte-exact copy of the tenant's own reviewed line, and it goes back one place later. A
 * reply that is nothing BUT the body stays the body.
 */
export function withAppended(reply: string, appends: readonly DeterministicHit[]): string {
  let out = reply.trim();
  for (const a of appends) {
    const line = a.body.trim();
    if (line === '') continue;
    const rest = out.split(line).map((part) => part.trim()).filter((part) => part !== '').join('\n\n');
    out = rest === '' ? line : `${rest}\n\n${line}`;
  }
  return out;
}

/**
 * The rows a `quote_services` hit opens with, then its body.
 *
 * Returns null — the row does not answer — when ANY named service is missing from the
 * compiled price list. Half a price list under a question about the whole of it is worse
 * than the model's answer, and a service renamed in `services` must not quietly drop out
 * of the reply that lists it.
 */
export function composeQuoted(
  hit: { body: string; quoteServices: readonly string[] },
  priceList: readonly { name: string; rows: readonly string[] }[],
): string | null {
  if (hit.quoteServices.length === 0) return hit.body;
  const rows: string[] = [];
  for (const name of hit.quoteServices) {
    const entry = priceList.find((p) => p.name === name);
    if (entry === undefined || entry.rows.length === 0) return null;
    rows.push(...entry.rows);
  }
  const body = hit.body.trim();
  return body === '' ? rows.join('\n') : `${rows.join('\n')}\n\n${body}`;
}
