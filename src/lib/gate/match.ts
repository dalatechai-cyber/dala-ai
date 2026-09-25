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
import { containsStem, endsWithAny, hasWord, matchesStemSequence, wholeMessageMatches } from '../mn/match.ts';
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
  | { mode: 'whole_message'; phrases: readonly string[] }
  /**
   * Fires on what the message CARRIES, not on what it says (D-083).
   *
   * Every other mode reads the customer's text, which is a proxy for the thing a rule
   * actually cares about. For photographs the proxy is measurably bad in both directions:
   * «зураг явуулж болох уу?» — *may I send a picture?* — fires a refusal whose honest
   * answer is *yes, send it*; and a photograph captioned «Ийм болгож болох уу?» fires
   * nothing at all, because the caption need not contain a picture word. The second is the
   * one that costs: it is the case where the model answers about an image it cannot see.
   *
   * The kinds are Meta's own attachment types (`image`, `video`, `audio`, `file`, `fallback`
   * …), matched exactly and case-sensitively — they are ASCII identifiers from the payload,
   * never customer text, so none of rule 6's folding applies to them.
   */
  | { mode: 'has_attachment'; kinds: readonly string[] }
  /**
   * Ordered stems within a window — the mechanism `matchesStemSequence` already provides
   * for outbound forbidden phrases, exposed as a matcher so tenant rows can use it.
   *
   * It exists because `MIN_STEM_CHARS` has a cost this platform had not had to pay yet.
   * «цаг» — *appointment*, the most valuable intent a salon has — is THREE characters, and
   * it also begins «цагаан» (white), so a bare `цаг` fires booking on a colour question and
   * the floor correctly refuses it. `['цаг', 'ав']` within a window does not have that
   * problem in the same way: the ordering and the window are the specificity that the
   * length floor is a proxy for.
   *
   * **A sequence is therefore exempt from `MIN_STEM_CHARS`, and the exemption is bounded
   * rather than waived.** Each stem must still be non-empty, at least two stems are
   * required, and the window is capped — so the mode cannot be used to smuggle a single
   * short stem past the floor by pairing it with something that matches everywhere.
   *
   * What it does NOT buy: «цагаан авна» (*I will take white*) fires `['цаг', 'ав']`, because
   * «цаг» prefixes «цагаан» and «ав» prefixes «авна» nine characters later. On the comment
   * surface that costs nothing — both readings are a customer worth answering and the reply
   * is one fixed sentence either way — but anywhere the matched TOPIC selects the response,
   * it is a real mislabel. Use it where the verdict is coarse; prefer a long single stem
   * where the topic decides what is said.
   */
  | { mode: 'stem_sequence'; stems: readonly string[]; windowCp: number }
  /**
   * Whole words, not prefixes (comment classifier, D-122). Admits words below
   * `MIN_STEM_CHARS` — «ib», «pm», «хэд», «вэ» — because equality with a whole word is the
   * specificity the length floor stands in for. `?` is the one non-word entry.
   */
  | { mode: 'has_word'; words: readonly string[] }
  /** The LAST word ends with one of these — a question particle typed fused (D-122). */
  | { mode: 'ends_with'; endings: readonly string[] }
  /**
   * Every member fires. How a row says "a question AND about a service AND not praise"
   * without a code path per combination. At least two members, and nested at most
   * `MAX_MATCHER_DEPTH` deep.
   */
  | { mode: 'all_of'; matchers: readonly MatcherSpec[] }
  /**
   * The member does NOT fire. Only admissible inside `all_of`: on its own it fires on
   * almost every message, which is the unanchored matcher rule 6 forbids.
   */
  | { mode: 'not'; matcher: MatcherSpec };

/** How deep `all_of` / `not` may nest. Deeper than this is a rule nobody can review. */
export const MAX_MATCHER_DEPTH = 3;

/**
 * The widest window a `stem_sequence` may span, in code points.
 *
 * A sequence with an unbounded window degenerates into "all of these words appear
 * somewhere", which is precisely the unanchored substring matcher rule 6 forbids — and it
 * would do it while looking like a tightening. 40 is `matchesStemSequence`'s own default
 * and is roughly one Mongolian clause.
 */
