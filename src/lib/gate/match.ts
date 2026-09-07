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
import { isTenantConfirmed } from '../provenance.ts';
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
  /**
   * `provenance`, raw as the row holds it (D-020).
   *
   * Required, with no default, for the same reason the column has none: a construction
   * site that cannot say where the rule came from must be made to answer rather than be
   * quietly credited with `tenant_confirmed`.
   *
   * **An unconfirmed rule still fires.** It is only counted. Withholding a refusal because
   * nobody has confirmed it yet would disarm exactly the check the tenant asked for, which
   * is the failure `parseMatcher` refuses to commit one function up; and this matcher does
   * not silence a reply, it selects which rules the reply is held to. Over-refusing costs
   * a handoff line. Under-refusing costs the thing the rule existed to prevent.
   */
  provenance: unknown;
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
       * Of those, the ones whose row is not `tenant_confirmed` (D-020). They fired — this
       * is the count, not a suppression list. Empty is the normal case and means every
       * refusal that ran was one the tenant stands behind.
       */
      unconfirmedTopics: string[];
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
  const unconfirmedTopics: string[] = [];
  let refusedTopicBlocksPrice = false;
  let shortCircuitKind: string | null = null;

  for (const rule of rules) {
    const parsed = parseMatcher(rule.matcher);
    if (!parsed.ok) {
      return { ok: false, detail: `rule ${rule.topicKey} (${rule.gate}): ${parsed.detail}` };
    }
    if (!matcherFires(text, parsed.spec)) continue;

    matchedTopics.push(rule.topicKey);
    // D-020: counted, never silent — and counted AFTER the fire, so the number means "a
    // seeded rule shaped this reply", not "a seeded rule exists somewhere in the table".
    if (!isTenantConfirmed(rule.provenance)) unconfirmedTopics.push(rule.topicKey);
    if (!firedGates.includes(rule.gate)) firedGates.push(rule.gate);
    if (!rule.quotePrice) refusedTopicBlocksPrice = true;
    // First enabled short-circuit wins; rules are supplied in the tenant's own order.
    if (rule.deterministicShortcircuit && shortCircuitKind === null) shortCircuitKind = rule.responseKind;
  }

  return { ok: true, firedGates, refusedTopicBlocksPrice, matchedTopics, unconfirmedTopics, shortCircuitKind };
}

export type CannedRow = { kind: string; body: string; reviewedAt: string | null };

export type CannedSection =
  | { ok: true; body: string; kinds: string[] }
  /** A line has no native-speaker sign-off. The route 503s with this code. */
  | { ok: false; code: 'canned_response_unreviewed'; kinds: string[] }
  /** The prefix names a kind this tenant has no row for. The route 503s with this too. */
  | { ok: false; code: 'canned_response_missing'; kinds: string[] };

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
 *
 * ## `required` is why that sentence is now true
 *
 * It was not. The paragraph above described the fault and the code only caught half of
 * it: an *unreviewed* row refused, an **absent** one did not. A tenant with no
 * `canned_responses` at all rendered `=== БЭЛЭН ХАРИУЛТ ===` and nothing under it, and
 * every check in the gate still ended "write the X line from that section" — nine
 * instructions pointing into an empty heading, with the model free to improvise exactly
 * as the comment warns. Found 2026-09-05 while compiling tenant #0, whose knowledge base
 * is empty; `kindsReferencedBy` existed for precisely this comparison and was called from
 * nothing but its own test.
 *
 * So the kinds the prefix names are now an argument, and a missing one refuses. The
 * parameter is required rather than defaulted: a default of `[]` would mean "nothing is
 * required", which is the bug, and a new caller that forgets it should not compile.
 */
export function renderCannedSection(
  label: string,
  rows: readonly CannedRow[],
  /** Every kind the compiled prefix names — `kindsReferencedBy(promptStable)`. */
  required: readonly string[],
): CannedSection {
  // Absence first: a row that does not exist cannot also be unreviewed, and "provision
  // these nine" is a more actionable message than "review the three you have".
  const have = new Set(rows.map((r) => r.kind));
  const missing = required.filter((k) => !have.has(k));
  if (missing.length > 0) return { ok: false, code: 'canned_response_missing', kinds: [...missing].sort() };

  const unreviewed = rows.filter((r) => r.reviewedAt === null).map((r) => r.kind);
  if (unreviewed.length > 0) return { ok: false, code: 'canned_response_unreviewed', kinds: unreviewed.sort() };

  return { ok: true, body: cannedSectionBody(label, rows), kinds: cannedKinds(rows) };
}

/** The rows, sorted by kind — the order the section is rendered in, on both sides. */
function cannedKinds(rows: readonly CannedRow[]): string[] {
  return [...rows].map((r) => r.kind).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The canned section's TEXT, with no checking of any kind.
 *
 * Split out because the same bytes are now produced in two places: at publish time, where
 * the section is rendered into the compiled prefix (D-058), and at request time, where it
 * is hashed and compared against the published copy. Two renderers would drift, and the
 * whole point of the comparison is that a difference means the rows changed — not that the
 * two code paths disagree about a trailing space.
 *
 * Sorted by kind so the section is byte-stable for a given set of rows — the database makes
 * no ordering promise, and an unstable L2 moves the cache key on every deploy. In JavaScript
 * by code point, never by the database's collation (D-026); a canned `kind` is ASCII
 * lower_snake, so the two agree today, and relying on that would be relying on an accident.
 */
export function cannedSectionBody(label: string, rows: readonly { kind: string; body: string }[]): string {
  const ordered = [...rows].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const lines = ordered.map((r) => `"${r.kind}": ${r.body.trim()}`);
  return `=== ${label} ===\n${lines.join('\n')}`;
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

/**
 * Every canned kind the TENANT'S OWN refusal rules point at.
 *
 * `kindsReferencedBy` reads the compiled prefix, so it finds the kinds the signed
 * platform blocks name — nine, today. It cannot find the kinds a tenant's rows name,
 * and that is a real hole rather than a theoretical one:
 *
 *   * `disclosure_rules` and `out_of_scope_topics` each carry a `response_kind`, and the
 *     gate text tells the model to copy the matching line out of the pinned-line section
 *     «нэг ч үсэг өөрчлөхгүйгээр» — letter for letter.
 *   * A rule's `topic_key` renders into Ш1's list as `- children_services: …`, in plain
 *     text with no straight double quotes, so `kindsReferencedBy` never sees it. Neither
 *     does it see `response_kind`, which is not rendered at all.
 *
 * So before this function existed, a tenant could carry a rule whose line was missing and
 * NOTHING refused: the gate fired, the model was told to reproduce a sentence that was not
 * in its context, and it improvised on precisely the topic the business asked never to be
 * discussed. Measured on the live project 2026-09-07 — Matrix's `photo_consultation` row
 * points at `refusal_out_of_scope` and no such row exists for that tenant.
 *
 * Unioning this into `renderCannedSection`'s required set makes that state refuse instead,
 * with the same `canned_response_missing` code and the same operator-visible 503 the
 * platform kinds already get. Over-refusing costs a retry; under-refusing costs the thing
 * the rule existed to prevent — the same trade `matchRules` makes one function up.
 *
 * An UNCONFIRMED rule (D-020) is included deliberately. It still fires, so it still needs
 * a sentence to fire into; withholding the requirement would leave the improvisation case
 * open for exactly the rows nobody has checked.
 */
export function kindsRequiredByRules(rules: readonly GateRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) if (r.responseKind !== '') out.add(r.responseKind);
  return [...out].sort();
}
