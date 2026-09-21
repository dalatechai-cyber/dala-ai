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
import { containsPercentage, extractNumerals, maskUrls, numeralsNotAllowed, urlsNotAllowed } from '../mn/extract.ts';
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
   * The topic keys that set the flag above, named in the refusal so the `quality_flags`
   * row says WHICH rule fired rather than only that one did.
   *
   * Optional because every existing caller predates it and a missing name must not
   * change a verdict — the refusal still happens, it just reads `unknown rule`. It is a
   * diagnosis, never an input to the decision.
   */
  priceBlockingTopics?: readonly string[];
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
 * The single normalisation every side of the run detector uses: folded, whitespace
 * collapsed and trimmed, so indentation in the prompt cannot be used to evade.
 *
 * Extracted because the reply is now cut into segments before being shingled, and the cut
 * has to happen on the SAME normalised text the corpus was built from. Two spellings of
 * "folded" here is how the halves would drift apart.
 */
function foldFlat(text: string): string {
  return fold(text).replace(/\s+/gu, ' ').trim();
}

/** Overlapping runs of `n` characters over text that is ALREADY folded and flattened. */
function shinglesOfFlat(flat: string, n: number): Set<string> {
  const chars = Array.from(flat);
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i += 1) out.add(chars.slice(i, i + n).join(''));
  return out;
}

/** Shingle a corpus into overlapping runs of `n` characters. */
function shingles(text: string, n: number): Set<string> {
  return shinglesOfFlat(foldFlat(text), n);
}

/**
 * Code-point `indexOf`. Never UTF-16 offsets.
 *
 * `String.prototype.indexOf` counts UTF-16 units while `shingles` counts code points, and
 * the two agree right up until an emoji appears — which they do, in five of the mirror's
 * first ten drafts. Mixing the two index spaces would cut a segment half a surrogate pair
 * out of position and quietly change what the guard examines.
 */
function indexOfCodePoints(hay: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0) return -1;
  for (let i = from; i + needle.length <= hay.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) { hit = false; break; }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * Cut the folded reply at every occurrence of a folded canned line, and return what is
 * left BETWEEN them — never joined back together.
 *
 * ## Why segments rather than deletion (D-068)
 *
 * `disclosesPrompt`'s own docstring already states the rule for the corpus side: the
 * canned lines are shingled rather than DELETED from the prompt, because deleting them
 * splices unrelated text together and manufactures runs that were never there. That
 * reasoning is right, and it was applied to one side only.
 *
 * The same boundary problem lives on the reply side. The prompt holds an approved line IN
 * CONTEXT, preceded by whatever renders before it — which folds to a space. Shingling that
 * line in isolation can never produce a window beginning one character earlier, so any
 * window straddling the line's opening boundary is in the corpus and absent from the
 * exemption. Measured live on 2026-09-14: the offending run was
 * `" та манай вэбсайтаар (https://www.matrixecosalon.org/) онлай"`, and **the leading space
 * was the whole bug**. The reply was a good one, and the customer got the generic handoff.
 *
 * So the occurrences are cut out and each remaining piece is shingled on its own. A run
 * can no longer straddle a boundary, because the boundary is where a segment ends — and
 * the pieces are never concatenated, for exactly the reason the corpus side is not.
 *
 * Overlapping and repeated occurrences are all collected and then merged, so a line quoted
 * twice, or two canned lines that share a tail, cut correctly rather than by whichever was
 * found first.
 */
