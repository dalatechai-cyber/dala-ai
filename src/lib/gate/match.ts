/**
 * The inbound boundary-gate matcher (V1.md 3.3).
 *
 * Decides which of Ш0–Ш9 fired on the customer's message, so the outbound guard knows
 * which forbidden-vocabulary lists apply and whether a refused topic blocks prices.
 *
 * ## Where a matcher may and may not be used
 *
 * The arbitration (§10) is precise about this, and the precision matters:
 *
 * > Matchers run **inbound only to select which gate text is rendered and to set
 * > `deterministic_shortcircuit`**, and **outbound over our own text** for the guard —
 * > never as an unanchored pattern deciding to suppress a reply, unless
 * > `deterministic_shortcircuit` is explicitly enabled after a measured precision run.
 *
 * So a match here does **not** silence the model. It selects which rules the reply is
 * held to. Only an explicitly opted-in short-circuit answers without a model call at all,
 * and that is off by default per topic per tenant — because a short-circuit that fires
 * wrongly refuses a paying customer with no model in the loop to recover.
 *
 * ## A malformed matcher REFUSES; it is never skipped
 *
 * If a refusal rule cannot be parsed, skipping it means the refusal silently stops
 * firing — the topic the tenant explicitly asked never to be discussed becomes
 * discussable, and nothing anywhere goes red. So an unparseable matcher fails the whole
 * match and the caller 503s. A 503 costs a retry; a silently disarmed refusal costs the
 * thing the rule existed to prevent.
 */
import { containsStem, wholeMessageMatches } from '../mn/match.ts';
import { cpLength } from '../mn/text.ts';
import type { GateKey } from '../guard/outbound.ts';

/**
 * The shortest stem a rule may carry.
 *
 * Stem-prefix matching over Mongolian is powerful and blunt in the same move: `үс` (hair,
 * two characters) also fires on «үсэрсэн» (jumped), «үсрэх», «үснээс». Four characters is
 * the arbitration's floor and it is a floor, not a target — the real control is the dry
 * run against real messages, which needs a corpus this platform does not have yet.
 */
export const MIN_STEM_CHARS = 4;

export type MatcherSpec =
  | { mode: 'contains_stem'; stems: readonly string[] }
  | { mode: 'whole_message'; phrases: readonly string[] };

export type GateRule = {
  /** Which check this rule belongs to — `Ш1`, `Ш5`, … */
  gate: GateKey;
  topicKey: string;
  /** The raw `matcher` jsonb, exactly as the row holds it. */
  matcher: unknown;
  /** `disclosure_rules.quote_price`. False means no numeral may be emitted at all. */
  quotePrice: boolean;
  /** Off by default, per topic per tenant, until a precision run says otherwise. */
  deterministicShortcircuit: boolean;
  /** The canned kind whose sentence answers this topic. */
  responseKind: string;
};

export type ParseResult = { ok: true; spec: MatcherSpec } | { ok: false; detail: string };

/**
 * Parse and validate one `matcher` jsonb. Every rejection is a refusal to match, never a
 * silent pass.
 */
export function parseMatcher(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'matcher is not a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  const mode = o['mode'];

  if (mode === 'contains_stem') {
    const stems = o['stems'];
    if (!Array.isArray(stems) || stems.length === 0) return { ok: false, detail: 'contains_stem needs a non-empty stems array' };
    const bad: string[] = [];
    for (const s of stems) {
      if (typeof s !== 'string' || s.trim() === '') return { ok: false, detail: 'a stem is not a non-empty string' };
      // Characters, not UTF-16 units. Every Mongolian Cyrillic letter is one of each, but
      // the day a stem carries an emoji the two disagree and the floor silently moves.
      if (cpLength(s) < MIN_STEM_CHARS) bad.push(s);
    }
    if (bad.length > 0) {
      return { ok: false, detail: `stems shorter than ${MIN_STEM_CHARS} characters over-match badly: ${bad.join(', ')}` };
    }
    return { ok: true, spec: { mode: 'contains_stem', stems: stems as string[] } };
  }

  if (mode === 'whole_message') {
    const phrases = o['phrases'];
    if (!Array.isArray(phrases) || phrases.length === 0) return { ok: false, detail: 'whole_message needs a non-empty phrases array' };
    if (phrases.some((p) => typeof p !== 'string' || p.trim() === '')) return { ok: false, detail: 'a phrase is not a non-empty string' };
    return { ok: true, spec: { mode: 'whole_message', phrases: phrases as string[] } };
  }

  return { ok: false, detail: `unknown matcher mode ${JSON.stringify(mode)}` };
}

