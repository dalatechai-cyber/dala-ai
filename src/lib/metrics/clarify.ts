/**
 * Did we answer the customer, or ask them something first?
 *
 * ## The blind spot this exists to close
 *
 * The fortnightly gap report clusters conversations where we refused, sent the handoff
 * line, or asked a clarifying question. The first two are recorded — `quality_flags` carries
 * a row with a code, and a handoff also shows as `messages.answered_by = 'canned'`. **The
 * third was invisible.**
 *
 * `disambiguation_pairs` is read by exactly one thing: `prompt/sections.ts`, which renders
 * `trigger_term`/`question` into the prompt as text. There is no matcher, no gate and no
 * flag. The model decides to clarify, and the resulting reply is `answered_by = 'model'` —
 * byte-identical to a real answer. So the one class the founder most wanted surfaced was
 * the one class nothing could see.
 *
 * The founder's example, from Matrix on 2026-09-07: a customer writes «цаг», which is
 * genuinely ambiguous between opening hours and booking. Asking which is correct behaviour.
 * Asking it *every time* is a row that belongs in `disambiguation_pairs`, and nobody can
 * know it is frequent without counting it.
 *
 * ## Three sources, in descending order of how much they know
 *
 * 1. **`configured`** — the reply matches one of the tenant's own clarify questions. This
 *    is certain and free, and it is also circular: it can only find clarifications already
 *    configured, which are by definition not the gap. Kept because knowing an existing row
 *    fires often is itself worth reporting.
 * 2. **`classifier`** — an injected judgement over our own outbound text. The fortnightly
 *    job supplies a model-backed one; everything here takes it as a parameter, so this
 *    module never calls a provider and nothing in it can spend.
 * 3. **`structural`** — inference from `turnsToIntent` (D-042). In a conversation where the
 *    customer's intent WAS eventually delivered but took more than one reply, the replies
 *    before the last one did not answer. That catches «цаг» exactly, with no model at all:
 *    «цаг» → *which did you mean?* → «захиалга» → the link is `turns: 2`, not 1.
 *
 * Precedence is that order, and `via` records which source decided, so a finding can always
 * be read back to the evidence that produced it rather than being an undifferentiated
 * "clarification".
 *
 * ## This changes nothing a customer sees, and that was a decision
 *
 * The obvious fourth source is to have the reply path record the fact — a marker the model
 * emits, or a deterministic clarify gate. The founder refused it on 2026-09-07 and the
 * reason is worth keeping: *nothing changes customer-visible behaviour to improve a report.*
 * This module reads stored messages after the fact. A wrong answer costs an inaccurate line
 * in a fortnightly report, never a refused customer and never a word in a prompt.
 *
 * ## It proposes nothing
 *
 * A finding names the customer's term and counts distinct people. It does not write the
 * disambiguation question, because that is customer-visible Mongolian and belongs to the
 * business (D-020). `kb_change_proposals` carries the slot with `question: null`.
 */
import { carriesBookingUrl, turnsToBookingLink, type ConversationTurn, type IntentSpec } from './turnsToIntent.ts';
import { firstMatchingStem } from '../mn/match.ts';
import { nfc } from '../mn/text.ts';

export type ClarifySource = 'configured' | 'classifier' | 'structural';

/** What an injected classifier may say about one of OUR replies. */
export type ClarifyVerdict = 'clarifying' | 'answering' | 'unknown';

export type ClarifySpec = {
  /**
   * The tenant's own clarify questions — `disambiguation_pairs.question` and
   * `price_axes.verbatim_question`. Tenant data, so a parameter rather than a constant.
   */
  configuredQuestions?: readonly string[];
  /**
   * Optional judgement over our own outbound text. Injected, so this module makes no
   * provider call and needs no budget; the job that supplies it does.
   */
  classify?: (replyText: string) => ClarifyVerdict;
  /** Enables the structural source. Without it, only 1 and 2 run. */
  intent?: IntentSpec;
};

export type Clarification = {
  /** Index into the turns array of the reply that asked rather than answered. */
  replyIndex: number;
  via: ClarifySource;
  /**
   * The customer message this reply responded to — the term that was ambiguous, and the
   * thing a cluster is built from. Raw; `redact/fragment.ts` decides what may be quoted.
   */
  triggerText: string;
};

