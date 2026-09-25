/**
 * Is there a phone number in a customer's message? The lead detector for the sales shadow
 * (D-127).
 *
 * ## What counts
 *
 * A Mongolian subscriber number is EIGHT digits: mobiles begin 8, 9, 6 or 5, Ulaanbaatar
 * landlines 7 (the salon's own «7741-7777» and «76001888» are both that shape). Customers
 * type them joined («99112233»), halved («9911 2233», «9911-2233») or in pairs
 * («99 11 22 33»), sometimes behind the country code («+976 9911 2233»). So a match is
 * exactly eight digits, with at most one space, hyphen, dot or no-break space between any
 * two of them, and an optional `+976` / `976` in front.
 *
 * ## What must never count, and why each is excluded structurally
 *
 *  - **A price.** «250,000», «1,500,000₮»: a comma is not a separator here, so neither is
 *    eight digits. «12 500 000» IS eight digits with spaces — it is refused twice over: it
 *    starts with 1, and its groups are thousands groups (1–3 digits, then threes).
 *  - **A time or a range.** «10:00», «10:00–20:00»: a colon is not a separator.
 *  - **Nine digits or more.** The digits either side of the match must not continue the run,
 *    through a separator either — «9911 2233 44» is a ten-digit something, not a phone.
 *  - **A number inside a link.** Links are masked to a space first (`maskUrls`, D-074: a
 *    URL's characters are never content).
 *  - **The tenant's OWN numbers.** A customer quoting the salon's number back — «76001888
 *    руу залгасан авахгүй байна» — is a complaint, not a lead. The caller passes the numbers
 *    the tenant publishes (read out of its own prefix and reviewed lines), never a literal.
 *
 * ## Digits only, and NFKC for the digits alone
 *
 * The text is NFKC-normalised before digits are read, so a full-width «９９１１» from a
 * phone keyboard reads as digits. That normalisation is for extraction only: nothing here
 * is stored, echoed or matched as words, and no Cyrillic is compared (rule 6 is about word
 * matching over user text; this reads digits and separators, which have no case, no
 * inflection and no script).
 *
 * ## It never returns the number in a form that is logged
 *
 * `numbers` exists for the one caller that must compare (the tenant's own numbers, and a
 * later message repeating the same lead). Anything written anywhere — a `quality_flags`
 * row, a log line, a report — takes `masked` («7600****»), because `quality_flags` is not
 * reached by the retention purge (see `worker/comments.ts`) and a raw number there would
 * outlive every message it came from.
 */
import { maskUrls } from '../mn/extract.ts';

/** Separators allowed between two digits: space, hyphen, dot, no-break space. One at most. */
const SEP = '[ .\\-\\u00A0]';

/**
 * Eight digits with optional single separators, not continued by a digit on either side
 * (directly or through one separator), with an optional country code in front.
 */
const PHONE = new RegExp(
  `(?<!\\d${SEP}?)(?:\\+?976${SEP}?)?(\\d(?:${SEP}?\\d){7})(?!${SEP}?\\d)`,
  'gu',
);

/** First digits of a Mongolian subscriber number. 1–4 begin area codes and prices, not phones. */
const FIRST_DIGIT = /^[5-9]/u;

/** «12 500 000», «99 112 233»: digit groups shaped like a thousands-separated amount. */
const THOUSANDS = new RegExp(`^\\d{1,3}(?:${SEP}\\d{3})+$`, 'u');

/** A currency or amount word right after the digits: the thing is an amount, whatever its length. */
const AMOUNT_AFTER = /^\s{0,2}(?:₮|төг|tug|tög|сая|say|мянга|myanga|k(?![\p{L}]))/iu;

export type PhoneHit = {
  /** Eight digits, no separators. For comparison only — never written anywhere. */
  digits: string;
  /** The first four digits and four stars, «7600****». What every record carries. */
  masked: string;
};

/** «76001888» → «7600****». Anything not eight digits masks to all stars. */
export function maskPhone(digits: string): string {
  return /^\d{8}$/u.test(digits) ? `${digits.slice(0, 4)}****` : '********';
}

/** Every eight-digit run in `text` that could be a phone number, owned by anyone. */
function candidates(text: string): string[] {
  // NFKC for digits only (full-width forms); URLs out first, to a SPACE so the sides are
  // never spliced into a digit run nobody typed (D-074's rule, fourth file).
  const t = maskUrls(text).normalize('NFKC');
  const found: string[] = [];
  for (const m of t.matchAll(PHONE)) {
    const raw = m[1] ?? '';
    const digits = raw.replace(/\D/gu, '');
    if (digits.length !== 8 || !FIRST_DIGIT.test(digits)) continue;
    if (THOUSANDS.test(raw)) continue;
    const after = t.slice((m.index ?? 0) + m[0].length);
    if (AMOUNT_AFTER.test(after)) continue;
    if (!found.includes(digits)) found.push(digits);
  }
  return found;
}

/**
 * The phone numbers in a customer's message that are not the tenant's own, in the order
 * they appear, de-duplicated.
 *
 * `ownNumbers` are digit strings; anything else in them is ignored, so a caller can pass
 * the output of `publishedNumbers` directly.
 */
export function detectPhones(text: string, ownNumbers: readonly string[]): PhoneHit[] {
  const own = new Set(ownNumbers.map((n) => n.replace(/\D/gu, '')));
  return candidates(text)
    .filter((d) => !own.has(d))
    .map((digits) => ({ digits, masked: maskPhone(digits) }));
}

/**
 * The text with every phone-shaped number in it masked in place («… 7600**** …»), whoever it
 * belongs to. For quoting a customer's message in a report; nothing else about the text
 * changes (it is not NFKC-normalised — the quote stays exact apart from the mask).
 */
export function maskPhonesInText(text: string): string {
  return text.replace(PHONE, (whole, raw: string) => {
    const digits = raw.replace(/\D/gu, '');
    if (digits.length !== 8 || !FIRST_DIGIT.test(digits) || THOUSANDS.test(raw)) return whole;
    return maskPhone(digits);
  });
}

/**
 * The phone numbers a tenant publishes, read out of its own texts — the compiled prefix and
 * its reviewed lines. Data in, data out: no tenant's number is written in code, and a tenant
 * that changes its number changes this by republishing.
 *
 * The same detector as a customer's message, on purpose: whatever shape the tenant wrote its
 * number in is the shape a customer copying it back will use.
 */
export function publishedNumbers(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const d of candidates(t)) if (!out.includes(d)) out.push(d);
  return out;
}
