/**
 * Mongolian Cyrillic text primitives.
 *
 * ## Why this module exists at all
 *
 * Every matcher in this platform runs over Mongolian Cyrillic written by strangers on
 * Facebook. The JavaScript constructs one reaches for first do not merely perform
 * badly there — they are silently, systematically wrong, and each of the following was
 * confirmed by execution on this repository's Node before a line of it was written:
 *
 * | Construct | On Mongolian | Consequence |
 * |---|---|---|
 * | `/\bзасалт\b/` | `false` | the matcher never fires |
 * | `/\w/` on `үс` | `false` | every Cyrillic letter is a non-word character |
 * | `/[a-z]/i` on `үс` | `false` | an ASCII range cannot see Cyrillic |
 * | `'😊'.length` | `2` | a length cap in UTF-16 units truncates mid-emoji |
 *
 * A matcher that under-fires is worse than one that throws: it reports a healthy
 * boundary-hold rate that is mostly measurement failure.
 *
 * ## NFC, and the precise reason `unaccent` is banned
 *
 * CLAUDE.md rule 6 forbids installing `unaccent` because it is *partially* destructive.
 * The mechanism, verified here rather than assumed:
 *
 * ```
 * Ё U+0401 → NFD [U+0415 U+0308]   (decomposes — a base letter plus a combining mark)
 * Й U+0419 → NFD [U+0418 U+0306]   (decomposes)
 * Ө U+04E8 → NFD [U+04E8]          (does NOT decompose — no combining mark to strip)
 * Ү U+04AE → NFD [U+04AE]          (does NOT decompose)
 * ```
 *
 * `unaccent` strips combining marks, so it maps `Ё→Е` and `Й→И` while leaving `Ө` and
 * `Ү` — the two letters that most distinguish Mongolian from Russian — completely
 * untouched. It therefore appears to work on nine strings in ten. That is the worst
 * possible failure shape: too broken to trust, too correct to notice.
 *
 * The same asymmetry is why NFC normalisation is not optional. `хүүхэд` is byte-identical
 * in NFC and NFD (no decomposable letters), but `Ёлка` is not — so a matcher that skips
 * normalisation works on most words and fails on the ones containing `Ё` or `Й`,
 * depending on which keyboard the customer used.
 */

/**
 * NFC-normalise. Applied at every input boundary (CLAUDE.md rule 6) and again before
 * every comparison, because a string that reached us normalised may have been
 * concatenated with one that did not.
 */
export function nfc(s: string): string {
  return s.normalize('NFC');
}

/**
 * Case-fold for MATCHING only — never for storage. `toLocaleLowerCase('mn-MN')` rather
 * than `toLowerCase()`: the locale-independent form is correct for Cyrillic today, but
 * the locale-aware call states the intent, and this platform's whole failure history is
 * things that were accidentally right.
 */
export function fold(s: string): string {
  return nfc(s).toLocaleLowerCase('mn-MN');
}

/**
 * Length in CODE POINTS. Never `.length`, which counts UTF-16 units, and never byte
 * length. Mongolian Cyrillic is entirely BMP so the three agree on letters — but salon
 * DMs are full of emoji, where they do not.
 */
export function cpLength(s: string): number {
  return Array.from(s).length;
}

/**
 * A map from UTF-16 index to code-point index, so a window measured in characters stays
 * a window measured in characters even when the text contains emoji.
 *
 * Both halves of a surrogate pair map to the same code-point index, which makes the
 * lookup total: no UTF-16 offset a RegExp can produce is unmapped.
 */
export function cpOffsets(s: string): Int32Array {
  const out = new Int32Array(s.length + 1);
  let cp = 0;
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i);
    const width = code !== undefined && code > 0xffff ? 2 : 1;
    out[i] = cp;
    if (width === 2) out[i + 1] = cp;
    i += width;
    cp += 1;
  }
  out[s.length] = cp;
  return out;
}

/** Every letter in the text, as code points. `\p{L}`, because `\w` excludes Cyrillic. */
export function letters(s: string): string[] {
  return Array.from(nfc(s)).filter((ch) => /\p{L}/u.test(ch));
}

const SCRIPT_CACHE = new Map<string, RegExp>();

/**
 * A `\p{Script=…}` matcher for a script named in CONFIG, not in a constant — the
 * threshold reads `tenant.primary_script` because tenant #7 may be Russian-speaking
 * (§6.10.3).
 *
 * An unknown or malformed script name THROWS rather than returning a matcher that never
 * matches. A silent zero here would compute a script share of 0 for every reply and
 * refuse the whole tenant; a silent one would pass an English reply through. Neither is
 * a thing to discover in production, so the caller is made to handle it — and in the
 * outbound guard, "we could not determine the script" refuses the reply.
 */