/** Trailing punctuation and case are not differences. Our own text only. */
const norm = (s: string): string => nfc(s).toLowerCase().replace(/\s+/gu, ' ').trim();

function matchesConfigured(reply: string, configured: readonly string[]): boolean {
  const body = norm(reply);
  // Substring over OUR OWN outbound text — the one place this repository permits one, for
  // the reason `guard/outbound.ts` and `turnsToIntent.ts` give. Never over customer text.
  return configured.some((q) => {
    const needle = norm(q);
    return needle !== '' && body.includes(needle);
  });
}

/** The customer turn immediately before `i`, which is what the reply was responding to. */
function triggerFor(turns: readonly ConversationTurn[], i: number): string | null {
  for (let j = i - 1; j >= 0; j -= 1) {
    if (turns[j]!.direction === 'inbound') return turns[j]!.body;
  }
  return null;
}

export function findClarifications(
  turns: readonly ConversationTurn[],
  spec: ClarifySpec = {},
): Clarification[] {
  const configured = spec.configuredQuestions ?? [];

  // The structural set: reply positions before the one that delivered the intent. Computed
  // once, and only when an intent spec is supplied, because `turnsToBookingLink` throws on
  // a malformed one rather than guessing.
  const structural = new Set<number>();
  if (spec.intent !== undefined) {
    const r = turnsToBookingLink(turns, spec.intent);
    if (r.outcome === 'delivered') {
      // THE RULE IS "BEFORE THE LINK", NOT "AFTER THE INTENT", and the difference is the
      // founder's own example. «цаг» matches no booking stem — it is three characters and
      // ambiguous, which is the entire point of it — so `turnsToBookingLink` locates the
      // intent at the customer's SECOND message, «цаг захиалъя», and scores the
      // conversation `turns: 1`. Correct by its own definition: once the customer said what
      // they wanted, they got it in one reply.
      //
      // But the clarification happened BEFORE that, on a turn the intent-relative window
      // cannot see. Counting only replies after the intent finds nothing here, which is
      // exactly the blind spot this module exists to close. An earlier draft did that and
      // the test caught it.
      //
      // So: every reply before the one that delivered the link. A link the bot volunteered
      // unprompted is excluded not by its POSITION but by its CONTENT — it carries the URL,
      // so it answered rather than asked. `carriesBookingUrl` is imported rather than
      // re-implemented so this and the metric cannot drift apart about the same reply.
      //
      // `delivering` is the first link-carrying reply AFTER the intent, not the first one
      // overall. A bot that volunteers the link in its greeting and is later asked to book
      // would otherwise collapse the window to nothing — the second test below is that
      // case, and it failed until this said `> intentAt`.
      const intentAt = turns.findIndex(
        (t) => t.direction === 'inbound' && firstMatchingStem(t.body, spec.intent!.intentStems) !== null,
      );
      const delivering = turns.findIndex(
        (t, i) => i > intentAt && t.direction === 'outbound'
          && carriesBookingUrl(t.body, spec.intent!.bookingUrl),
      );
      for (const [i, t] of turns.entries()) {
        if (i >= delivering || t.direction !== 'outbound') continue;
        if (carriesBookingUrl(t.body, spec.intent.bookingUrl)) continue;
        structural.add(i);
      }
    }
  }

  const out: Clarification[] = [];
  for (const [i, turn] of turns.entries()) {
    if (turn.direction !== 'outbound') continue;
    const trigger = triggerFor(turns, i);
    if (trigger === null) continue;   // nothing was asked, so nothing was clarified

    let via: ClarifySource | null = null;
    if (matchesConfigured(turn.body, configured)) {
      via = 'configured';
    } else if (spec.classify !== undefined) {
      const verdict = spec.classify(turn.body);
      // `unknown` is deliberately NOT a clarification. A classifier that cannot tell must
      // not inflate the count — the report would then measure the classifier's confidence
      // rather than the customers' experience.
      if (verdict === 'clarifying') via = 'classifier';
      else if (verdict === 'answering') via = null;
      else if (structural.has(i)) via = 'structural';
    } else if (structural.has(i)) {
      via = 'structural';
    }

    if (via !== null) out.push({ replyIndex: i, via, triggerText: trigger });
  }
  return out;
}
