/**
 * Is this comment somebody else's ADVERT? (founder, 2026-09-28.)
 *
 * Measured, which is why this exists: on 2026-09-27 a seller account posted the same advert
 * three times in twelve seconds under one of Matrix's reels (`webhook_events` 1094–1096) —
 * a hair mask, «маш хямдхан зарна үнэ 45000», and the seller's own phone number. The word
 * «үнэ» fired the salon's `price` rule, so the first copy was answered with the salon's
 * public line under the advert and the private message went to the seller. The founder's
 * rule: another seller's advert gets nothing — no public line, no private message — and it
 * is not hidden or deleted either. It is left alone and recorded.
 *
 * ## Why this is code and not a tenant row
 *
 * A row cannot express it. `ignore` ranks BELOW `reply` in `classify.ts`'s precedence, so an
 * `ignore` rule for adverts loses to the `price` rule the advert fires. And the signals are
 * not words a tenant chooses: a phone number, a price figure and a seller's sentence mean
 * the same thing under a salon's post and under a garage's. Every tenant is protected the
 * day its comments are switched on, without anyone remembering to add a row.
 *
 * ## The signals, and why two are needed
 *
 * Each signal alone is something a CUSTOMER writes: «99112233 руу залгаарай» (call me back),
 * «45000 уу?» (is it 45,000?), «Та нар маск зарна уу?» (do you sell masks?). So one signal
 * never decides. An advert is:
 *
 *  - a SELLER's sentence («зарна», «хүргэлттэй», «бөөний үнээр»…) together with a phone
 *    number or a price figure, or
 *  - a phone number together with a price figure, in a comment that asks NOTHING — a seller
 *    states, a customer asks, and a customer who leaves a number next to a price is asking
 *    whether that is the price.
 *
 * A seller word followed by a question particle («зарна уу») is a customer asking, and is
 * not a seller signal.
 *
 * The third shape — the same long comment posted again by the same account — needs the
 * earlier comments and is decided by `isRepeatedComment` over what the caller read.
 *
 * ## What it returns
 *
 * The NAMES of the signals that fired, never the text: the caller records them on a
 * `quality_flags` row, which the purge does not reach (see `UNCLASSIFIED_FLAG`).
 */
import { extractNumerals } from '../mn/extract.ts';
import { endsWithAny, hasWord, messageWords, wholeMessageKey } from '../mn/match.ts';
import { cpLength, nfc } from '../mn/text.ts';

export type AdvertSignal = 'seller_words' | 'phone' | 'price' | 'repeated';

export type AdvertCheck = { advert: false } | { advert: true; signals: AdvertSignal[] };

/**
 * A seller's own words. Whole words or whole runs of words (`hasWord`), so «зарна» does not
 * fire inside another word. Latin spellings beside the Cyrillic, for D-067's reason.
 * Seller VOICE only: «худалдаж авах» (to buy) and «хямдрал» (a discount the salon runs) are
 * what customers write, so they are not here.
 */
const SELLER_WORDS: readonly string[] = [
  'зарна', 'зарагдана', 'зарж байна', 'худалдаална', 'худалдаалж байна',
  'бөөний', 'бөөнөөр', 'хүргэлттэй', 'хүргэлт үнэгүй', 'үнэгүй хүргэнэ',
  'захиалга авна', 'захиалга авч байна', 'хямдхан зарна',
  'zarna', 'zaragdana', 'buunii', 'buunuur', 'hurgelttei', 'hvrgelttei', 'zahialga avna',
];

/** Question particles, as whole words — the same set the salon's question rules use. */
const QUESTION_WORDS: readonly string[] = [
  '?', 'уу', 'үү', 'юу', 'юү', 'вэ', 'бэ', 'бол', 'uu', 'vv', 'yu', 'yuu', 've', 'we', 'be', 'bol',
];
/** The same particles typed fused to the last word («арилдагуу»). */
const QUESTION_ENDINGS: readonly string[] = ['уу', 'үү', 'юу', 'юү', 'вэ', 'бэ', 'uu', 'vv', 'yu', 've', 'we', 'be'];
/** Particles that turn a seller word into a customer's question when they follow it. */
const FOLLOWING_PARTICLES = new Set(messageWords('уу үү юу юү вэ бэ uu vv yu yuu ve we be'));