export function segmentsAroundCanned(replyFlat: string, cannedFlat: readonly string[]): string[] {
  const hay = Array.from(replyFlat);
  const ranges: [number, number][] = [];
  for (const canned of cannedFlat) {
    const needle = Array.from(canned);
    if (needle.length === 0) continue;
    // `from = at + 1`, not `at + needle.length`: overlapping occurrences are all recorded,
    // and the merge below is what resolves them.
    for (let at = indexOfCodePoints(hay, needle, 0); at !== -1; at = indexOfCodePoints(hay, needle, at + 1)) {
      ranges.push([at, at + needle.length]);
    }
  }
  if (ranges.length === 0) return [replyFlat];

  // Numeric, so no locale is involved (D-026).
  ranges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const segments: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push(hay.slice(cursor, start).join(''));
    if (end > cursor) cursor = end;
  }
  if (cursor < hay.length) segments.push(hay.slice(cursor).join(''));
  return segments;
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
 *
 * ## Two halves, because the boundary problem exists on both sides (D-068)
 *
 * The paragraph above was applied to the CORPUS and not to the REPLY, and that asymmetry
 * had a live cost. The prompt holds each approved line in context, preceded by something
 * that folds to a space; shingling the line in isolation can never produce a window
 * beginning one character earlier; so a window straddling the line's opening boundary is
 * in the corpus and missing from the exemption. On 2026-09-14 a customer wrote «tsag avii»
 * and got a good reply — a refusal of what the bot cannot do, the reason, and the reviewed
 * `booking_line` reproduced correctly — and this function threw it away over
 * `" та манай вэбсайтаар (https://www.matrixecosalon.org/) онлай"`. A leading space.
 *
 * Only a reply that was EXACTLY a canned line, alone, was reliably safe, which is the
 * opposite of what the guard is for: composing around an approved line is what a helpful
 * answer does, and it landed hardest on booking, the intent D-042 already shows this
 * platform delivers worst.
 *
 * So the reply is cut at its canned occurrences and each segment is shingled on its own
 * (`segmentsAroundCanned`), and the shingle exemption is KEPT as well. They cover
 * different things and removing either would give something back: the segments handle an
 * exact quotation in context, and the exemption still handles a near-copy that the cut
 * cannot find — D-065's paraphrase, which `gate/pinned.ts` corrects but which reaches this
 * function first.
 *
 * ## What this deliberately loosens
 *
 * ## The same boundary, at the other end (2026-09-16)
 *
 * D-068 was the LEADING space. On 2026-09-16 at 11:26:29 the trailing one cost a reply
 * too, and the cut could not help because the model had ADAPTED the line rather than
 * quoted it: it wrote «Шулуун химийн үнийн мэдээлэл надад байхгүй байна…» where the
 * approved row says «Уучлаарай, энэ үйлчилгээний …». Naming the service the customer had
 * actually asked about is BETTER than the row, and the reply was refused for it.
 *
 * Measured, per approved line rather than against them concatenated: of the reply's 104
 * windows, 23 were in the corpus and 22 of those sat inside `refusal_price_unlisted`. The
 * single offender was `"…байхгүй байна. та 7741-7777 дугаараар холбогдож лавлана уу. "` —
 * the approved sentence to its last full stop, plus ONE SPACE of the model's own text.
 *
 * So the exemption is padded by one space at each end. The give is small and worth
 * stating: a disclosure must now consist of `runLength` characters that are not an
 * approved line bordered by whitespace. It buys back every reply that continues after
 * quoting one, which is what a helpful answer does.
 *
 * (The diagnostic that first missed this joined the canned bodies into one string and
 * matched against that, which manufactured a window spanning two unrelated lines and
 * reported zero offenders — the very splice this function refuses to perform on the
 * corpus, committed in the tool used to investigate it.)
 *
 * A disclosure now has to be `runLength` characters long WITHIN one segment. Text on
 * either side of a quoted approved line is no longer joined across it — which is the fix —
 * and in exchange a reply that interleaved a full canned line between every fifty-nine
 * characters of prompt would evade the run detector. That is a real hole and a very narrow
 * one: the model is not an adversary here, it is being helpful, and the alternative is the
 * measured behaviour of discarding correct answers to the most commercially valuable
 * question a salon receives. Items 0, 1, 2 and 7 are unaffected and still run.
 */
export function disclosesPrompt(
  reply: string,
  promptCorpus: string,
  cannedResponses: readonly string[],
  runLength = 60,
): boolean {
  return disclosureWindows(reply, promptCorpus, cannedResponses, runLength).length > 0;
}

