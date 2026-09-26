/**
 * Everyday chat Mongolian — Latin letters and Cyrillic shorthand — read the way the same
 * message in full Cyrillic is read, for EVERY tenant (founder, 2026-09-27).
 *
 * ## The instance
 *
 * 2026-09-26 18:05 UTC, Tara: the founder wrote «bnu» — the everyday way to type «байна уу»,
 * a greeting — and got the model's «Уучлаарай, ойлгосонгүй. Асуух зүйл байвал бичээрэй.»
 * Tara's `greeting` row lists «sain bnu» and «sn bnu» but not a bare «bnu», and not a bare
 * «байна уу» either, so the message matched nothing and went to the model, which does not read
 * chat shorthand reliably. DalaTech's list had the same hole. Each tenant's list was a
 * hand-kept enumeration of spellings, and every new client would have started with the gap.
 *
 * ## What this does, and why it is platform code rather than rows
 *
 * D-067 made Latin coverage a tenant's ROWS, and that stays right for a tenant's own
 * vocabulary («huuhd» for «хүүхд»). Greetings, thanks, «ok» and the few words every short
 * question is built from («une hed ve») are not a tenant's vocabulary; they are the language.
 * Writing them into each tenant's rows is the per-client repetition CLAUDE.md forbids.
 *
 *  - `chatCanonical`: a message that is WHOLLY a greeting, a thanks or an acknowledgement —
 *    in Latin letters or Cyrillic shorthand, any case, any punctuation or emoji — reads as its
 *    canonical Cyrillic form: «сайн байна уу», «баярлалаа», «за». Every tenant whose greeting
 *    row carries «сайн байна уу» (every greeting row does) now answers «bnu», «sn bnuu»,
 *    «сн бну» and a bare «байна уу» with that row, exactly as it answers the full form.
 *  - `PLATFORM_SPELLINGS`: common chat words, merged UNDER the tenant's own spellings (the
 *    tenant's row wins on the same key), so «une hed ve» is also matched as «үнэ хэд вэ».
 *
 * Both only produce the SECOND text every matcher already tries (`respelled`, D-120). The
 * customer's own words are always matched too, and the model is never shown this text: it can
 * add a match, it cannot hide what the customer wrote.
 *
 * Rule 6: no `[a-z]`, `\w` or `\b`. Keys are compared whole after `wholeMessageKey`.
 */
import { wholeMessageKey } from './match.ts';
import { respell, type Spelling } from './latin.ts';

export type ChatKind = 'greeting' | 'thanks' | 'ack';

/** The canonical Cyrillic each kind is matched as. */
export const CHAT_CANONICAL: Readonly<Record<ChatKind, string>> = {
  greeting: 'сайн байна уу',
  thanks: 'баярлалаа',
  ack: 'за',
};

/**
 * Whole messages, as `wholeMessageKey` reduces them (lower case, punctuation and emoji gone,
 * single spaces). Runs of one letter are squeezed to two before lookup («bnuuu» → «bnuu»),
 * so the list names each shape once.
 */
const FORMS: Readonly<Record<ChatKind, readonly string[]>> = {
  greeting: [
    // Cyrillic, full and shorthand.
    'сайн байна уу', 'сайн байна у', 'сайн бна уу', 'сайн бн уу', 'сайн бнуу', 'сайн бну', 'сайн байнуу',
    'сайн байнау', 'сайн бну уу', 'сн бну уу', 'сайнуу', 'сайн уу', 'сн бну', 'сн бнуу', 'сн бна уу', 'сн байна уу', 'сну', 'снуу',
    'байна уу', 'бна уу', 'бн уу', 'бну', 'бнуу', 'байнуу', 'сайн байцгаана уу',
    'мэнд', 'мэнд хүргэе', 'оройн мэнд', 'өглөөний мэнд', 'өдрийн мэнд',
    // Latin.
    'sain baina uu', 'sain baina u', 'sain bna uu', 'sain bn uu', 'sain bnuu', 'sain bnu', 'sain bainuu',
    'sain bainu', 'sain bna u', 'sainuu', 'sain uu', 'sn bnu', 'sn bnuu', 'sn bna uu', 'sn baina uu',
    'sn bn uu', 'sain bnu uu', 'sn bnu uu', 'sain bnuu uu', 'snu', 'snuu', 'baina uu', 'bna uu', 'bn uu', 'bnu', 'bnuu', 'bainuu', 'bainu',
    'sain baitsgaana uu', 'mend', 'mend hurgeye', 'oroin mend', 'ugluunii mend', 'udriin mend',
    'hi', 'hii', 'hello', 'helo', 'hey', 'hai',
  ],
  thanks: [
    'баярлалаа', 'баярллаа', 'баярлаа', 'их баярлалаа', 'за баярлалаа', 'маш их баярлалаа',
    'баярлалаа танд', 'танд баярлалаа', 'баярлалаа та', 'ок баярлалаа', 'баярла', 'баярлалаа ок',
    // Mixed script, as typed: a Latin «ok» or «za» before Cyrillic thanks.
    'ok баярлалаа', 'ok баярллаа', 'ok баярла', 'za баярлалаа', 'баярлалаа ok',
    'bayarlalaa', 'bayrlalaa', 'bayarllaa', 'bayrllaa', 'bayarlaa', 'bayrlaa', 'bayrla', 'bayarla',
    'ih bayarlalaa', 'ih bayrlalaa', 'za bayarlalaa', 'za bayrlalaa', 'mash ih bayarlalaa',
    'mash ih bayrlalaa', 'bayarlalaa tand', 'bayrlalaa tand', 'tand bayarlalaa', 'tand bayrlalaa',
    'ok bayarlalaa', 'ok bayrlalaa', 'thanks', 'thank you', 'thanks a lot', 'thx', 'ty', 'ok thanks',
  ],
  ack: [
    'за', 'заа', 'за за', 'ок', 'окей', 'ok', 'okay', 'okey', 'oki', 'okk', 'za', 'zaa', 'za za', 'ok ok',
  ],
};

