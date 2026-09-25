/**
 * «Уучлаарай» only when the reply refuses something.
 *
 * Founder, 2026-09-24: *"No «Уучлаарай» unless it's actually refusing something."* Measured
 * on the comparison run the same day: «une hedve» → «Уучлаарай, ямар үйлчилгээний үнийг
 * мэдэхийг хүсэж байна вэ?», and «Vs zasalt buduulah» → «Уучлаарай, тодруулж болох уу?».
 * Neither refuses anything; each opens by apologising for asking a question.
 *
 * ## This removes a word, and why that is not the edit `handleReception` forbids
 *
 * The rule there is that an edited reply is an unreviewed reply, and `bookingApology`
 * discards a booking reply whole rather than cutting its first sentence. That was right
 * THERE: the apology was a sentence, and cutting it left a remainder nobody had read. Here
 * the apology is one word and a comma at the very start, the remainder is the model's own
 * sentence exactly as it wrote it, and discarding the whole reply would throw away the
 * clarifying question that is the answer. What is removed is the tenant's own apology
 * word, derived from its handoff row, and nothing else is touched but the case of the
 * letter that now opens the reply. Every removal is flagged with the reply as written.
 *
 * ## "Refusing", without a word of Mongolian in `src/`
 *
 * The tenant's reviewed refusal rows ARE its refusals, so what they have in common is
 * what a refusal looks like in its language. For Matrix every one — handoff and all
 * eleven `refusal_*` rows — carries a word ending «гүй» (боломжгүй, байхгүй, чадахгүй,
 * үзүүлэхгүй), which is Mongolian's negative. `refusalMarkerFrom` finds that suffix from
 * the rows; a reply carrying a word that ends with it is refusing, and keeps its apology.
 * So does any reply on a turn where a refusal rule fired.
 *
 * WHAT THIS CANNOT DO, stated rather than discovered: a refusal phrased without the
 * negative («мэдээлэл алга») loses its apology, which leaves a polite enough sentence. A
 * tenant whose refusal rows share no suffix gets `null`, and the check is inert — the
 * model's reply is sent as written, which is the behaviour before this existed.
 */
import { wholeMessageKey } from '../mn/match.ts';
import { fold } from '../mn/text.ts';

const MIN_MARKER_CP = 2;
const MAX_MARKER_CP = 6;

function words(text: string): string[] {
  return wholeMessageKey(text).split(' ').filter((w) => w !== '');
}

function suffixes(word: string): string[] {
  const cps = [...word];
  const out: string[] = [];
  for (let n = MIN_MARKER_CP; n <= Math.min(MAX_MARKER_CP, cps.length - 1); n += 1) {
    out.push(cps.slice(cps.length - n).join(''));
  }
  return out;
}

/**
 * The longest word-ending every reviewed refusal row carries, or null when none does.
 *
 * The apology word itself is left out: every refusal row may open with «Уучлаарай», and its
 * ending «лаарай» would otherwise be "what refusals share" — making every apology its own
 * proof of refusing, and the check inert. A test fixture whose two rows both opened with it
 * found that; Matrix's data happened not to, because «refusal_health» does not.
 */
export function refusalMarkerFrom(
  canned: readonly { kind: string; body: string; reviewedAt: string | null }[],
  apologyStems: readonly string[],
): string | null {
  const refusals = canned.filter((c) => c.reviewedAt !== null && (c.kind === 'handoff' || c.kind.startsWith('refusal_')));
  if (refusals.length < 2) return null;
  const apology = new Set(apologyStems.map((a) => fold(a)));
  const [head, ...tail] = refusals.map((row) => new Set(
    words(row.body).filter((w) => !apology.has(w)).flatMap(suffixes)));
  const found = [...(head ?? new Set<string>())].filter((s) => tail.every((mine) => mine.has(s)));
  if (found.length === 0) return null;
  // Longest first; a tie is broken by code point so two runs cannot disagree (D-026).
  found.sort((a, b) => ([...b].length - [...a].length) || (a < b ? -1 : a > b ? 1 : 0));
  return found[0] ?? null;
}

export type ApologyVerdict =
  | { strip: false }
  | { strip: true; text: string; removed: string };

/**
 * The reply without an opening apology it did not need, or `strip: false`.
 *
 * `refusedByGate` is true when a refusal rule fired on the customer's message: the reply
 * is then a refusal whatever its words, and keeps its apology.
 */
/** What must follow an apologetic opening question for the question to go with the apology. */
export const SELF_ANSWER_MIN_CP = 40;

export function unwarrantedApology(
  reply: string,
  apologyStems: readonly string[],
  marker: string | null,
  refusedByGate: boolean,
): ApologyVerdict {
  if (marker === null || refusedByGate) return { strip: false };
  const text = reply.trimStart();
  const folded = fold(text);
  const stem = apologyStems.map((s) => fold(s)).find((s) => s !== '' && folded.startsWith(s));
  if (stem === undefined) return { strip: false };
  const cps = [...text];
  const stemLen = [...stem].length;
  // The apology must be a WORD: «Уучлаарайгаа» is not «Уучлаарай».
  const next = cps[stemLen] ?? '';
  if (/[\p{L}\p{N}]/u.test(next)) return { strip: false };
  // The apology belongs to the sentence it opens, so that sentence is what must refuse.
  // Measured: «Уучлаарай, тодруулъя — CICA гэдэг нь … хими биш…» ends two sentences later on
  // «дэлгэрэнгүй хэлье» — "I'll tell you in detail", an adjective that merely ENDS like the
  // negative — and a whole-reply test kept an apology for a reply that refused nothing.
  const opening = text.split(/[.!?\n]/u)[0] ?? '';
  if (words(opening).some((w) => w !== stem && w.endsWith(fold(marker)))) return { strip: false };

  let k = stemLen;
  while (k < cps.length && /[\s\p{P}]/u.test(cps[k] ?? '')) k += 1;
  // An apology that opens a QUESTION the reply then answers itself goes with its question
  // (founder, 2026-09-26, DalaTech's s01: «Уучлаарай, тодруулбал … байна уу?» and then the
  // answer). Only when an answer of its own follows: a reply that IS the question keeps it —
  // that question is the answer this module's header protects.
  const qEnd = cps.slice(k).findIndex((c) => /[.!?\n]/u.test(c));
  if (qEnd >= 0 && ['?', '？'].includes(cps[k + qEnd] ?? '')) {
    let j = k + qEnd + 1;
    while (j < cps.length && /[\s\p{P}]/u.test(cps[j] ?? '')) j += 1;
    if (cps.length - j >= SELF_ANSWER_MIN_CP) k = j;
  }
  const rest = cps.slice(k);
  if (rest.length === 0) return { strip: false };
  const first = (rest[0] ?? '').toLocaleUpperCase('mn-MN');
  return { strip: true, text: first + rest.slice(1).join(''), removed: cps.slice(0, k).join('').trim() };
}
