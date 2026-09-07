/**
 * Extraction for the outbound guard: numerals, percentages and links.
 *
 * ## Why the outbound guard is a real control where input filtering is not
 *
 * `sanitizeForPrompt` next door is "a fixed-phrase regex strip, trivially bypassed —
 * not a security control and should not be treated as one." Every input filter over
 * Mongolian has the same shape of hole and we do not know where it is. The ancestor
 * carries a live example: `validator.js:201` uses the RUSSIAN vowel set, so it is
 * missing `ө` and `ү` and classifies twenty-four consecutive `ү` as *absence of vowels*.
 *
 * These functions are different in kind. They check **our output against our own data**,
 * both of which we control, instead of trying to enumerate the space of hostile inputs.
 * There is no bypass to find, because there is no adversary in the comparison: either a
 * numeral we emitted is in the snapshot's `allowed_numbers` or it is not.
 *
 * ## Every function here fails CLOSED
 *
 * An unparseable URL is not an allow-listed URL. An unrecognised numeral is not a known
 * price. The cost of a false refusal is the tenant's pinned handoff line — a
 * customer-service cost, paid in public. The cost of a false pass is an invented price
 * the salon is then expected to honour. Those are not comparable, which is why the
 * conservative side is chosen every time.
 */
import { cpLength, nfc } from './text.ts';

/**
 * The numeric value of any Unicode decimal digit.
 *
 * `Number('᠓')` and `parseInt('᠓')` both return **NaN** — verified. So a guard written
 * the obvious way sees a Mongolian-script digit as "not a number" and lets it through
 * unchecked, which is precisely the hole an injected price would need. Every `\p{Nd}`
 * block is a contiguous run of ten by Unicode invariant, so the value is the offset from
 * the block's zero; walking back at most nine positions finds it without a lookup table
 * that would go stale.
 */
function digitValue(ch: string): number | null {
  if (!/\p{Nd}/u.test(ch)) return null;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  let base = cp;
  while (base > 0 && cp - base < 9 && /\p{Nd}/u.test(String.fromCodePoint(base - 1))) base -= 1;
  return cp - base;
}

/** Every decimal digit reduced to its ASCII value, everything else dropped. */
export function digitsOf(s: string): string {
  let out = '';
  for (const ch of nfc(s)) {
    const v = digitValue(ch);
    if (v !== null) out += String(v);
  }
  return out;
}

/**
 * A numeral token: digit runs joined by the separators Mongolian actually uses.
 *
 * Two joiner rules, and the difference between them matters:
 *
 *  - `. , : – —` and `-` join unconditionally, so `7741-7777` and `14:00` stay one token
 *    rather than becoming two numbers that are individually meaningless.
 *  - A SPACE joins only a following run of exactly three digits, because «33 000₮» is
 *    ordinary Mongolian thousands grouping. Without the three-digit condition, a reply
 *    containing «2026-09-04 15:00» would fuse date and time into one nonsense token and
 *    be refused; with it, the space after `04` is followed by `15` and does not join.
 */
const NUMERAL = /\p{Nd}+(?:(?:[.,:–—-]\p{Nd}+)|(?:[   ]\p{Nd}{3}(?!\p{Nd})))*/gu;

/** `10:00`, `9:30` — a clock time, which is the one thing a dash RANGES rather than joins. */
// ascii-safe: matched against a token already reduced to digits and separators.
const CLOCK = /^\p{Nd}{1,2}:\p{Nd}{2}$/u;

/**
 * A dash between two clock times is a RANGE, and the two times are separate numerals.
 *
 * The unconditional dash join is right for `7741-7777`, where the halves are individually
 * meaningless, and wrong for `10:00-20:00`, where they are two facts the tenant approved
 * separately. Fused, that token reduces to `10002000` — a digit string no allow-list can
 * ever hold, so a bot stating its own opening hours was refused as `outbound_price`.
 *
 * Prices escape the same trap only by accident: «33,000₮-55,000₮» splits because the
 * currency symbol sits between the digits and the dash. Times carry no symbol, so the
 * workaround is unavailable and the tokeniser has to be right instead.
 *
 * Conservative by construction: a token is split ONLY when every dash-separated part is
 * itself a clock time. `7741-7777`, `33,000-55,000` and `2026-09-04` have no colons and
 * are untouched; `10:00-20` is not two clocks and stays fused, which refuses it — the safe
 * direction for a malformed thing nobody should be emitting.
 *
 * Splitting can only ever REFUSE more: each part must now be in the allow-list on its own,
 * where before one fused token had to be. And because `allowedNumbersFrom` compiles the
 * list through this same function, the list and the check split identically.
 */
