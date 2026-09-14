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
import { containsPercentage, extractNumerals, numeralsNotAllowed, urlsNotAllowed } from '../mn/extract.ts';
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
  /**
   * The customer's own message. A numeral THEY wrote may be echoed back when confirming
   * or asking about that same value; the model still may not introduce one of its own.
   *
   * It is the raw text rather than a pre-extracted list on purpose: the guard runs
   * `extractNumerals` over both sides itself, so the two sets are produced by the same
   * tokenizer. A caller that extracted with its own rule could hand over «33 000» as two
   * numerals while the guard reads the reply's as one, and the echo would silently fail
   * to match — a false refusal with no cause a reader could find.
   *
   * Scope is the caller's to widen. Today the worker passes the current inbound message;
   * joining earlier customer turns would extend the echo to values stated earlier in the
   * conversation, which is a product decision rather than a code change.
   */
  customerText: string;
};

export type OutboundRefusal =
  | 'outbound_url'
  | 'outbound_price'
  | 'outbound_refused_topic_price'
  | 'outbound_concession'
  | 'outbound_percent'
  | 'outbound_disclosure'
  /** A gate's own label — «Ш0», «Ш1» — appeared in a customer-facing reply. */
  | 'outbound_gate_label'
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
 * Item 0 — a gate's own LABEL in a customer-facing reply.
 *
 * Measured on Matrix, 2026-09-14, on the mirror's second turn. The customer asked
 * «будаг хэдээр хийх вэ» and the model began its reply:
 *
 *     Ш0 (сувагтай холбоотой шалгалт): Энэ бол facebook_page буюу нийтэд харагдах
 *     сувагтай тул үнийн мэдээллийг нийтэд бичих боломжгүй.
 *
 * It narrated the gate structure to the customer, named the internal channel identifier,
 * and then reached for `refusal_public_channel` — on a Messenger DM, which is not a public
 * channel at all.
 *
 * ## Neither existing check could see it, and one of them caught it by accident
 *
 * `disclosesPrompt` looks for a contiguous 60-character run of the prompt. This is a
 * PARAPHRASE of Ш0's substance in the model's own words, so the run detector cannot match
 * it — by construction, not by oversight. It is D-065's shape again: an exact-match check
 * defeated by a near-copy.
 *
 * What actually refused the reply was the NUMERAL guard, objecting to the `0` in «Ш0»
 * because zero is not in Matrix's `allowed_numbers`. That is luck, and it is measurably
 * thin luck: Matrix's live snapshot allows twelve numerals and **`1` and `3` are two of
 * them**. So «Ш1 …» and «Ш3 …» — the forbidden-topics block and the booking block, the two
 * whose disclosure matters most — would have passed every check in this file and been
 * drafted for a customer.
 *
 * ## The shape, not the content
 *
 * The content is paraphrasable and the label is not. A gate label is a closed set of
 * tokens that exist only inside this platform's prompt; no Mongolian sentence a salon
 * would send contains «Ш» immediately followed by a digit and a label's punctuation. So
 * this matches the shape and leaves the words alone, which is why it cannot be talked
 * around the way the run detector can.
 *
 * Deliberately NOT folded or whitespace-collapsed like `shingles`: evasion is not the
 * threat here. The model is not trying to hide a label — it is narrating its instructions
 * because it thinks that is helpful — so the literal form is the form that appears.
 */
const GATE_LABEL = /Ш\d{1,2}\s*[.:)(]/u;

export function namesAGate(reply: string): string | null {
  const m = GATE_LABEL.exec(nfc(reply));
  return m === null ? null : m[0];
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

  // 0. A GATE'S OWN LABEL, before anything else.
  //
  //    This runs first and that is a deliberate change to the attribution order this
  //    docstring pins. A reply carrying «Ш0» or «Ш1» is disclosing the platform's own
  //    structure, and that is the finding whatever else is also wrong with it — the one
  //    real instance was recorded as `outbound_price`, which sent a reader looking at the
  //    allow-list for a leak that had nothing to do with numerals. Only replies containing
  //    a gate label are re-attributed, and for those the old code was misleading.
  const label = namesAGate(text);
  if (label !== null) {
    return refuse('outbound_gate_label', `the reply names a gate block: ${label.trim()}`);
  }

  // 1. Every link must be one the tenant declared. An unparseable link is not one.
  const badUrls = urlsNotAllowed(text, tenant.allowedUrls);
  if (badUrls.length > 0) return refuse('outbound_url', `undeclared link: ${badUrls.join(', ')}`);

  // 2. Every numeral must be one the tenant compiled, OR one the customer themselves
  //    wrote. The model may CONFIRM a value put in front of it; it may not INTRODUCE one.
  //
  //    «Маргааш 15:00 цагт болох уу?» — the time is the customer's own, and answering
  //    «15:00 цагт болно» is the whole point of the conversation. Under the strict
  //    reading that reply was refused and the customer got the handoff line instead,
  //    which is a worse product for no safety gained: the numeral was already on the
  //    screen, written by them.
  //
  //    What this does NOT relax: a numeral in neither set is still refused, so the model
  //    cannot invent a price, a phone number or an opening hour. And 2b below is
  //    deliberately not given the echo set — see there.
  const echoed = extractNumerals(ctx.customerText).map((n) => n.raw);
  const badNumbers = numeralsNotAllowed(text, [...tenant.allowedNumbers, ...echoed]);
  if (badNumbers.length > 0) {
    return refuse('outbound_price', `numeral neither compiled nor stated by the customer: ${badNumbers.join(', ')}`);
  }

  // 2b. THE Ш1 HOLE, and the echo allowance stops at its door.
  //
  //     «Хүүхдийн чёлк тайралт хэд вэ?» took the price-found branch because 33,000
  //     genuinely IS in the price list — so check 2 passes it, and the two supposedly
  //     independent layers were perfectly correlated, both saying yes.
  //
  //     This check is passed an EMPTY allow-list, so neither `allowed_numbers` nor the
  //     customer's own numerals can satisfy it. On a refused topic Ш1 says to mention no
  //     number at all, whatever its provenance — and a customer who writes
  //     «Хүүхдийн үс 33,000₮ мөн үү?» has supplied the number that would make an echo
  //     read as confirmation of exactly the thing the topic exists to refuse.
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