/**
 * The offending runs themselves, in the order the reply carries them.
 *
 * `disclosesPrompt` is this, reduced to a boolean. They are one function because the
 * alternative — a diagnostic that reimplements the matching — is the mistake D-077 made
 * inside the tool built to investigate D-077: that one joined the canned bodies into a
 * single string, manufactured a window across two unrelated lines, and reported zero
 * offenders. A second implementation of a check answers a different question than the
 * check does, and it is most convincing exactly when it is wrong.
 *
 * ## Why the guard needs this and not just the boolean
 *
 * `quality_flags` recorded `a 60-character run of the system prompt appeared in the reply`
 * and did not say WHICH run. On 2026-09-18 a reply was refused that had answered the
 * customer correctly from the tenant's own knowledge base, and finding the window from the
 * outside took a long sequence of guesses against the live snapshot — three of which were
 * wrong. The guard knows the answer at the moment it refuses; it was throwing it away.
 * A detector that says "something matched" and not "this matched" costs an investigation
 * every time it fires.
 *
 * Returns folded text, which is what was actually compared — not a slice of the original
 * reply. Folding is why a window can look unfamiliar next to the sentence it came from,
 * and reporting the pre-fold text would hide the very transformation that produced the
 * match.
 */
export function disclosureWindows(
  reply: string,
  promptCorpus: string,
  cannedResponses: readonly string[],
  runLength = 60,
): string[] {
  const corpus = shingles(promptCorpus, runLength);
  if (corpus.size === 0) return [];

  const exempt = new Set<string>();
  for (const canned of cannedResponses) {
    for (const s of shingles(canned, runLength)) exempt.add(s);
    // ONE character past either end, and no further. See the boundary note above: the
    // exemption is built per line, so it can never hold a window that reaches beyond the
    // line's own last character — while the CORPUS holds that line in context and does.
    // A reply that carries on after an approved sentence therefore produces a window of
    // 59 approved characters plus one space, which is in the corpus and in no approved
    // line. Padding with the space `foldFlat` would have put there covers exactly that
    // case at both ends and nothing else.
    const padded = foldFlat(canned);
    if (padded !== '') for (const s of shinglesOfFlat(` ${padded} `, runLength)) exempt.add(s);
  }

  const cannedFlat = cannedResponses.map(foldFlat).filter((c) => c !== '');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const segment of segmentsAroundCanned(foldFlat(reply), cannedFlat)) {
    for (const s of shinglesOfFlat(segment, runLength)) {
      if (corpus.has(s) && !exempt.has(s) && !seen.has(s)) { seen.add(s); found.push(s); }
    }
  }
  return found;
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
 *
 * ## A standalone TOKEN, and why not `\b`
 *
 * The first version of this required the label's punctuation — `Ш\d{1,2}\s*[.:)(]` — and
 * matched the real leak «Ш0 (» and a heading «Ш1.». Re-read adversarially before merging, it
 * misses «Ш1 дүрмээр…», a label written as an ordinary word, which is at least as likely a
 * way for the model to narrate.
 *
 * `\b` is the obvious repair and is forbidden by CLAUDE.md rule 6, for a reason visible
 * right here: `\b` is defined against ASCII `\w`, so between `1` and the Cyrillic `д` it
 * reports a word boundary — the matcher would behave differently in Mongolian than in
 * English on the one platform where everything is Mongolian.
 *
 * So the bound is Unicode-aware and explicit: not preceded by a letter or digit, not
 * followed by one. «Шампунь» has no digit; «Ш2маск» has a letter after the digit and could
 * be a tenant's product name; «АШ1» has a letter before. None of those match, and a label
 * standing on its own always does.
 */
const GATE_LABEL = /(?<![\p{L}\p{N}])Ш\d{1,2}(?![\p{L}\p{N}])/u;

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
  // Masked on this side too: a customer who pastes a link has not thereby approved the
  // digits in its slug, and the echo set must be produced by the same rule the reply is
  // measured against or the two silently disagree about what a numeral is.
  const echoed = extractNumerals(maskUrls(ctx.customerText)).map((n) => n.raw);
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
    // Name the rule. Sorted by code unit — deterministic, no locale (D-026), and the
    // set is a handful of keys so the cost is nothing. Without this the flag says a
    // topic rule fired and leaves the reader to find which one across two tables.
    const named = [...(ctx.priceBlockingTopics ?? [])].sort().join(', ') || 'unknown rule';
    return refuse(
      'outbound_refused_topic_price',
      `a numeral was emitted on a topic whose rule forbids quoting a price: ${named}`,
    );
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
