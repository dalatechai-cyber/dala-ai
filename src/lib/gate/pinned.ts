/**
 * Did the model reproduce a pinned line, or paraphrase one?
 *
 * Four of the gate blocks end with the same sentence — «БЭЛЭН ХАРИУЛТ» хэсгээс … **нэг ч
 * үсэг өөрчлөхгүйгээр яг хэвээр нь бич**, reproduce it without changing a single letter —
 * and until this file existed that was a REQUEST with no check behind it. The model was
 * asked to obey and nothing ever asked whether it had.
 *
 * ## It was measured on the third draft the mirror ever produced
 *
 * 2026-09-14, Matrix, within nine minutes of the webhook coming back:
 *
 *     canned `handoff`  Уучлаарай, би энэ асуултад хариулж чадахгүй байна. …   129 chars
 *     draft 3           Уучлаарай, ___ энэ асуултад хариулж чадахгүй байна. …  128 chars
 *
 * One word, «би», dropped.
 *
 * The first reading of this compared it against draft 2, which IS byte-exact, and called it
 * one obeyed and one not. That was wrong, and the `quality_flags` row says so: draft 2 was
 * refused by the outbound guard (`outbound_price`) and `handoff()` then served the row.
 * It is byte-exact because the PLATFORM typed it, not the model.
 *
 * So the record is worse than the first account, not better: **on the only occasion the
 * model typed a pinned line itself, it got it wrong.** One sample is one sample — but the
 * argument for enforcing this never rested on the rate, and an unenforced instruction looks
 * the same at any rate: mostly fine, exceptions invisible.
 *
 * The damage in THAT instance was small; the line is a refusal either way. The mechanism it
 * defeats is not small. Every customer-visible sentence on this platform rests on the same
 * arrangement — a founder approves wording, `reviewed_at` records it, the prefix carries it,
 * and the model is asked to copy it exactly. A near-copy is an **unreviewed sentence with an
 * approved one's meaning**, and the review gate cannot see it because the gate is on the
 * row, not on what came back.
 *
 * ## What this does about it, and what it deliberately does not
 *
 * It does NOT edit the model's text. `handleReception` already holds that line — *an edited
 * reply is an unreviewed reply* — and patching a paraphrase back toward the original would
 * be exactly that, plus a second implementation of a sentence that already exists in a row.
 *
 * It **discards** the model's text and answers from the row instead, which is what the two
 * short-circuits above it already do. A near-copy is read as the model having CHOSEN that
 * line; the platform then serves the line, byte for byte, from `canned_responses`. The model
 * keeps the job it is good at — deciding which line applies — and loses the job it was
 * measurably unreliable at, which is typing it out again.
 *
 * An exact copy is substituted too, and that is not redundant: it normalises whitespace back
 * to the row's own bytes, and it corrects the provenance. A reply that IS the handoff line
 * was answered by a canned line no matter who assembled the characters, and recording it as
 * `model` would misstate the corpus the mirror exists to produce.
 *
 * ## Only REVIEWED rows are pinned lines
 *
 * An unreviewed row is not an approved sentence, so it cannot be the thing a paraphrase is
 * measured against — substituting toward it would ship unreviewed Mongolian on the strength
 * of the model having roughly typed it. `handleReception`'s own `canned()` accessor refuses
 * unreviewed rows for the same reason.
 */
import { nfc } from '../mn/text.ts';
import type { CannedRow } from './match.ts';

/**
 * How close a reply must be to a pinned line before it is read as a copy of it.
 *
 * 0.90 of the longer string, in code points. The measured case sits at 0.992 — one word of
 * a hundred and twenty-nine characters — so the threshold has an enormous margin above the
 * failure it was built for, and that is on purpose. Canned lines are refusals and
 * greetings, short and formulaic; a genuine answer that is nine-tenths identical to one of
 * them character by character IS that refusal, wearing different whitespace.
 *
 * The direction of the error matters. Too high and a paraphrase ships; too low and a real
 * answer is replaced by a refusal. Both are bad, so the LENGTH GUARD below carries most of
 * the safety rather than this number: a reply of a different length is never a copy
 * whatever its ratio says.
 */
export const NEAR_COPY_MIN_SIMILARITY = 0.9;

