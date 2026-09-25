/**
 * Stem-prefix matching for Mongolian, and ordered stem sequences.
 *
 * ## Why whole-token matching is the right rejection and the wrong replacement
 *
 * `\b` does not delimit Cyrillic words, so the obvious fix is to match whole tokens
 * instead. That fix is wrong for a second reason nobody notices until the numbers come
 * back healthy: **Mongolian is agglutinative.** Case, number and possessive glue onto
 * the stem, and the stem itself often loses a vowel when they do.
 *
 * ```
 * хүүхэд  (child, nominative)
 * хүүхдэд (dative)          ← whole-token `хүүхэд` does not match; the stem changed too
 * хүүхдүүдийн (plural genitive)
 * ```
 *
 * An enumerated surface form matches roughly one inflection in six. Inbound, the refusal
 * never fires. Outbound, `цаг авлаа` misses «Таны цагийг маргааш 15:00-д авлаа» and
 * `-аас эхэлдэг` misses «30,000₮-аас эхлээд». A detector that under-matches reports a
 * boundary-hold rate that is mostly measurement failure — which is worse than no
 * detector, because it is trusted.
 *
 * So: match **stem prefixes at token starts**, using a Unicode-aware boundary
 * `(?<![\p{L}\p{N}_])` with the `u` flag. Never `\b`.
 *
 * ## What this deliberately does NOT try to be
 *
 * This is not a morphological analyser. `хүүхэд` → `хүүхд` is a stem change no prefix
 * rule derives, so BOTH forms are stored — in `match_stems`, as data. Adding a topic for
 * tenant #3 stays a form, not a deploy. The engine's job is to make a stored stem match
 * every inflection built on it, and nothing more.
 *
 * Over-matching is real and accepted: the stem `үс` (hair) also fires on «үсэрсэн»
 * (jumped). §6.8 rule 4 is the mitigation — high precision, low recall, chosen per row.
 * The engine does not paper over it, because a stem list is reviewable and a heuristic
 * buried in code is not.
 */
import { cpOffsets, fold, nfc } from './text.ts';

/** One occurrence of a stem at the start of a token. */
export type StemHit = {
  /** UTF-16 offsets, for slicing. */
  start: number;
  end: number;
  /** Code-point offsets, for measuring windows in characters. */
  startCp: number;
  endCp: number;
};

/**
 * Escape a stem for use inside a pattern.
 *
 * Stems arrive from `match_stems` — tenant data, edited through an admin form. An
 * unescaped `(` would throw at match time and take down the guard that was supposed to
 * refuse the reply; an unescaped `.` would quietly match anything. Neither is a
 * behaviour a tenant should be able to cause by typing.
 */