/** «bnuuu» → «bnuu», «заааа» → «заа»: customers stretch letters freely. */
function squeeze(key: string): string {
  let out = '';
  let run = 0;
  let prev = '';
  for (const ch of key) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run <= 2) out += ch;
  }
  return out;
}

const LOOKUP: ReadonlyMap<string, ChatKind> = new Map(
  (Object.keys(FORMS) as ChatKind[]).flatMap((kind) => FORMS[kind].map((f) => [squeeze(wholeMessageKey(f)), kind] as const)),
);

/** The kind of a message that is wholly a greeting, thanks or acknowledgement; else null. */
export function chatKind(text: string): ChatKind | null {
  const key = squeeze(wholeMessageKey(text));
  return key === '' ? null : LOOKUP.get(key) ?? null;
}

/** The canonical Cyrillic of such a message, or null. */
export function chatCanonical(text: string): string | null {
  const kind = chatKind(text);
  return kind === null ? null : CHAT_CANONICAL[kind];
}

/**
 * Common chat words in Latin letters (and a few Cyrillic contractions a customer types). Only
 * words whose meaning does not depend on the business: greetings, thanks, and the words short
 * questions about price, time, place and booking are made of.
 */
export const PLATFORM_SPELLINGS: readonly Spelling[] = [
  // Greetings and thanks, word by word, for messages that carry more than the greeting.
  ['sain', 'сайн'], ['sn', 'сайн'], ['baina', 'байна'], ['bna', 'байна'], ['bnu', 'байна уу'],
  ['bnuu', 'байна уу'], ['bainuu', 'байна уу'], ['uu', 'уу'], ['sainuu', 'сайн уу'],
  ['bayarlalaa', 'баярлалаа'], ['bayrlalaa', 'баярлалаа'], ['bayarllaa', 'баярлалаа'],
  ['bayrllaa', 'баярлалаа'], ['bayarlaa', 'баярлалаа'], ['bayrlaa', 'баярлалаа'], ['ih', 'их'],
  ['mash', 'маш'], ['za', 'за'], ['tand', 'танд'], ['ta', 'та'], ['chi', 'чи'],
  // Short questions.
  ['une', 'үнэ'], ['vne', 'үнэ'], ['uniin', 'үнийн'], ['vniin', 'үнийн'], ['uniig', 'үнийг'],
  ['unetei', 'үнэтэй'], ['vnetei', 'үнэтэй'], ['hed', 'хэд'], ['heden', 'хэдэн'], ['hden', 'хэдэн'],
  ['hedeer', 'хэдээр'], ['hedee', 'хэдээ'], ['ve', 'вэ'], ['we', 'вэ'], ['be', 'бэ'], ['yu', 'юу'],
  ['yum', 'юм'], ['yamar', 'ямар'], ['ymar', 'ямар'], ['hen', 'хэн'], ['haana', 'хаана'],
  ['hayag', 'хаяг'], ['hayg', 'хаяг'], ['xayag', 'хаяг'], ['tsag', 'цаг'], ['cag', 'цаг'],
  ['avya', 'авъя'], ['avii', 'авъя'], ['avah', 'авах'], ['avmaar', 'авмаар'], ['zahialya', 'захиалъя'],
  ['zahialah', 'захиалах'], ['zahialga', 'захиалга'], ['zahialmaar', 'захиалмаар'],
  ['margaash', 'маргааш'], ['unuudur', 'өнөөдөр'], ['unuudr', 'өнөөдөр'], ['odoo', 'одоо'],
  ['boloh', 'болох'], ['bolohuu', 'болох уу'], ['bolh', 'болох'], ['medeelel', 'мэдээлэл'],
].map(([latin, cyrillic]) => ({ latin: latin as string, cyrillic: cyrillic as string }));

/** Every Latin key the platform list settles — the spelling proposer never asks about these. */
export const PLATFORM_LATIN: ReadonlySet<string> = new Set(PLATFORM_SPELLINGS.map((s) => s.latin));

/**
 * The second text every matcher tries (`respelled`): the canonical form of a whole greeting,
 * thanks or acknowledgement; otherwise the message with the platform's and the tenant's Latin
 * spellings replaced (the tenant's row wins on the same key); null when nothing changes.
 */
export function matchingText(text: string, tenantSpellings: readonly Spelling[]): string | null {
  const canonical = chatCanonical(text);
  if (canonical !== null) return wholeMessageKey(text) === canonical ? null : canonical;
  // `respell` keeps the LAST row per key, so the tenant's rows go after the platform's.
  return respell(text, [...PLATFORM_SPELLINGS, ...tenantSpellings]);
}
