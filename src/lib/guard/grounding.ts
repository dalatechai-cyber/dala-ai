/**
 * Does the reply say only what the tenant's own data says?
 *
 * Founder, 2026-09-24: *"c07 and c02 give hair advice. If that isn't in the salon's
 * knowledge base, it must not say it."* Measured on the same run, and the two are not the
 * same case:
 *
 *  - c07 «Budagtai usend himi hiidegv» was answered «Будсан үс хэт цайруулаагүй, уураг нь
 *    хадгалагдсан бол хими хийж болно…» — which IS the salon's own document «Химийн
 *    хориглох заалт», nearly word for word. Advice, and grounded.
 *  - c02 «…har usni ungute usend orohu» was answered «Оффис колор нь харанхуй/хар үсэнд
 *    хийхэд тохирдог арга» — suits dark hair — which no row the salon wrote says.
 *
 * So the question is not "is this advice" but "is this in the data", and it is asked only
 * where a tenant has said it matters: a rule with `grounded_only` fired (`0041`). Asked on
 * every reply it would discard the model's ordinary connective prose, which is not in the
 * data either and is not advice.
 *
 * ## The measure, and why it is a coverage and not a similarity
 *
 * A sentence is grounded when at least `MIN_COVERAGE` of its characters sit inside runs of
 * `MIN_RUN_CP` or more characters that occur verbatim in the tenant's data. Runs, because
 * D-077's rule is that the mechanism deciding whether approved text is present asks exact
 * questions; coverage rather than one longest run, because the model joins two sentences
 * of a document with «учир нь» and that is still the document. c07's sentences are 1.00
 * and 0.89 covered; c02's first is 0.34.
 *
 * The corpus is the tenant region of the compiled prefix — everything after the data
 * marker — so a sentence cannot be grounded by the platform's own gate blocks, which are
 * instructions and not facts about the business.
 *
 * Rule 6: folded, code points, no `\b`. A sentence of fewer than `MIN_SENTENCE_CP`
 * characters is not judged: «Тийм.» carries no claim and is in no document.
 */
import { fold } from '../mn/text.ts';

export const MIN_RUN_CP = 12;
/**
 * Four-fifths of every judged sentence must be the tenant's own words.
 *
 * It was one half, and the second real-model run beat it: asked whether Оффис колор suits
 * dark hair, the model copied the salon's definition of Оффис колор and ended the same
 * sentence «…арга бөгөөд хараар будсан үсэнд ч хийх боломжтой» — can be done on hair dyed
 * black too. That claim is in no row; «хараар будсан үс» IS, from a different document
 * about turning black-dyed hair brown, so the clause was covered piecewise at 0.74. A
 * lexical check cannot tell two true facts from the false claim assembled out of them, so
 * on a turn where the tenant has asked for grounding it accepts only what is near-verbatim:
 * the salon's own sentences, lightly joined (c07's «…хийхгүй, учир нь уураг нь…» is 0.89).
 * The cost is stated, not discovered: a faithful PARAPHRASE of the knowledge base now gets
 * the refusal line instead — safe, and less helpful.
 */
export const MIN_COVERAGE = 0.8;
export const MIN_SENTENCE_CP = 12;

function squash(s: string): string {
  return fold(s).replace(/\s+/gu, ' ').trim();
}

/** Everything after the data marker, or '' when the prefix carries no tenant region. */
export function tenantRegion(promptStable: string, dataMarker: string): string {
  const i = promptStable.indexOf(dataMarker);
  return i === -1 ? '' : promptStable.slice(i + dataMarker.length);
}

/** Share of the sentence's code points inside a verbatim run of MIN_RUN_CP or more. */
export function coverage(sentence: string, corpus: string): number {
  const cps = [...sentence];
  if (cps.length === 0) return 1;
  const covered = new Array<boolean>(cps.length).fill(false);
  let i = 0;
  while (i + MIN_RUN_CP <= cps.length) {
    let len = MIN_RUN_CP;
    if (!corpus.includes(cps.slice(i, i + len).join(''))) { i += 1; continue; }
    while (i + len < cps.length && corpus.includes(cps.slice(i, i + len + 1).join(''))) len += 1;
    for (let k = i; k < i + len; k += 1) covered[k] = true;
    i += len;
  }
  return covered.filter(Boolean).length / cps.length;
}

/** The reply's sentences that the tenant's data does not support. Empty means grounded. */
export function ungroundedSentences(reply: string, corpus: string): string[] {
  const c = squash(corpus);
  return reply
    .split(/[.!?\n]+/u)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= MIN_SENTENCE_CP)
    .filter((s) => coverage(squash(s), c) < MIN_COVERAGE);
}