export const MAX_SEQUENCE_WINDOW_CP = 40;

/**
 * What a matcher is run against.
 *
 * An object rather than a bare `text` argument so that a mode reading something other than
 * the words cannot be added without every call site being told about it. `matcherFires`
 * used to take a string, and a `has_attachment` mode bolted onto that signature would have
 * had to invent its answer from text it was never given.
 */
export type MatchSubject = {
  text: string;
  /** Attachment kinds on THIS message; empty for an ordinary text message. */
  attachments: readonly string[];
  /**
   * The same message with the tenant's known Latin spellings replaced by its words
   * (`mn/latin.ts`, D-120), or null when nothing was replaced. A matcher fires when it fires
   * on EITHER text: the spelling can only add a match, never hide what the customer wrote.
   */
  respelled?: string | null;
};

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
  /**
   * `out_of_scope_topics.grounded_only` (`0041`). When this rule fires, the reply may say
   * only what the tenant's own data says; anything else is replaced by `responseKind`.
   *
   * Optional, and absent means false: that is the behaviour before the column existed and
   * the direction in which a construction site that forgot it is harmless — the rule still
   * fires and still selects its refusal, it simply does not police the model's grounding.
   */
  groundedOnly?: boolean;
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
  const parsed = parseMatcherAt(raw, 0);
  if (parsed.ok && parsed.spec.mode === 'not') {
    return { ok: false, detail: 'a bare "not" fires on almost every message; use it inside all_of' };
  }
  return parsed;
}

function parseMatcherAt(raw: unknown, depth: number): ParseResult {
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

  if (mode === 'has_attachment') {
    const kinds = o['kinds'];
    if (!Array.isArray(kinds) || kinds.length === 0) return { ok: false, detail: 'has_attachment needs a non-empty kinds array' };
    // ascii-safe: an attachment kind is Meta's own identifier from the payload, not text a
    // customer typed, so MIN_STEM_CHARS and the Cyrillic folding rules do not apply.
    if (kinds.some((k) => typeof k !== 'string' || k.trim() === '')) return { ok: false, detail: 'an attachment kind is not a non-empty string' };
    return { ok: true, spec: { mode: 'has_attachment', kinds: kinds as string[] } };
  }

  if (mode === 'stem_sequence') {
    const stems = o['stems'];
    if (!Array.isArray(stems) || stems.length < 2) {
      // One stem in a sequence is a `contains_stem` that has escaped the length floor.
      // Refusing it here is the whole reason the exemption above is safe to grant.
      return { ok: false, detail: 'stem_sequence needs at least two stems; one stem is contains_stem without the floor' };
    }
    if (stems.some((s) => typeof s !== 'string' || s.trim() === '')) {
      return { ok: false, detail: 'a stem is not a non-empty string' };
    }
    const raw = o['windowCp'];
    // Absent means the default, not zero. A zero window matches nothing and would read as
    // a rule that is switched off rather than one that is malformed.
    const windowCp = raw === undefined || raw === null ? MAX_SEQUENCE_WINDOW_CP : raw;
    if (typeof windowCp !== 'number' || !Number.isInteger(windowCp) || windowCp < 1) {
      return { ok: false, detail: 'windowCp must be a positive integer' };
    }
    if (windowCp > MAX_SEQUENCE_WINDOW_CP) {
      return { ok: false, detail: `windowCp ${windowCp} exceeds ${MAX_SEQUENCE_WINDOW_CP}: an unbounded window is an unanchored matcher wearing a tightening's clothes` };
    }
    return { ok: true, spec: { mode: 'stem_sequence', stems: stems as string[], windowCp } };
  }

  if (mode === 'has_word') {
    const words = o['words'];
    if (!Array.isArray(words) || words.length === 0) return { ok: false, detail: 'has_word needs a non-empty words array' };
    if (words.some((w) => typeof w !== 'string' || w.trim() === '')) return { ok: false, detail: 'a word is not a non-empty string' };
    return { ok: true, spec: { mode: 'has_word', words: words as string[] } };
  }

  if (mode === 'ends_with') {
    const endings = o['endings'];
    if (!Array.isArray(endings) || endings.length === 0) return { ok: false, detail: 'ends_with needs a non-empty endings array' };
    if (endings.some((e) => typeof e !== 'string' || e.trim() === '')) return { ok: false, detail: 'an ending is not a non-empty string' };
    // One letter is the last letter of half the words in the language.
    const short = (endings as string[]).filter((e) => cpLength(e.trim()) < 2);
    if (short.length > 0) return { ok: false, detail: `endings shorter than 2 characters match almost anything: ${short.join(', ')}` };
    return { ok: true, spec: { mode: 'ends_with', endings: endings as string[] } };
  }

  if (mode === 'all_of' || mode === 'not') {
    if (depth >= MAX_MATCHER_DEPTH) return { ok: false, detail: `matchers nest deeper than ${MAX_MATCHER_DEPTH}` };
    if (mode === 'not') {
      const inner = parseMatcherAt(o['matcher'], depth + 1);
      if (!inner.ok) return { ok: false, detail: `not: ${inner.detail}` };
      return { ok: true, spec: { mode: 'not', matcher: inner.spec } };
    }
    const members = o['matchers'];
    if (!Array.isArray(members) || members.length < 2) {
      return { ok: false, detail: 'all_of needs at least two matchers; one is just that matcher' };
    }
    const specs: MatcherSpec[] = [];
    for (const m of members) {
      const inner = parseMatcherAt(m, depth + 1);
      if (!inner.ok) return { ok: false, detail: `all_of: ${inner.detail}` };
      specs.push(inner.spec);
    }
    // All members negative is a bare "not" with extra steps.
    if (specs.every((sp) => sp.mode === 'not')) {
      return { ok: false, detail: 'all_of needs at least one positive member; only "not" members fire on almost everything' };
    }
    return { ok: true, spec: { mode: 'all_of', matchers: specs } };
  }

  return { ok: false, detail: `unknown matcher mode ${JSON.stringify(mode)}` };
}

