/**
 * Does a reply put each price option on its own line, as style rule (4) requires?
 *
 * ## Why this is a COUNTER and not a fix
 *
 * D-065's rule: *an instruction to the model is a request until something checks it.*
 * Style item (4) was approved by the founder, signed, and published at seq 12 — and
 * measured on 2026-09-21 the model followed it about half the time. The same question
 * («Үс будахад хэд вэ?» / «us budalt») listed three prices one per line in one run and
 * asked a bare clarifying question in the next, on the same revision and the same
 * `prompt_hash`.
 *
 * "About half" is the honest summary of eyeballing four replies. It is not a rate, and no
 * wording change can be judged against it. This makes it a rate.
 *
 * It deliberately does NOT edit the reply. Nothing here edits a reply — an edited reply is
 * an unreviewed reply — and unlike a pinned line there is no row to serve instead: the
 * content is right and only its shape is wrong. Discarding a correct answer over line
 * breaks would be D-068's mistake a sixth time.
 *
 * ## What counts as one option
 *
 * A RANGE is one option, not two. «Сор: 120,000₮–190,000₮» is a single price on a single
 * line and must not be reported — that is the first thing this got wrong, counting figures
 * instead of options.
 *
 * Rule 6: no `\b`, no `\w`, no `[a-z]`. Separators are matched explicitly. The digit class
 * is ASCII because every figure in Matrix's price list is `135,000`-shaped — a fact about
 * the corpus, checked, not an assumption.
 */

/** A money figure: digit groups with thousands separators, e.g. `135,000`, or 4+ digits. */
const FIGURE = '\\d{1,3}(?:[,\\u00a0 ]\\d{3})+|\\d{4,}';

/**
 * One OPTION: a figure, or a range of two joined by a dash. All three dashes in the corpus
 * are accepted — ASCII hyphen, en dash, em dash.
 *
 * THE CURRENCY SYMBOL SITS INSIDE THE RANGE, and leaving it out was the first bug here:
 * the corpus writes «120,000₮–190,000₮», not «120,000–190,000₮», so a pattern that jumps
 * straight from digits to the dash never matches and every range reads as TWO options —
 * reporting the salon's own correct one-line answers as violations. Four tests went red on
 * the first run and that is why they are here.
 */
const MNT = '\\u20ae';
const OPTION = `(?:${FIGURE})\\s*${MNT}?(?:\\s*[-\\u2013\\u2014]\\s*(?:${FIGURE})\\s*${MNT}?)?`;

export type PriceLineReport = {
  /** Price options found across the whole reply. */
  total: number;
  /** The largest number of options sharing one line. */
  maxPerLine: number;
  /** True when rule (4)'s first branch applies and was not followed. */
  violation: boolean;
};

/**
 * Report only — the caller flags, never rewrites.
 *
 * The violation is narrow on purpose: rule (4)'s first branch covers THREE OR FEWER
 * options, so a reply with four or more is outside it and is not reported here. Reporting
 * it would conflate "crammed three onto one line" with "listed five where it should have
 * asked", which are different defects with different fixes.
 */
export function priceLineReport(text: string): PriceLineReport {
  let total = 0;
  let maxPerLine = 0;
  for (const line of text.split('\n')) {
    // A fresh regex per line: /g lastIndex is stateful and sharing one across lines
    // silently skips matches. That is a bug this file must not have, since a missed
    // match reports compliance that did not happen.
    const n = [...line.matchAll(new RegExp(OPTION, 'gu'))].length;
    total += n;
    if (n > maxPerLine) maxPerLine = n;
  }
  return { total, maxPerLine, violation: total >= 2 && total <= 3 && maxPerLine >= 2 };
}
