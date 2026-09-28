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
 * never decides. An advert is two of three — a SELLER's words («зарна», «хүргэлттэй»,
 * «бөөний»…), a phone number, a price figure — in a comment that asks NOTHING. A seller
 * states; a customer asks.
 *
 * A clock time or a date is never a price (`isTimeOrDate`), so «Цаг авъя 99112233 18:30» is a
 * customer booking. Stated limit: «Үнэ 45000 гэсэн, 99112233 руу залгаарай» — a phone and a
 * price, no question — reads as an advert, and is recorded as one.
 *
 * The third shape — the same long comment posted again by the same account within a day —
 * needs the earlier comments and is decided by `isRepeatedComment` over what the caller read.
 *
 * ## What it returns
 *
 * The NAMES of the signals that fired, never the text: the caller records them on a
 * `quality_flags` row, which the purge does not reach (see `UNCLASSIFIED_FLAG`).
 */
import { extractNumerals } from '../mn/extract.ts';
import { hasWord, messageWords, wholeMessageKey } from '../mn/match.ts';
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
const QUESTION_PARTICLES = new Set(messageWords('уу үү юу юү вэ бэ бол uu vv yu yuu ve we be bol'));
/** The same particles typed fused to the last word («арилдагуу»). */
const QUESTION_ENDINGS: readonly string[] = ['уу', 'үү', 'юу', 'юү', 'вэ', 'бэ', 'uu', 'vv', 'yu', 've', 'we', 'be'];
/**
 * Greetings that END in a question particle. A comment opening with one is not asking
 * anything by it: «Сайн байна уу» carries «уу» as a whole word, and without this every seller
 * who says hello would read as a customer asking.
 */
const GREETINGS: readonly string[][] = [
  'сайн байна уу', 'сайн байцгаана уу', 'сайн уу', 'sain baina uu', 'sain bainuu', 'sain bnuu', 'sn bnu', 'sain uu',
].map((g) => messageWords(g));

/** Currency marks, and the word «үнэ» — what makes a four-digit figure a price. */
const PRICE_WORDS: readonly string[] = ['₮', 'төгрөг', 'төг', 'tugrug', 'tug', 'mnt', 'үнэ', 'une', 'vne'];

/**
 * A Mongolian phone number: eight digits, the first 5–9. Written joined, dashed or spaced
 * («99033966», «9903-3966»); `extractNumerals` joins a dash. A space-split «9903 3966» is
 * two numerals and is joined here when two four-digit runs sit side by side.
 */
function isPhoneDigits(d: string): boolean {
  return d.length === 8 && d.charCodeAt(0) >= 0x35 && d.charCodeAt(0) <= 0x39;
}

/**
 * A clock time or a date, never a price: `extractNumerals` joins across «:» and «.», so
 * «18:30» reduces to 1830 and «2026.09.28» to 20260928. A customer booking «99112233 18:30»
 * must not read as a phone number beside a price.
 */
function isTimeOrDate(raw: string): boolean {
  if (raw.includes(':') || raw.includes('/')) return true;
  let seps = 0;
  for (const ch of raw) if (ch === '.' || ch === '-') seps += 1;
  return seps >= 2;
}

function numeralFacts(text: string): { phone: boolean; price: boolean } {
  const s = nfc(text);
  const numerals = extractNumerals(s);
  const priceContext = hasWord(s, PRICE_WORDS);
  let phone = false;
  let price = false;
  for (let i = 0; i < numerals.length; i += 1) {
    const { raw, digits: d } = numerals[i]!;
    const next = numerals[i + 1]?.digits;
    if (isPhoneDigits(d) || (d.length === 4 && next?.length === 4 && isPhoneDigits(d + next))) {
      phone = true;
      if (!isPhoneDigits(d)) i += 1;
      continue;
    }
    if (isTimeOrDate(raw)) continue;
    // Five digits or more is a price on its own («45000», «120,000»); a shorter figure only
    // beside a currency mark or «үнэ». «2 удаа», «3 цаг» and a year are not prices.
    if (d.length >= 5 || (priceContext && d.length >= 3)) price = true;
  }
  return { phone, price };
}

