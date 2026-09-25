/**
 * Mongolian written in Latin letters, and the tenant's own words it could mean.
 *
 * ## Why this is not a transliteration engine
 *
 * D-067 decided the fix for Latin-script customers is ROWS: a tenant stores `huuhd` beside
 * `хүүхд`, and `containsStem` is script-agnostic. The founder's flaw loop (D-120) asks for
 * that list to GROW from real messages rather than by hand — so something has to propose
 * rows. This module is that something, and it is deliberately smaller than a
 * transliterator:
 *
 *  - It never turns Latin into Cyrillic on its own. It asks one question — which words the
 *    tenant's OWN text contains could this token be — and answers with words that exist.
 *  - It is lossy on purpose. Customers write «ү» as `u`, `v` or `w`, «ө» as `o` or `u`, and
 *    «ы», «ий», «ь» all as `i`/`ii`. So the comparison key merges those letters into one
 *    vowel class each. Two words the key cannot tell apart («үсний» and «усны» are both
 *    `UsnI`) come back as TWO candidates, and the caller settles them by context or asks.
 *
 * A key collision is therefore never an error here. It is the exact question the founder
 * named — «usnii» — surfacing as data instead of as a guess.
 *
 * Rule 6 holds: no `[a-z]`, no `\w`, no `\b`. Latin is recognised by `\p{Script=Latin}`,
 * and every letter mapping is an explicit table, so a letter this module has never seen
 * makes the token unmappable rather than silently dropped.
 */
import { fold, nfc } from './text.ts';

/** Words shorter than this are not proposed or applied: «bi», «ok» and «hi» are everywhere. */
export const MIN_SPELLING_CP = 3;

/**
 * Cyrillic → key. Vowel classes are upper case (A, E, I, U) so they can never collide with a
 * consonant; «ц» and «ч» share `C` because Latin `c` is used for both.
 */
const CYR: Record<string, string> = {
  'а': 'A', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'E', 'ё': 'yU', 'ж': 'j', 'з': 'z',
  'и': 'I', 'й': 'I', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'U', 'ө': 'U', 'п': 'p',
  'р': 'r', 'с': 's', 'т': 't', 'у': 'U', 'ү': 'U', 'ф': 'f', 'х': 'h', 'ц': 'C', 'ч': 'C',
  'ш': 'S', 'щ': 'S', 'ъ': '', 'ы': 'I', 'ь': 'I', 'э': 'E', 'ю': 'yU', 'я': 'yA',
};

/** Latin digraphs, tried before single letters. */
const LAT2: Record<string, string> = {
  'kh': 'h', 'sh': 'S', 'ch': 'C', 'ts': 'C', 'tz': 'C', 'zh': 'j',
  'ya': 'yA', 'yu': 'yU', 'yo': 'yU', 'ye': 'E',
};

/**
 * Latin letters. An array is a letter customers use for two different Cyrillic letters:
 * `v` is «ү» in «vsnii» and «в» in «avah», so both are tried.
 */
const LAT1: Record<string, string | readonly string[]> = {
  'a': 'A', 'b': 'b', 'c': 'C', 'd': 'd', 'e': 'E', 'f': 'f', 'g': 'g', 'h': 'h', 'i': 'I',
  'j': 'j', 'k': 'k', 'l': 'l', 'm': 'm', 'n': 'n', 'o': 'U', 'p': 'p', 'q': 'k', 'r': 'r',
  's': 's', 't': 't', 'u': 'U', 'v': ['v', 'U'], 'w': 'U', 'x': 'h', 'y': 'I', 'z': 'z',
  // Chat shorthand: «4» for «ч», «6» for «ш».
  '4': 'C', '6': 'S',
};

/** At most this many `v`s are branched; a token with more is left alone rather than exploded. */
const MAX_BRANCHES = 16;

/** Collapse runs of the same key symbol: doubled vowels and letters are written freely. */
function collapse(key: string): string {
  let out = '';
  for (const ch of key) if (out[out.length - 1] !== ch) out += ch;
  return out;
}

