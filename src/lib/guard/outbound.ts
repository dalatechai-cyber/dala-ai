/**
 * The outbound guard (V1.md 3.4, §6.7).
 *
 * ## Why this is a real control where input filtering is not
 *
 * The sibling's audit states the position plainly about its own input filter:
 * "`sanitizeForPrompt` is a fixed-phrase regex strip and is trivially bypassed. **It is
 * not a security control and should not be treated as one.**"
 *
 * It is worse in Mongolian. An input filter cannot use `\b` or `\w`, matches or fails on
 * whether the customer's keyboard emitted NFC or NFD, and the ancestor carries a live
 * example of the resulting hole: `validator.js:201` uses the RUSSIAN vowel set, missing
 * `ө` and `ү`, so twenty-four consecutive `ү` are classified as *absence of vowels*. Any
 * input filter we write will have the same shape of hole and we will not know where.
 *
 * This guard is different in kind for one precise reason: **it checks our output against
 * our own data, both of which we control**, rather than trying to enumerate the space of
 * hostile inputs. There is no adversary inside the comparison. Either a numeral we
 * emitted is in the snapshot's `allowed_numbers` or it is not.
 *
 * ## It never edits. It refuses.
 *
 * An edited reply is an unreviewed reply. On refusal the caller sends the tenant's
 * pinned handoff line instead, writes the full attempted text to `quality_flags` for the
 * Quality layer, and increments a per-tenant, per-gate counter. Those are the caller's
 * writes; this function is pure, which is what makes every branch testable offline.
 *
 * ## Everything Mongolian here is DATA
 *
 * There is not one Mongolian string in this file. Concession stems, forbidden phrasings,
 * the allow-lists and the handoff line all arrive on `TenantGuardView`, compiled from
 * rows. That is the platform test — onboarding client #3 is filling in a config — and it
 * is also what keeps every customer-visible sentence behind its `reviewed_at` gate
 * instead of behind a code review by people who do not read Mongolian.
 */
import { ALWAYS_ON_GATES } from '../../config/platform.ts';
import { matchesStemSequence } from '../mn/match.ts';
import { containsPercentage, numeralsNotAllowed, urlsNotAllowed } from '../mn/extract.ts';
import { cpLength, fold, nfc, scriptShare } from '../mn/text.ts';

/** A boundary-gate key, `Ш0`–`Ш9`. Platform scaffold, so the ids are stable. */
export type GateKey = string;

/** An ordered stem sequence, matched within a 40-character window (§6.7b). */
export type StemSequence = readonly string[];

export type TenantGuardView = {
  /** `tenant.primary_script` — config, not a constant. Tenant #7 may be Russian-speaking. */
  primaryScript: string;
  /** Every link the tenant declared. Anything else is refused. */
  allowedUrls: readonly string[];
  /** `config_snapshots.allowed_numbers` — every numeral the model may emit. */
  allowedNumbers: readonly string[];
  /** Whether the knowledge base actually carries a promotion right now. */
  kbHasPromotion: boolean;
  /** Discount vocabulary, per vertical. A salon's differs from a garage's. */
  concessionStems: readonly string[];
  /** Forbidden phrasings, KEYED BY GATE — see the note on flattening below. */
  forbiddenStemSeqs: Readonly<Record<GateKey, readonly StemSequence[]>>;
  /** The rendered prompt, for the instruction-disclosure tripwire. */
  promptCorpus: string;
  /** Pinned lines the model is SUPPOSED to copy letter for letter. Exempt from item 4. */
  cannedResponses: readonly string[];
  /** Service names and links, excluded before the script share is computed. */
  scriptShareExclusions: readonly string[];
  /** One Messenger send, in characters. */
  maxReplyChars: number;
};

export type OutboundContext = {
  /** Gates whose inbound matcher fired on this customer message. */
  firedGates: readonly GateKey[];
  /**
   * True when a matched refusal topic has `quote_price = false`. Carried separately
   * because it is the Ш1 hole: a LISTED price is still forbidden on a refused topic.
   */
  refusedTopicBlocksPrice: boolean;
};

export type OutboundRefusal =
  | 'outbound_url'
  | 'outbound_price'
  | 'outbound_refused_topic_price'
  | 'outbound_concession'
  | 'outbound_percent'
  | 'outbound_disclosure'
  | 'outbound_language'
  | 'outbound_length'
  | 'outbound_forbidden'
  /** We could not determine whether the reply was safe. Refuse — never pass on doubt. */
  | 'outbound_undetermined';

export type GuardResult =
  | { ok: true }
  | { ok: false; code: OutboundRefusal; detail: string; gate?: GateKey };

function refuse(code: OutboundRefusal, detail: string, gate?: GateKey): GuardResult {
  return gate === undefined ? { ok: false, code, detail } : { ok: false, code, detail, gate };
}

/**
 * Shingle a corpus into overlapping runs of `n` characters, folded and
 * whitespace-collapsed so that indentation in the prompt cannot be used to evade.
 */
function shingles(text: string, n: number): Set<string> {
  const flat = fold(text).replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i += 1) out.add(chars.slice(i, i + n).join(''));
  return out;
}