/**
 * Every piece of customer-facing vocabulary a matcher carries, through any nesting — for
 * reviewers that ask "does this rule list a Latin spelling?" (provision/validate.ts).
 * Negated members are included: a spelling in a `not` is still vocabulary somebody chose.
 */
export function matcherTerms(spec: MatcherSpec): string[] {
  switch (spec.mode) {
    case 'contains_stem': case 'stem_sequence': return [...spec.stems];
    case 'whole_message': return [...spec.phrases];
    case 'has_word': return spec.words.filter((w) => w !== '?');
    case 'ends_with': return [...spec.endings];
    case 'has_attachment': return [];
    case 'all_of': return spec.matchers.flatMap(matcherTerms);
    case 'not': return matcherTerms(spec.matcher);
  }
}

/** Does one parsed matcher fire on this message? */
export function matcherFires(subject: MatchSubject, spec: MatcherSpec): boolean {
  if (spec.mode === 'has_attachment') return subject.attachments.some((a) => spec.kinds.includes(a));
  if (spec.mode === 'all_of') return spec.matchers.every((m) => matcherFires(subject, m));
  if (spec.mode === 'not') return !matcherFires(subject, spec.matcher);
  const texts = subject.respelled === undefined || subject.respelled === null
    ? [subject.text] : [subject.text, subject.respelled];
  return texts.some((text) => {
    if (spec.mode === 'whole_message') return wholeMessageMatches(text, spec.phrases);
    if (spec.mode === 'stem_sequence') return matchesStemSequence(text, spec.stems, spec.windowCp);
    if (spec.mode === 'has_word') return hasWord(text, spec.words);
    if (spec.mode === 'ends_with') return endsWithAny(text, spec.endings);
    return spec.stems.some((stem) => containsStem(text, stem));
  });
}