export function scriptMatcher(script: string): RegExp {
  const cached = SCRIPT_CACHE.get(script);
  if (cached !== undefined) return cached;
  // ascii-safe: a Unicode script NAME is ASCII by definition (UAX #24); this validates
  // the identifier before it is interpolated into a pattern, it does not match user text.
  if (!/^[A-Z][A-Za-z_]{1,30}$/.test(script)) {
    throw new Error(`Not a Unicode script name: ${JSON.stringify(script)}. Refusing to build a matcher.`);
  }
  let re: RegExp;
  try {
    re = new RegExp(`\\p{Script=${script}}`, 'u');
  } catch {
    throw new Error(`Unknown Unicode script ${JSON.stringify(script)}. Refusing to build a matcher.`);
  }
  SCRIPT_CACHE.set(script, re);
  return re;
}

/**
 * Remove allow-listed spans before measuring script share. A legitimate Mongolian reply
 * can be mostly a URL plus a service name («CICA», «Омбре»); counting those as
 * non-Cyrillic letters would refuse a perfectly good reply (§6.10.3).
 *
 * Longest span first, so a shorter span that is a substring of a longer one cannot
 * fragment it.
 */
export function stripSpans(s: string, spans: readonly string[]): string {
  let out = nfc(s);
  const ordered = [...new Set(spans.map(nfc).filter((x) => x !== ''))].sort((a, b) => b.length - a.length);
  for (const span of ordered) out = out.split(span).join(' ');
  return out;
}

/**
 * The share of letters written in `script`, over letters only.
 *
 * Returns `null` — never a number — when the text carries fewer than `minLetters`
 * letters. A three-word reply is not evidence of a language, and forcing the caller to
 * handle "not enough evidence" separately is what stops it being silently scored as 0.
 */
export function scriptShare(
  text: string,
  script: string,
  opts: { exclude?: readonly string[]; minLetters?: number } = {},
): number | null {
  const minLetters = opts.minLetters ?? 25;
  const cleaned = opts.exclude === undefined ? nfc(text) : stripSpans(text, opts.exclude);
  const ls = letters(cleaned);
  if (ls.length < minLetters) return null;
  const re = scriptMatcher(script);
  let inScript = 0;
  for (const ch of ls) if (re.test(ch)) inScript += 1;
  return inScript / ls.length;
}

/** Sentence terminators, Mongolian and Latin alike. */
const SENTENCE_END = new Set(['.', '!', '?', '…', '？', '！', '。']);

/**
 * Cap a reply to a single Messenger send, in CODE POINTS.
 *
 * Three deliberate properties, each from a live defect in the ancestor:
 *
 *  - **Code points, not `.length`.** `messengerText.js:78` and `messengerClient.js:52`
 *    both count UTF-16 units. For Cyrillic that errs safe; for emoji it does not.
 *  - **Never chunk.** `chunkMessage` (`messengerClient.js:44-63`) can split a surrogate
 *    pair mid-emoji on its hard-split branch. One atomic send or nothing.
 *  - **Truncate at a sentence boundary**, then append a pinned suffix — and the suffix is
 *    a PARAMETER. A customer-visible Mongolian sentence is tenant data with a review
 *    gate on it; it is never a constant in a library file.
 *
 * Returns `null` when it cannot cap without cutting mid-sentence and no sentence
 * boundary exists — a truncated Mongolian half-sentence must not be sent (§6.10.1).
 */
export function capToSingleMessage(
  text: string,
  limitCp: number,
  suffix: string,
): { text: string; truncated: boolean } | null {
  const chars = Array.from(nfc(text));
  if (chars.length <= limitCp) return { text: chars.join(''), truncated: false };

  const suffixChars = Array.from(nfc(suffix));
  const room = limitCp - suffixChars.length;
  if (room <= 0) return null;

  let cut = -1;
  for (let i = Math.min(room, chars.length) - 1; i >= 0; i -= 1) {
    const ch = chars[i];
    if (ch !== undefined && SENTENCE_END.has(ch)) {
      cut = i + 1;
      break;
    }
  }
  if (cut <= 0) return null;

  return { text: chars.slice(0, cut).join('').trimEnd() + suffixChars.join(''), truncated: true };
}