/** Does one parsed matcher fire on this message? */
export function matcherFires(text: string, spec: MatcherSpec): boolean {
  if (spec.mode === 'whole_message') return wholeMessageMatches(text, spec.phrases);
  return spec.stems.some((stem) => containsStem(text, stem));
}

export type MatchOutcome =
  | {
      ok: true;
      /** Gates whose matcher fired. Feeds `OutboundContext.firedGates`. */
      firedGates: GateKey[];
      /** True when any matched rule forbids quoting a price. Feeds check 2b. */
      refusedTopicBlocksPrice: boolean;
      /** Topic keys that matched, for the alert and the quality flag. */
      matchedTopics: string[];
      /**
       * The canned kind to send with NO model call, or null. Non-null only when a matched
       * rule has `deterministic_shortcircuit` explicitly enabled.
       */
      shortCircuitKind: string | null;
    }
  /** A rule could not be parsed. The caller must 503; it must not answer. */
  | { ok: false; detail: string };

/**
 * Run every rule against the customer's message.
 *
 * Every rule is evaluated — the composition rule is "do not stop at the first match",
 * because Mongolian customer messages bundle constantly
 * («Оюунсүрэн маргааш ажиллаж байна уу, үнэ нь хэд вэ?») and first-match-wins answers the
 * price while leaving the schedule unconstrained.
 */
export function matchRules(text: string, rules: readonly GateRule[]): MatchOutcome {
  const firedGates: GateKey[] = [];
  const matchedTopics: string[] = [];
  let refusedTopicBlocksPrice = false;
  let shortCircuitKind: string | null = null;

  for (const rule of rules) {
    const parsed = parseMatcher(rule.matcher);
    if (!parsed.ok) {
      return { ok: false, detail: `rule ${rule.topicKey} (${rule.gate}): ${parsed.detail}` };
    }
    if (!matcherFires(text, parsed.spec)) continue;

    matchedTopics.push(rule.topicKey);
    if (!firedGates.includes(rule.gate)) firedGates.push(rule.gate);
    if (!rule.quotePrice) refusedTopicBlocksPrice = true;
    // First enabled short-circuit wins; rules are supplied in the tenant's own order.
    if (rule.deterministicShortcircuit && shortCircuitKind === null) shortCircuitKind = rule.responseKind;
  }

  return { ok: true, firedGates, refusedTopicBlocksPrice, matchedTopics, shortCircuitKind };
}

export type CannedRow = { kind: string; body: string; reviewedAt: string | null };

export type CannedSection =
  | { ok: true; body: string; kinds: string[] }
  /** A line has no native-speaker sign-off. The route 503s with this code. */
  | { ok: false; code: 'canned_response_unreviewed'; kinds: string[] };

/**
 * Render the «БЭЛЭН ХАРИУЛТ» section the gate's blocks point into.
 *
 * The blocks name a kind rather than carrying the sentence, so L0 stays byte-identical
 * across every tenant and can become one prompt-cache entry for the whole platform
 * instead of one per tenant. The finished sentences live here, in L2, below the platform
 * rules and above nothing.
 *
 * **An unreviewed line refuses the whole section**, not just itself: a gate that points at
 * a missing sentence is a check with no answer, and what the customer sees is then
 * whatever the model improvises in the gap. A partially provisioned tenant is an
 * operator-visible state, never a silent degradation.
 */
export function renderCannedSection(label: string, rows: readonly CannedRow[]): CannedSection {
  const unreviewed = rows.filter((r) => r.reviewedAt === null).map((r) => r.kind);
  if (unreviewed.length > 0) return { ok: false, code: 'canned_response_unreviewed', kinds: unreviewed.sort() };

  // Sorted by kind so the section is byte-stable for a given set of rows — the database
  // makes no ordering promise, and an unstable L2 moves the cache key on every deploy.
  const ordered = [...rows].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const lines = ordered.map((r) => `"${r.kind}": ${r.body.trim()}`);
  return { ok: true, body: `=== ${label} ===\n${lines.join('\n')}`, kinds: ordered.map((r) => r.kind) };
}

/**
 * Every kind the rendered blocks actually name, so a caller can fetch exactly those rows
 * and a missing one is detectable before the prompt is built rather than after.
 */
export function kindsReferencedBy(blockBodies: readonly string[]): string[] {
  const out = new Set<string>();
  // ascii-safe: a canned kind is a lower_snake ASCII token in straight double quotes;
  // Mongolian prose in these blocks uses «…», so the two never collide.
  for (const body of blockBodies) for (const m of body.matchAll(/"([a-z][a-z_]*)"/g)) out.add(m[1] ?? '');
  out.delete('');
  return [...out].sort();
}