/** Currency marks that make any numeral a price. Whole words, or the symbol anywhere. */
const CURRENCY: readonly string[] = ['₮', 'төгрөг', 'төг', 'tugrug', 'tug', 'mnt'];

/**
 * A Mongolian phone number: eight digits, the first 5–9. Written joined, dashed or spaced
 * («99033966», «9903-3966»); `extractNumerals` joins a dash. A space-split «9903 3966» is
 * two numerals and is joined here when two four-digit runs sit side by side.
 */
function isPhoneDigits(d: string): boolean {
  return d.length === 8 && d.charCodeAt(0) >= 0x35 && d.charCodeAt(0) <= 0x39;
}

function numeralFacts(text: string): { phone: boolean; price: boolean } {
  const s = nfc(text);
  const numerals = extractNumerals(s);
  let phone = false;
  let price = false;
  for (let i = 0; i < numerals.length; i += 1) {
    const d = numerals[i]!.digits;
    const next = numerals[i + 1]?.digits;
    if (isPhoneDigits(d) || (d.length === 4 && next?.length === 4 && isPhoneDigits(d + next))) {
      phone = true;
      if (!isPhoneDigits(d)) i += 1;
      continue;
    }
    // Four digits or more is a price here, not a count: «2 удаа», «3 цаг» are not prices.
    if (d.length >= 4) price = true;
  }
  if (!price && numerals.length > 0 && hasWord(s, CURRENCY)) price = true;
  return { phone, price };
}

/** A seller word that is not immediately followed by a question particle. */
function sellerWords(text: string): boolean {
  if (!hasWord(text, SELLER_WORDS)) return false;
  const words = messageWords(text);
  for (const entry of SELLER_WORDS) {
    const want = messageWords(entry);
    for (let i = 0; i + want.length <= words.length; i += 1) {
      if (!want.every((w, j) => words[i + j] === w)) continue;
      const after = words[i + want.length];
      if (after === undefined || !FOLLOWING_PARTICLES.has(after)) return true;
    }
  }
  return false;
}

function asksSomething(text: string): boolean {
  return hasWord(text, QUESTION_WORDS) || endsWithAny(text, QUESTION_ENDINGS);
}

/** Does the comment's own text read as another seller's advert? Pure. */
export function advertByText(text: string): AdvertCheck {
  const seller = sellerWords(text);
  const { phone, price } = numeralFacts(text);
  const signals: AdvertSignal[] = [];
  if (seller) signals.push('seller_words');
  if (phone) signals.push('phone');
  if (price) signals.push('price');
  const advert = (seller && (phone || price)) || (phone && price && !asksSomething(text));
  return advert ? { advert: true, signals } : { advert: false };
}

/**
 * The shortest comment, in code points, that counts as a copy-pasted repeat. A customer who
 * asks «une hed ve» twice is asking twice; a forty-character comment posted again word for
 * word is pasted.
 */
export const REPEAT_MIN_CHARS = 40;

/**
 * Has this account posted this same comment before? `earlier` is the text of the same
 * author's OTHER comments on this tenant's pages, on any post. Compared on the reduced form
 * every matcher reads (case, punctuation and emoji removed), so a copy with one more heart
 * is still a copy.
 */
export function isRepeatedComment(text: string, earlier: readonly string[]): boolean {
  const key = repeatKey(text);
  if (cpLength(key) < REPEAT_MIN_CHARS) return false;
  return earlier.some((t) => repeatKey(t) === key);
}

/**
 * `wholeMessageKey` less the emoji variation selectors it keeps (they are marks, not symbols):
 * «❤️» is U+2764 then U+FE0F, and the selector would survive as a word of its own.
 */
function repeatKey(text: string): string {
  return wholeMessageKey(text).replace(/[\uFE00-\uFE0F]/gu, '').replace(/\s+/gu, ' ').trim();
}