function escapeStem(stem: string): string {
  // ascii-safe: escaping regex METACHARACTERS, every one of which is ASCII. This does
  // not classify user text — it neutralises punctuation before interpolation.
  return stem.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

const HIT_CACHE = new Map<string, RegExp>();

function stemMatcher(stem: string): RegExp {
  const cached = HIT_CACHE.get(stem);
  if (cached !== undefined) return cached;
  // The lookbehind is the whole point: the stem must begin a token. `(?<![\p{L}\p{N}_])`
  // with the `u` flag is the Unicode-aware form of the boundary that `\b` only pretends
  // to be over Cyrillic.
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeStem(stem)}`, 'gu');
  HIT_CACHE.set(stem, re);
  return re;
}

/**
 * Every token-initial occurrence of `stem` in already-folded text.
 *
 * The caller folds once and matches many stems against the result — folding per stem
 * would be quadratic in the size of a gate's forbidden list, which runs on every reply.
 */
export function findStem(folded: string, stem: string, offsets?: Int32Array): StemHit[] {
  if (stem === '') return [];
  const cp = offsets ?? cpOffsets(folded);
  const re = stemMatcher(stem);
  re.lastIndex = 0;
  const hits: StemHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    hits.push({ start, end, startCp: cp[start] ?? 0, endCp: cp[end] ?? 0 });
    // A zero-width match cannot happen (stem is non-empty), but lastIndex must still
    // advance past the match rather than by one, or overlapping stems double-count.
    re.lastIndex = end;
  }
  return hits;
}

/** Does any token in `text` begin with `stem`? Folds and normalises internally. */
export function containsStem(text: string, stem: string): boolean {
  return findStem(fold(text), stem).length > 0;
}

/** The first stem in `stems` that occurs, or null. Order is the caller's priority. */
export function firstMatchingStem(text: string, stems: readonly string[]): string | null {
  const folded = fold(text);
  const offsets = cpOffsets(folded);
  for (const stem of stems) {
    if (findStem(folded, stem, offsets).length > 0) return stem;
  }
  return null;
}

/**
 * Do all of `stems` occur IN ORDER, non-overlapping, within a window of `windowCp`
 * characters?
 *
 * This is how outbound forbidden phrases are stored (§6.7b): as ordered stem sequences
 * rather than contiguous substrings, because Mongolian puts words between them.
 * `['цаг', 'авл']` must catch «Таны цагийг маргааш 15:00-д авлаа» — four words apart,
 * one contiguous substring away from invisible.
 *
 * The window is measured in CODE POINTS, so an emoji in the middle of the phrase costs
 * one character of budget rather than two.
 *
 * Completeness: from a fixed first hit, chaining the earliest subsequent hit of each
 * later stem minimises the end of the chain, so if that chain overflows the window no
 * other chain from that start can fit. Trying every hit of the first stem therefore
 * decides the question exactly — this is not a heuristic.
 */
export function matchesStemSequence(
  text: string,
  stems: readonly string[],
  windowCp = 40,
): boolean {
  if (stems.length === 0) return false;
  const folded = fold(text);
  const offsets = cpOffsets(folded);

  const perStem = stems.map((s) => findStem(folded, s, offsets));
  if (perStem.some((hits) => hits.length === 0)) return false;

  const first = perStem[0];
  if (first === undefined) return false;

  for (const anchor of first) {
    let cursor = anchor.end;
    let last = anchor;
    let ok = true;
    for (let i = 1; i < perStem.length; i += 1) {
      const hits = perStem[i] ?? [];
      const next = hits.find((h) => h.start >= cursor);
      if (next === undefined) {
        ok = false;
        break;
      }
      cursor = next.end;
      last = next;
    }
    if (ok && last.endCp - anchor.startCp <= windowCp) return true;
  }
  return false;
}

/**
 * Reduce a whole message to its comparable form: NFC, folded, stripped of punctuation,
 * symbols, emoji and format characters, with whitespace collapsed.
 *
 * `whole_message` is the default and the only mode used for greetings (§6.8 rule 2),
 * because a greeting shortcut that fires on a PREFIX is a bug factory. The ancestor's
 * `GREETING_REGEX` is `/^(сайн|байна|уу|hi|hello|hey)/i` — anchored left, open right —
 * so «Уучлаарай асуумаар байна» ("Excuse me, I'd like to ask") is classified as a
 * greeting and that customer's actual question is never answered.
 */
export function wholeMessageKey(text: string): string {
  return fold(text)
    .replace(/[\p{P}\p{S}\p{C}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Is this message ABOUT the stems and nothing else?
 *
 * True when some word starts with one of `stems`, and EVERY word either starts with one
 * of `stems` or is exactly one of `coverWords`. The two lists are matched differently on
 * purpose. A stem is a prefix, so «тара» reaches «Тарагийн» and «будуул» reaches
 * «будуулахад» without a morphological analyser (the rule `containsStem` states). A cover
 * word is WHOLE, because it only ever says "this word may sit beside the topic": a prefix
 * «та» would cover «тайралт», and a haircut question would be read as a question about
 * the name.
 *
 * Words are the reduced form's space-separated runs — punctuation, symbols and emoji are
 * already gone — so «Tara salon мөн үү?» is four words and the question mark is none.
 */
export function coversMessage(text: string, stems: readonly string[], coverWords: readonly string[]): boolean {
  const words = wholeMessageKey(text).split(' ').filter((w) => w !== '');
  if (words.length === 0) return false;
  const anchors = stems.map((st) => fold(st)).filter((st) => st !== '');
  const cover = new Set(coverWords.map((w) => wholeMessageKey(w)).filter((w) => w !== ''));
  const isAnchor = (w: string): boolean => anchors.some((a) => w.startsWith(a));
  return words.some(isAnchor) && words.every((w) => isAnchor(w) || cover.has(w));
}

/**
 * The message's words, for `has_word` and `ends_with`: the reduced form's space-separated
 * runs, exactly the words `coversMessage` sees. Punctuation, symbols and emoji are gone.
 */
export function messageWords(text: string): string[] {
  return wholeMessageKey(text).split(' ').filter((w) => w !== '');
}

/**
 * Does the message contain one of `words` as a WHOLE word (or a whole run of words)?
 *
 * The comment surface needs words that are shorter than any stem floor could admit —
 * «ib», «pm», «хэд», «вэ» — and a whole-word match is what makes them safe: «хэд» does not
 * fire on «хэдийнээ», and «ib» does not fire on «ibiza». A prefix match on two letters
 * is the unanchored matcher rule 6 forbids; an equality test on a whole word is not.
 *
 * A listed entry of several words matches that run of consecutive words («мэдээлэл өгөөч»).
 * An entry with NO word in it — `?`, `😂` — cannot be a word, because punctuation and
 * emoji are stripped from the words; it is tested as a substring of the NFC text instead.
 * `?` also matches the full-width `？`. Symbols are not customer vocabulary in rule 6's
 * sense: a laughing emoji has no inflection to get wrong.
 */
export function hasWord(text: string, words: readonly string[]): boolean {
  const have = messageWords(text);
  const raw_ = nfc(text);
  for (const raw of words) {
    const want = messageWords(raw);
    if (want.length === 0) {
      const sym = nfc(raw).trim();
      if (sym === '') continue;
      if (raw_.includes(sym) || (sym === '?' && raw_.includes('\uFF1F'))) return true;
      continue;
    }
    for (let i = 0; i + want.length <= have.length; i += 1) {
      if (want.every((w, j) => have[i + j] === w)) return true;
    }
  }
  return false;
}

/**
 * Does the message's LAST word end with one of `endings`?
 *
 * Mongolian question particles are often typed fused to the word before them —
 * «арилдагуу» for «арилдаг уу», «хийдэгүү» — so a whole-word test for «уу» misses them.
 * Only the last word is read, because that is where the particle sits; a suffix test over
 * every word would fire on any noun that happens to end in «уу».
 */
export function endsWithAny(text: string, endings: readonly string[]): boolean {
  const words = messageWords(text);
  const last = words[words.length - 1];
  if (last === undefined) return false;
  return endings.some((e) => {
    const f = messageWords(e).join(' ');
    return f !== '' && last.endsWith(f);
  });
}

/**
 * Exact set membership over the reduced form. High precision, low recall, on purpose: a
 * missed greeting costs one cheap model call, and the model handles it perfectly. A
 * stolen question costs a customer (§6.8 rule 4).
 */
export function wholeMessageMatches(text: string, phrases: readonly string[]): boolean {
  const key = wholeMessageKey(text);
  if (key === '') return false;
  return phrases.some((p) => wholeMessageKey(p) === key);
}