/**
 * Item 4 — the instruction-disclosure tripwire. Any contiguous run of our own prompt,
 * `runLength` characters or longer, appearing in the reply.
 *
 * **The exemption is the whole difficulty.** Ш1–Ш9 all end by pinning an exact sentence
 * "to be copied letter for letter", and those sentences are in the prompt. A naive run
 * detector therefore refuses every correct refusal the gate produces. So a run that
 * lives inside a canned response is exempt — and the exemption is computed by shingling
 * the canned responses too, rather than by deleting them from the corpus, because
 * deleting them would splice unrelated text together and manufacture runs that were
 * never in the prompt at all.
 */
export function disclosesPrompt(
  reply: string,
  promptCorpus: string,
  cannedResponses: readonly string[],
  runLength = 60,
): boolean {
  const corpus = shingles(promptCorpus, runLength);
  if (corpus.size === 0) return false;
  const exempt = new Set<string>();
  for (const canned of cannedResponses) for (const s of shingles(canned, runLength)) exempt.add(s);
  for (const s of shingles(reply, runLength)) {
    if (corpus.has(s) && !exempt.has(s)) return true;
  }
  return false;
}

/**
 * Run the guard. Returns the FIRST refusal, in the section's order — which is fixed
 * deliberately, because the per-gate refusal counters are the production metric and a
 * reply that trips two checks must be attributed to the same one every time.
 */
export function outboundGuard(
  tenant: TenantGuardView,
  ctx: OutboundContext,
  reply: string,
): GuardResult {
  const text = nfc(reply);

  // 1. Every link must be one the tenant declared. An unparseable link is not one.
  const badUrls = urlsNotAllowed(text, tenant.allowedUrls);
  if (badUrls.length > 0) return refuse('outbound_url', `undeclared link: ${badUrls.join(', ')}`);

  // 2. Every numeral must appear in allowed_numbers (V1.md 3.4).
  const badNumbers = numeralsNotAllowed(text, tenant.allowedNumbers);
  if (badNumbers.length > 0) return refuse('outbound_price', `numeral not in allowed_numbers: ${badNumbers.join(', ')}`);

  // 2b. THE Ш1 HOLE. «Хүүхдийн чёлк тайралт хэд вэ?» took the price-found branch because
  //     33,000 genuinely IS in the price list — so check 2 passes it, and the two
  //     supposedly independent layers were perfectly correlated, both saying yes. On a
  //     refused topic, a listed price is still forbidden.
  if (ctx.refusedTopicBlocksPrice && numeralsNotAllowed(text, []).length > 0) {
    return refuse('outbound_refused_topic_price', 'a numeral was emitted on a topic whose rule forbids quoting a price');
  }

  // 3. Concessions. A discount that is not in the knowledge base is the salon's money.
  if (!tenant.kbHasPromotion) {
    for (const stem of tenant.concessionStems) {
      if (matchesStemSequence(text, [stem])) {
        return refuse('outbound_concession', `concession vocabulary with no promotion in the KB: ${stem}`);
      }
    }
    if (containsPercentage(text)) {
      return refuse('outbound_percent', 'a percentage with no promotion in the KB');
    }
  }

  // 4. Instruction disclosure. What leaks is THIS tenant's boundary rules — which topics
  //    are refused, that children's prices are withheld deliberately, and the exact
  //    deflection triggers. On a public comment reply that is a roadmap for the next
  //    attack, posted under the salon's brand.
  if (disclosesPrompt(text, tenant.promptCorpus, tenant.cannedResponses)) {
    return refuse('outbound_disclosure', 'a 60-character run of the system prompt appeared in the reply');
  }

  // 5. Script. The English-reply failure is a DETECTOR problem, not a prompt problem —
  //    and the rate of these refusals per tenant per week is the earliest available
  //    signal that a model version has drifted.
  let share: number | null;
  try {
    share = scriptShare(text, tenant.primaryScript, { exclude: tenant.scriptShareExclusions });
  } catch (err) {
    return refuse('outbound_undetermined', err instanceof Error ? err.message : String(err));
  }
  if (share !== null && share < 0.5) {
    return refuse('outbound_language', `only ${(share * 100).toFixed(0)}% of letters are ${tenant.primaryScript}`);
  }

  // 6. Length, in characters. Never .length, never bytes.
  if (cpLength(text) > tenant.maxReplyChars) {
    return refuse('outbound_length', `${cpLength(text)} characters exceeds ${tenant.maxReplyChars}`);
  }

  // 7. Per-GATE forbidden vocabulary — only the gates that actually fired, plus the
  //    always-on set. Keying by gate is not tidiness: flattened, «Санаа зоволтгүй» is
  //    forbidden for a health question AND fires on «Санаа зоволтгүй, зогсоол манай
  //    барилгын ард байгаа» — a perfectly good parking answer that would be replaced by
  //    the handoff line. It also destroys the per-gate boundary-hold rate the guard
  //    exists to produce, because a real breach and a benign reply increment the same
  //    counter.
  const gates = [...new Set([...ctx.firedGates, ...ALWAYS_ON_GATES])];
  for (const gate of gates) {
    for (const sequence of tenant.forbiddenStemSeqs[gate] ?? []) {
      if (matchesStemSequence(text, sequence)) {
        return refuse('outbound_forbidden', `forbidden phrasing for ${gate}: ${sequence.join(' … ')}`, gate);
      }
    }
  }

  return { ok: true };
}