/**
 * Does the comment ask anything? A question particle as a whole word, one fused to the last
 * word, or a question mark — not counting a greeting it opens with.
 */
export function asksSomething(text: string): boolean {
  let words = messageWords(text);
  let greetingMarks = 0;
  const g = GREETINGS.find((w) => w.length <= words.length && w.every((x, j) => words[j] === x));
  if (g !== undefined) {
    words = words.slice(g.length);
    greetingMarks = 1;
  }
  const s = nfc(text);
  let marks = 0;
  for (const ch of s) if (ch === '?' || ch === '\uFF1F') marks += 1;
  if (marks > greetingMarks) return true;
  if (words.some((w) => QUESTION_PARTICLES.has(w))) return true;
  const last = words[words.length - 1];
  return last !== undefined && QUESTION_ENDINGS.some((e) => last.endsWith(e));
}

/**
 * Does the comment's own text read as another seller's advert? Pure.
 *
 * Never when it asks something: a seller states, a customer asks. «Бөөний үнэ 45000 уу?» is
 * a customer, and so is anything with «зарна уу».
 */
export function advertByText(text: string): AdvertCheck {
  const seller = hasWord(text, SELLER_WORDS);
  const { phone, price } = numeralFacts(text);
  const signals: AdvertSignal[] = [];
  if (seller) signals.push('seller_words');
  if (phone) signals.push('phone');
  if (price) signals.push('price');
  const two = (seller && (phone || price)) || (phone && price);
  return two && !asksSomething(text) ? { advert: true, signals } : { advert: false };
}

/**
 * The shortest comment, in code points, that counts as a copy-pasted repeat. A customer who
 * asks «une hed ve» twice is asking twice; a forty-character comment posted again word for
 * word is pasted.
 */
export const REPEAT_MIN_CHARS = 40;

/**
 * How far apart two copies may be. The advert of 2026-09-27 was three copies in twelve
 * seconds; a day covers a seller pasting down the Page's posts, and does not reach a customer
 * who comes back next week with the same words.
 */
export const REPEAT_WINDOW_MS = 24 * 3_600_000;

/**
 * Could this comment be a pasted repeat at all? Long enough, and asking nothing — a customer
 * re-posting a question nobody answered is asking again, not advertising. The caller reads
 * the author's earlier comments only when this is true.
 */
export function mayBeRepeat(text: string): boolean {
  return cpLength(repeatKey(text)) >= REPEAT_MIN_CHARS && !asksSomething(text);
}

/**
 * Has this account posted this same comment within `REPEAT_WINDOW_MS` of it? `earlier` is
 * the same author's OTHER comments on this tenant's pages, on any post. Compared on the
 * reduced form every matcher reads (case, punctuation and emoji removed), so a copy with one
 * more heart is still a copy.
 */
export function isRepeatedComment(
  comment: { text: string; createdAt: Date },
  earlier: readonly { text: string; createdAt: Date }[],
): boolean {
  if (!mayBeRepeat(comment.text)) return false;
  const key = repeatKey(comment.text);
  const at = comment.createdAt.getTime();
  return earlier.some((e) => Math.abs(e.createdAt.getTime() - at) <= REPEAT_WINDOW_MS && repeatKey(e.text) === key);
}

/**
 * `wholeMessageKey` less the emoji variation selectors it keeps (they are marks, not symbols):
 * «❤️» is U+2764 then U+FE0F, and the selector would survive as a word of its own.
 */
function repeatKey(text: string): string {
  return wholeMessageKey(text).replace(/[\uFE00-\uFE0F]/gu, '').replace(/\s+/gu, ' ').trim();
}
