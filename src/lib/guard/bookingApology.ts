/**
 * A booking reply does not open by apologising.
 *
 * Founder, 2026-09-21: *"«tsag zahialah» opens with «Уучлаарай, би шууд цаг захиалж…
 * боломжгүй». Drop the apology, and state the deposit plus the booking link, like the
 * ancestor does."* Then, after the instruction failed: *"The booking apology: if the
 * instruction can't remove it, the platform must stop it from reaching the customer."*
 *
 * ## Three instructions failed, and the third failed while saying the exact words
 *
 * `prompt/drafts/sh3_booking_deposit.mn.txt` contains «УУЧЛАЛТ БҮҮ ГУЙ» — *do not
 * apologise* — and names «Уучлаарай» as forbidden. Measured over five runs of «tsag
 * zahialah» with that draft ACTIVE in the prompt, the reply still opened «Уучлаарай»
 * **three times in five**. D-065's rule, arriving for the fourth time: an instruction to
 * the model is a request until something checks it.
 *
 * So the platform checks, and the shape of the check follows `gate/pinned.ts`: it does not
 * EDIT the reply — deleting the first sentence would leave an unreviewed remainder — it
 * discards the model's text whole and serves bytes that are already approved.
 *
 * ## What is served, and why it needs no new Mongolian
 *
 * The deposit rows from «УРЬДЧИЛГАА ТӨЛБӨР», verbatim from the compiled prefix, then the
 * reviewed `booking_line`. Both already exist: the deposits are the tenant's data and the
 * booking line carries `reviewed_at`. Nothing here composes a sentence, so nothing here
 * needs the founder's signature — which is the only reason it could be built tonight.
 *
 * That is also exactly what he asked the reply to be: the deposit, then the link.
 *
 * ## Scope, and why it is narrow
 *
 * «Уучлаарай» is RIGHT in a refusal — every `refusal_*` row opens with it. So this fires
 * only when the reply is a booking answer, evidenced by it carrying the booking line
 * itself, and only when the apology is in the FIRST sentence. A booking reply that
 * apologises in its third sentence for something else is left alone: this is about the
 * opening a customer reads first, which is what the founder objected to.
 *
 * Rule 6: NFC-folded, code points, no `\b`, no `[a-z]`. The apology test is an exact word
 * over the MODEL's own reply, never over customer text.
 */
import { fold } from '../mn/text.ts';

/** Enough of the booking line to identify it when the model has wrapped prose around it. */
const MIN_BOOKING_OVERLAP = 0.6;

/** Sentence terminators that end the opening a customer reads first. */
const SENTENCE_END = /[.!?。！？\n]/u;

function firstSentence(text: string): string {
  const i = text.search(SENTENCE_END);
  return i === -1 ? text : text.slice(0, i);
}

/**
 * Longest common run between two folded strings, as a fraction of the shorter.
 *
 * Deliberately a RUN and not an edit distance: D-077's rule is that the mechanism deciding
 * whether an approved sentence is present asks exact questions. A contiguous run either is
 * or is not there.
 */
function containsMostOf(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  if (haystack.includes(needle)) return true;
  const want = Math.ceil([...needle].length * MIN_BOOKING_OVERLAP);
  const chars = [...needle];
  for (let start = 0; start + want <= chars.length; start += 1) {
    if (haystack.includes(chars.slice(start, start + want).join(''))) return true;
  }
  return false;
}

export type BookingVerdict =
  | { apologises: false }
  | { apologises: true; opening: string };

/**
 * Does this reply carry the booking line AND open with an apology?
 *
 * `apologyStems` are the tenant's own — passed in rather than hard-coded. A literal
 * «Уучлаарай» here would be this platform putting Mongolian in `src/`, which the standing
 * rule forbids and which breaks the first tenant who does not work in Mongolian.
 * `apologyStemsFrom` derives them; read its note for what that derivation cannot do.
 */
export function bookingApology(
  text: string,
  bookingLine: string | null,
  apologyStems: readonly string[],
): BookingVerdict {
  if (bookingLine === null || bookingLine === '') return { apologises: false };
  const folded = fold(text);
  if (!containsMostOf(folded, fold(bookingLine))) return { apologises: false };
  const opening = fold(firstSentence(text));
  for (const stem of apologyStems) {
    const s = fold(stem);
    if (s !== '' && opening.includes(s)) return { apologises: true, opening: firstSentence(text).trim() };
  }
  return { apologises: false };
}

/**
 * The reply to serve instead: the tenant's deposit rows, then the reviewed booking line.
 *
 * Returns `null` when there is no booking line to serve — an empty substitution must never
 * ship, which is the lesson a `rows: []` fixture taught the price guard an hour earlier.
 */
export function renderBookingAnswer(
  depositRows: readonly string[],
  bookingLine: string | null,
): string | null {
  if (bookingLine === null || bookingLine.trim() === '') return null;
  const deposits = depositRows.map((r) => r.trim()).filter((r) => r !== '');
  return deposits.length === 0 ? bookingLine.trim() : `${deposits.join('\n')}\n\n${bookingLine.trim()}`;
}

/**
 * The tenant's own apology opening, derived from its `handoff` row.
 *
 * `handoff` is the "I cannot help with this" sentence every tenant must have —
 * `renderCannedSection` refuses a tenant without one — so its first word is that tenant's
 * idiom for apologising. Matrix's is «Уучлаарай». No new column, no migration, and no
 * Mongolian in `src/`.
 *
 * WHAT THIS CANNOT DO, stated rather than discovered later: a tenant whose handoff opens
 * with something that is not an apology yields a stem that never matches, and the booking
 * check is then inert for them. That is the safe direction — an inert check serves the
 * model's reply, which is the behaviour before this existed — but it is a real limit, and
 * the day a tenant needs this and does not get it, the answer is a column, not a cleverer
 * derivation.
 */
export function apologyStemsFrom(canned: readonly { kind: string; body: string }[]): string[] {
  const handoff = canned.find((c) => c.kind === 'handoff');
  if (handoff === undefined) return [];
  // Leading punctuation and the trailing comma «Уучлаарай,» both have to go, and the split
  // is on Unicode separators rather than `\s` so it behaves the same in every script.
  const first = handoff.body.trim().split(/[\s,;:!?.]+/u).find((w) => w !== '');
  return first === undefined || [...first].length < 3 ? [] : [first];
}