/**
 * A reply may not be read as a copy of a line half or twice its length.
 *
 * This is what stops a long, correct answer that happens to quote the phone number and a
 * few stock phrases from being replaced by a refusal — and it is a cheap reject that skips
 * the distance computation for almost every row.
 */
const MIN_LENGTH_RATIO = 0.8;

export type PinnedVerdict =
  /** Nothing in the reply resembles a pinned line. Carry on to the guard. */
  | { kind: 'clean' }
  /**
   * The reply IS a pinned line, byte for byte after normalisation. The canonical body is
   * still returned: the caller serves the row's own bytes and records `canned`.
   */
  | { kind: 'exact'; canonicalKind: string; canonical: string }
  /**
   * The reply is a near-copy and not the line. The caller serves the row instead and flags,
   * because a paraphrase of an approved sentence is the failure this module exists for and
   * it must be counted, not merely corrected.
   */
  | { kind: 'paraphrase'; canonicalKind: string; canonical: string; similarity: number };

/**
 * Compare on what a reader would call the same sentence.
 *
 * NFC first — CLAUDE.md rule 6, and «Ёлка» decomposed is not «Ёлка» composed — then every
 * run of Unicode whitespace collapses to one space. Deliberately NOT case-folded: Mongolian
 * Cyrillic sentence case is stable in these lines, and folding would let a shouted variant
 * pass as identical.
 */
function comparable(s: string): string {
  return nfc(s).replace(/\s+/gu, ' ').trim();
}

/**
 * Levenshtein distance over CODE POINTS, not UTF-16 units.
 *
 * `.length` on a Mongolian string is close enough to the character count to be tempting and
 * wrong the moment anything outside the BMP appears — an emoji in a reply is two units and
 * one character, which would silently shift every ratio in this file. Rule 6 again.
 *
 * Two rolling rows rather than a full matrix: the strings here are a canned line and a
 * capped reply, so the bound is `MAX_REPLY_CHARS` and the memory is one row of it.
 */
function distance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (prev[j] as number) + 1;
      const insertion = (row[j - 1] as number) + 1;
      row[j] = Math.min(substitution, deletion, insertion);
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** 1 when identical, 0 when nothing is shared. Measured against the LONGER string. */
export function similarity(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return (longest - distance(x, y)) / longest;
}

/**
 * Is this reply a copy of one of the tenant's approved lines?
 *
 * Returns the CLOSEST match when several are near, because the canned kinds for one tenant
 * overlap heavily — Matrix's `handoff`, `refusal_off_topic` and `refusal_price_unlisted` all
 * end in the same phone-number sentence — and answering with the second-best line would be a
 * new way of saying the wrong thing.
 */
export function checkPinnedLines(reply: string, canned: readonly CannedRow[]): PinnedVerdict {
  const candidate = comparable(reply);
  if (candidate === '') return { kind: 'clean' };
  const candidateLength = [...candidate].length;

  let best: { row: CannedRow; body: string; score: number } | null = null;
  for (const row of canned) {
    // An unreviewed row is not an approved sentence. Measuring against it, and then serving
    // it, would ship Mongolian nobody signed off on because the model roughly typed it.
    if (row.reviewedAt === null) continue;
    const body = comparable(row.body);
    if (body === '') continue;

    const bodyLength = [...body].length;
    const ratio = Math.min(candidateLength, bodyLength) / Math.max(candidateLength, bodyLength);
    if (ratio < MIN_LENGTH_RATIO) continue;

    const score = similarity(candidate, body);
    if (best === null || score > best.score) best = { row, body, score };
  }

  if (best === null || best.score < NEAR_COPY_MIN_SIMILARITY) return embeddedAdaptation(candidate, canned);

  // The row's own body, never `comparable()`'s output: the whitespace the founder approved
  // is part of what was approved, and this must not become a second source of the sentence.
  return best.body === candidate
    ? { kind: 'exact', canonicalKind: best.row.kind, canonical: best.row.body }
    : { kind: 'paraphrase', canonicalKind: best.row.kind, canonical: best.row.body, similarity: best.score };
}