const LATIN_LETTER = /\p{Script=Latin}/u;
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;

/** A token of Latin letters (plus the shorthand digits), with at least one letter. */
export function isLatinToken(token: string): boolean {
  const cps = [...token];
  return cps.some((c) => LATIN_LETTER.test(c)) && cps.every((c) => LATIN_LETTER.test(c) || c === '4' || c === '6');
}

/** A token of Cyrillic letters only. */
export function isCyrillicToken(token: string): boolean {
  const cps = [...token];
  return cps.length > 0 && cps.every((c) => CYRILLIC_LETTER.test(c));
}

/** The key of a Cyrillic word, or null when it holds a letter the table does not know. */
export function cyrillicKey(word: string): string | null {
  let out = '';
  for (const ch of fold(word)) {
    const k = CYR[ch];
    if (k === undefined) return null;
    out += k;
  }
  return out === '' ? null : collapse(out);
}

/**
 * Every key a Latin token could have — more than one only where a letter is ambiguous.
 * Empty when the token holds anything the tables do not know.
 */
export function latinKeys(token: string): string[] {
  const t = fold(token);
  let partials: string[] = [''];
  let i = 0;
  const cps = [...t];
  while (i < cps.length) {
    const two = `${cps[i] ?? ''}${cps[i + 1] ?? ''}`;
    const d = LAT2[two];
    if (d !== undefined && i + 1 < cps.length) {
      partials = partials.map((p) => p + d);
      i += 2;
      continue;
    }
    const s = LAT1[cps[i] ?? ''];
    if (s === undefined) return [];
    const options = typeof s === 'string' ? [s] : s;
    partials = partials.flatMap((p) => options.map((o) => p + o));
    if (partials.length > MAX_BRANCHES) return [];
    i += 1;
  }
  return [...new Set(partials.filter((p) => p !== '').map(collapse))];
}

/** Letter-and-digit runs with their UTF-16 offsets. Punctuation, emoji and spaces separate. */
export function tokens(text: string): { token: string; start: number; end: number }[] {
  const s = nfc(text);
  return [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ token: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

export type Spelling = {
  /** One Latin word, or two separated by one space, lower case. */
  latin: string;
  cyrillic: string;
};

/**
 * The message with every known Latin spelling replaced by its word, or null when nothing
 * was replaced. Two-word rows win over one-word rows: a row keyed on the neighbour is the
 * one context settled.
 *
 * Only ever used as a SECOND text to match against, never instead of the customer's own
 * words and never shown to the model: a spelling the data settled wrongly can make a rule
 * fire that should not, but it cannot hide the words the customer actually wrote.
 */
export function respell(text: string, spellings: readonly Spelling[]): string | null {
  if (spellings.length === 0) return null;
  const words = new Map<string, string>();
  const pairs = new Map<string, string>();
  for (const s of spellings) {
    const key = fold(s.latin).trim();
    if (key.includes(' ')) pairs.set(key, nfc(s.cyrillic));
    else words.set(key, nfc(s.cyrillic));
  }
  const src = nfc(text);
  const toks = tokens(src);
  let out = '';
  let at = 0;
  let changed = false;
  for (let i = 0; i < toks.length; i += 1) {
    const a = toks[i];
    if (a === undefined) continue;
    const b = toks[i + 1];
    const la = fold(a.token);
    if (b !== undefined && isLatinToken(a.token) && isLatinToken(b.token)) {
      const pair = pairs.get(`${la} ${fold(b.token)}`);
      if (pair !== undefined) {
        out += src.slice(at, a.start) + pair;
        at = b.end;
        changed = true;
        i += 1;
        continue;
      }
    }
    if (!isLatinToken(a.token)) continue;
    const word = words.get(la);
    if (word === undefined) continue;
    out += src.slice(at, a.start) + word;
    at = a.end;
    changed = true;
  }
  return changed ? out + src.slice(at) : null;
}