export type MatchOutcome =
  | {
      ok: true;
      /** Gates whose matcher fired. Feeds `OutboundContext.firedGates`. */
      firedGates: GateKey[];
      /** True when any matched rule forbids quoting a price. Feeds check 2b. */
      refusedTopicBlocksPrice: boolean;
      /**
       * WHICH rules did that, so the refusal can name them.
       *
       * Derived, never set independently: `refusedTopicBlocksPrice` is this array being
       * non-empty. Two fields that can disagree about the same fact is how a flag comes
       * to describe a cause that did not happen, and diagnosing 2026-09-21's turn 14
       * meant reading ten rows of `out_of_scope_topics` by hand to learn which of them
       * had emptied the allow-list — twenty minutes for a fact the guard knew and threw
       * away.
       */
      priceBlockingTopics: string[];
      /** Topic keys that matched, for the alert and the quality flag. */
      matchedTopics: string[];
      /**
       * The `response_kind` of every rule that fired, in the tenant's own rule order.
       *
       * Founder's rule, 2026-09-21: *"When a question is refused, serve the reviewed
       * reply for it, never the generic handoff. Customers must see the refusal line
       * written for that question."* Measured turn 14 of the same day: a suitability
       * question was refused and the customer got «Уучлаарай, би энэ асуултад хариулж
       * чадахгүй байна…» while the tenant's own `refusal_suitability` row — written for
       * exactly that question — sat reviewed and unused.
       *
       * Order is the tenant's, not this function's: rules arrive in the caller's order
       * and the first that fired is the most specific thing we know about the message.
       * Duplicates are collapsed so one kind matching twice does not outrank another.
       */
      matchedResponseKinds: string[];
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
      /**
       * The first fired `grounded_only` rule: the refusal to serve when the model's reply
       * says something the tenant's data does not, and whether that refusal may carry the
       * price rows the reply quoted. Null when no such rule fired.
       */
      grounded: { kind: string; quotePrice: boolean } | null;
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
export function matchRules(subject: MatchSubject, rules: readonly GateRule[]): MatchOutcome {
  const firedGates: GateKey[] = [];
  const matchedTopics: string[] = [];
  const unconfirmedTopics: string[] = [];
  const priceBlockingTopics: string[] = [];
  const matchedResponseKinds: string[] = [];
  let shortCircuitKind: string | null = null;
  let grounded: { kind: string; quotePrice: boolean } | null = null;

  for (const rule of rules) {
    const parsed = parseMatcher(rule.matcher);
    if (!parsed.ok) {
      return { ok: false, detail: `rule ${rule.topicKey} (${rule.gate}): ${parsed.detail}` };
    }
    if (!matcherFires(subject, parsed.spec)) continue;

    matchedTopics.push(rule.topicKey);
    // D-020: counted, never silent — and counted AFTER the fire, so the number means "a
    // seeded rule shaped this reply", not "a seeded rule exists somewhere in the table".
    if (!isTenantConfirmed(rule.provenance)) unconfirmedTopics.push(rule.topicKey);
    if (!firedGates.includes(rule.gate)) firedGates.push(rule.gate);
    if (!rule.quotePrice) priceBlockingTopics.push(rule.topicKey);
    // Collapsed, order preserved: the FIRST firing of a kind is what ranks it.
    if (rule.responseKind !== '' && !matchedResponseKinds.includes(rule.responseKind)) {
      matchedResponseKinds.push(rule.responseKind);
    }
    // First enabled short-circuit wins; rules are supplied in the tenant's own order.
    if (rule.deterministicShortcircuit && shortCircuitKind === null) shortCircuitKind = rule.responseKind;
    if (rule.groundedOnly === true && grounded === null && rule.responseKind !== '') {
      grounded = { kind: rule.responseKind, quotePrice: rule.quotePrice };
    }
  }

  return {
    ok: true,
    firedGates,
    // Derived rather than tracked, so the boolean cannot outlive the reason for it.
    refusedTopicBlocksPrice: priceBlockingTopics.length > 0,
    priceBlockingTopics,
    matchedTopics,
    matchedResponseKinds,
    unconfirmedTopics,
    shortCircuitKind,
    grounded,
  };
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
 * Canned kinds the model is never asked to produce, and so must never be shown.
 *
 * `image_received` is served whole by `inbound/imageReply.ts`, on a path that never calls
 * the model at all — a photograph with no caption carries no text, so there is nothing to
 * reason about and nothing to choose. D-058 swept every `canned_responses` row into the
 * cached prefix without asking which of them the model is supposed to reach for, and this
 * one had no business being there.
 *
 * **The cost was measured, not predicted** (2026-09-17, D-082). At 02:07:23 a customer
 * asked, in Latin-script Mongolian and with no photograph anywhere in the conversation —
 * `quality_flags` holds zero `inbound_dropped` rows for it — whether the salon would pick
 * a colour for them. The reply opened «Уучлаарай, зурган дээр үндэслэн зохих өнгөний
 * зөвлөгөө өгөх боломж надад байхгүй байна»: *I cannot advise on a colour based on a
 * picture*. The only picture in that conversation was in the prompt.
 *
 * The rule generalises past this one kind, which is why it is a list and not an `if`: a
 * line the platform serves WITHOUT the model is not an instruction to the model, it is a
 * fact about the platform — and a fact about the platform sitting in the model's context is
 * something the model will eventually find a use for. D-065's lesson from the other side:
 * an instruction is a request, but a sentence is an offer.
 *
 * **Filtered here, inside the one renderer both paths call**, and that placement is the
 * load-bearing part. `sections.ts` hashes this output into `canned_hash` at publish time and
 * `reception/load.ts` recomputes it per request; filtering at either caller instead would
 * move the hash on one side only and 503 every reply with `canned_stale` — the exact outage
 * the shared-renderer rule was written to prevent (D-058).
 *
 * It does NOT filter the review gate. `renderCannedSection` still refuses the whole section
 * when an `image_received` row is unreviewed, because that is a question about the row, not
 * about the prompt, and `imageReply.ts` refuses an unreviewed row independently.
 *
 * ## `comment_public_reply` is the second member, and it is the generalisation landing
 *
 * `worker/comments.ts` posts that row's bytes and never calls a model — `decideCommentReply`
 * returns `body: line.body`, and the only field carrying anything about the comment's text
 * is a four-value enum that gates whether the line is sent, never which sentence. So it is
 * a fact about the platform, exactly as `image_received` is.
 *
 * Two distinct costs, both real, and the first is an outage rather than a quality problem:
 *
 *   1. Unfiltered, adding the row MOVES `canned_hash` — and a live snapshot published
 *      before it was added no longer matches, so every DM reply for that tenant 503s with
 *      `canned_stale` until a republish. The filter has to be DEPLOYED BEFORE the row is
 *      inserted; the other order is the D-058 outage with a different sentence in it.
 *   2. The line says «Мессеж бичээрэй» — *write us a message*. Offered to a model that is
 *      already answering a message, in a DM, it is D-082's `refusal_public_channel` defect
 *      rebuilt out of a different row: telling somebody who is already in the inbox to go
 *      to the inbox.
 *
 * `readPinnedLine` reads the row straight from the database, like `readImageLine`, so
 * filtering it out of the cached section takes nothing away from the path that serves it.
 *
 * ## The handover pair joins on the same argument, BEFORE either row exists
 *
 * `handover_notice` goes out with a pass and `handover_reclaim` when the reclaim window
 * expires; both are served whole by `handover/`, neither is named by any gate block, and
 * no model ever chooses between them. So they belong here on the same reasoning.
 *
 * They are listed while `canned_response_kinds` has just gained them and no tenant has a
 * ROW, and that order is the point rather than an accident. Cost 1 above is an ordering
 * constraint: the filter must be deployed BEFORE the first row is inserted, or the row
 * sweeps into the cached prefix, moves `canned_hash` on the publish side only, and 503s
 * every DM reply for that tenant until a republish. Shipping the filter early is free;
 * shipping it late is an outage.
 */
export const MODEL_INVISIBLE_KINDS: readonly string[] = [
  'image_received', 'comment_public_reply', 'comment_private_reply', 'handover_notice', 'handover_reclaim',
  // D-125. Served by `handleReception` when a reply depends on a branch the customer has not
  // named; the model is never asked to choose it. Listed while `0047` registers the kind and
  // no tenant has a row — the same order the handover pair was shipped in, for the same
  // reason: a row inserted before the filter moves `canned_hash` and 503s every DM reply.
  'clarify_branch',
];

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
  const shown = rows.filter((r) => !MODEL_INVISIBLE_KINDS.includes(r.kind));
  const ordered = [...shown].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
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
  for (const body of blockBodies) for (const m of body.matchAll(/"([a-z][a-z_]*)"/g)) out.add(m[1] ?? ''); // ascii-safe: canned kinds are lower_snake ASCII
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