/**
 * The longest run of characters the two share, in code points.
 *
 * Exact-match machinery on purpose. The alternative — sliding a similarity score along the
 * reply to find "roughly where the line is" — puts fuzzy matching inside the mechanism that
 * decides whether an approved sentence was altered, and a threshold there is a thing nobody
 * can audit from the outside. A common RUN is a fact about two strings.
 */
function longestCommonRun(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        const v = (prev[j - 1] as number) + 1;
        row[j] = v;
        if (v > best) best = v;
      }
    }
    prev = row;
  }
  return best;
}

/**
 * How much of an approved line must be reproduced before an alteration counts as drift.
 *
 * Proportional, because the rows differ in length: two thirds of a line is "this is that
 * sentence, changed" whatever the sentence is, while any absolute figure would be most of
 * a short row and a fragment of a long one.
 */
export const EMBEDDED_MIN_SHARE = 0.6;

/**
 * And a floor, because a proportion alone is too generous to a short row.
 *
 * Matrix's rows share a closing sentence — «Та 7741-7777 дугаараар холбогдоно уу.», 36
 * characters — and a reply may legitimately end that way without having reproduced any
 * particular row. Forty keeps the phone sentence from reading as drift on its own.
 */
export const EMBEDDED_MIN_RUN = 40;

/**
 * An approved line reproduced INSIDE a longer reply, and altered.
 *
 * ## Why the whole-reply check cannot see this
 *
 * `MIN_LENGTH_RATIO` rejects a candidate much longer than the row before similarity is ever
 * computed, and that is correct for what it was written for: it stops a long, correct answer
 * that merely quotes the phone number from being replaced by a refusal. The cost, measured
 * on 2026-09-16 at 11:26:29, is that an approved sentence adapted inside a longer reply is
 * neither corrected nor COUNTED — no `canned_paraphrased` row, so the drift is invisible.
 *
 * The model wrote «Шулуун химийн үнийн мэдээлэл надад байхгүй байна…» where
 * `refusal_price_unlisted` says «Уучлаарай, энэ үйлчилгээний …», naming the service the
 * customer had actually asked about. It was better than the row. It was still a sentence
 * nobody reviewed, carrying an approved one's meaning — D-065's rule — and the founder's
 * call (2026-09-16) is that the mechanism only means anything if it is exact: «би» dropping
 * today is a rewrite tomorrow.
 *
 * ## The test, and why it is two substring questions rather than a score
 *
 * A row was reproduced-and-altered when the reply shares a long run with it AND does not
 * contain it whole. Both halves are exact:
 *
 *  - contains it whole → an exact quotation, which is what a helpful answer does, and
 *    `disclosesPrompt` already exempts it. Left alone.
 *  - shares `EMBEDDED_MIN_SHARE` of it and `EMBEDDED_MIN_RUN` characters, but not whole →
 *    drift. Counted, and the row is served in its place.
 *
 * Verified against both real incidents: the 2026-09-14 «tsag avii» reply quoted
 * `booking_line` EXACTLY inside a longer sentence and is left alone; the 2026-09-16 reply
 * adapted `refusal_price_unlisted` and is corrected.
 *
 * **What this costs, said plainly.** Serving the row discards the rest of the reply —
 * `handleReception` never edits a reply and this keeps that line. In the 11:26 case the
 * customer would lose the location link that followed. That is the price of exactness, and
 * the answer to a row that reads worse than what the model produced is to fix the row.
 */
function embeddedAdaptation(candidate: string, canned: readonly CannedRow[]): PinnedVerdict {
  const cand = [...candidate];
  let best: { row: CannedRow; run: number } | null = null;

  for (const row of canned) {
    if (row.reviewedAt === null) continue;
    const body = comparable(row.body);
    if (body === '') continue;
    // An exact quotation is not drift. `comparable` has already folded both sides.
    if (candidate.includes(body)) continue;

    const chars = [...body];
    const run = longestCommonRun(cand, chars);
    if (run < EMBEDDED_MIN_RUN) continue;
    if (run / chars.length < EMBEDDED_MIN_SHARE) continue;
    if (best === null || run > best.run) best = { row, run };
  }

  if (best === null) return { kind: 'clean' };
  return {
    kind: 'paraphrase',
    canonicalKind: best.row.kind,
    canonical: best.row.body,
    similarity: best.run / [...comparable(best.row.body)].length,
  };
}