function splitClockRange(raw: string): string[] {
  const parts = raw.split(/[-–—]/u);
  if (parts.length < 2) return [raw];
  return parts.every((p) => CLOCK.test(p)) ? parts : [raw];
}


export type Numeral = { raw: string; digits: string };

/** Every numeral in the text, as it appears and reduced to digits. */
export function extractNumerals(text: string): Numeral[] {
  const s = nfc(text);
  NUMERAL.lastIndex = 0;
  const out: Numeral[] = [];
  let m: RegExpExecArray | null;
  while ((m = NUMERAL.exec(s)) !== null) {
    const raw = m[0];
    for (const part of splitClockRange(raw)) out.push({ raw: part, digits: digitsOf(part) });
    NUMERAL.lastIndex = m.index + raw.length;
  }
  return out;
}

/**
 * The done-test from V1.md 3.4: **every numeral in the reply must appear in
 * `allowed_numbers`.** Returns the offenders; an empty array is a pass.
 *
 * Comparison is on the digits-only reduction, so `33,000` and `33 000` and `33000` are
 * the same number — a reformatting is not an invention. It is deliberately NOT a
 * substring test: `allowed_numbers` holding `7741-7777` does not license a bare `7741`,
 * because half a phone number is as wrong as a made-up one.
 */
export function numeralsNotAllowed(text: string, allowedNumbers: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const a of allowedNumbers) {
    const d = digitsOf(a);
    if (d !== '') allowed.add(d);
  }
  return extractNumerals(text)
    .filter((n) => n.digits !== '' && !allowed.has(n.digits))
    .map((n) => n.raw);
}

/**
 * A percentage anywhere in the reply. Its own tripwire because §6.5's Ш6 exists: the
 * dangerous discount answer is CONFIDENT, so it evades a forbidden list made entirely of
 * hedging vocabulary. «Тийм ээ, шинэ үйлчлүүлэгчдэд эхний удаа 10% хямдралтай» contains
 * no hedge at all, and promising a discount that does not exist is the salon's money.
 */
export function containsPercentage(text: string): boolean {
  return /\p{Nd}+\s*%/u.test(nfc(text));
}

/** Trailing characters a sentence puts after a URL that are not part of it. */
const URL_TRAILING = /[.,;:!?)»】\]'"…]+$/u;

/**
 * Links as they appear in the text. Bare `www.` forms are included because a model that
 * drops the scheme still produced a clickable link in Messenger.
 */
export function extractUrls(text: string): string[] {
  const s = nfc(text);
  const out: string[] = [];
  // ascii-safe: URL schemes and host syntax are ASCII by RFC 3986; this does not
  // classify Mongolian text, it finds link-shaped runs in it.
  const re = /(?:https?:\/\/|www\.)[^\s<>"'«»]+/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[0].replace(URL_TRAILING, ''));
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}

/**
 * A comparable form for allow-list membership.
 *
 * Returns `null` when the URL cannot be parsed — and the caller must treat that as a
 * refusal. "We could not tell what this link is" is never a reason to send it.
 *
 * The scheme is KEPT, deliberately. Folding `http` and `https` together would make an
 * allow-list entry for the secure form license the insecure one, which is a downgrade
 * the tenant never agreed to.
 */
export function canonicalizeUrl(raw: string): string | null {
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname === '') return null;
  const host = u.hostname.toLowerCase();
  const port = u.port === '' ? '' : `:${u.port}`;
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/u, '');
  return `${u.protocol}//${host}${port}${path}${u.search}`;
}

/**
 * Links in the reply that the tenant never declared. Returns the offenders, raw, so the
 * alert names what was actually emitted rather than a canonicalised guess.
 */
export function urlsNotAllowed(text: string, allowedUrls: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const a of allowedUrls) {
    const c = canonicalizeUrl(a);
    if (c !== null) allowed.add(c);
  }
  return extractUrls(text).filter((raw) => {
    const c = canonicalizeUrl(raw);
    return c === null || !allowed.has(c);
  });
}

/** Character count, re-exported so a caller never reaches for `.length` by habit. */
export { cpLength };
