/**
 * A customer who names one of the tenant's hairdressers, and nothing else or a booking ask,
 * is answered from the rows: who she is, what she does at her level, her deposit, and how to
 * book (2026-10-09, overnight session; Goal D of the founder's brief).
 *
 * Measured on Tara Яармаг (2026-10-04): «Оюунаа» alone got the model's «Уучлаарай, та юу асуух
 * гэснээ тодруулж бичнэ үү?», and «Оюунаад цаг авч болох уу?» got the three generic deposit rows
 * and the booking line, neither naming Oyunaa nor saying her deposit is the SPECIAL 20,000₮.
 *
 * ## Only rows, no new sentence
 *
 * Every line served is the tenant's own data or an approved line, byte for byte:
 *   1. «{name} — {tier}»: the roster row's name and level, as `БАГИЙН ЖАГСААЛТ` renders them;
 *   2. (bare name only) the price-list rows whose variant is her level («Эмэгтэй тайралт
 *      (SPECIAL): 120,000₮»), never a row naming the other group's customers («эрэгтэй» for a
 *      women's hairdresser): the level-named services only she, at that level, does;
 *   3. the deposit row for her level («Урьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮»);
 *   4. the reviewed `booking_line`.
 * The composed answers are on the founder's sheet `prompt/drafts/tara_stylist_named_2026-10-09.mn.txt`.
 *
 * ## When, exactly
 *
 * The message must name exactly ONE person on the roster: her Latin name as a word (a known case
 * ending may follow: «Oyunaad»), or a Cyrillic spelling the tenant's `spellings` rows give for it
 * («Оюунаа», «Оюунаад»). A tenant with no spelling for a name is matched on the Latin name only (Парк Од's
 * hairdressers have none yet: never guessed). Then either the name is ALL the message says
 * (punctuation and emoji aside), or every other word is a plain booking ask from a closed list
 * («цаг авч болох уу», «захиалъя», Latin «tsag avmaar baina») and no price word. Anything else,
 * two names, or a person whose level, deposit row or the booking line is missing, goes on as
 * before. The caller also skips it for a complaint or a message a gate or topic rule fired on. Rule 6: words split on letters and digits (`\p{L}\p{N}`), stems by code point.
 */
import { fold } from '../mn/text.ts';
import type { Spelling } from '../mn/latin.ts';
import { sectionRows } from '../quality/serviceNames.ts';
import type { PricedService } from '../quality/serviceNames.ts';

export type RosterRow = { name: string; shortName: string | null; group: string | null; tier: string | null };

/** The roster as the compiled prefix renders it: «- Name (Short) · Group · Tier». */
export function rosterFromPrefix(promptStable: string, label: string): RosterRow[] {
  return sectionRows(promptStable, label).map((row) => {
    const parts = row.split(' · ').map((p) => p.trim());
    const first = parts[0] ?? '';
    const short = /^(.*?)\s*\(([^()]+)\)$/u.exec(first);
    return {
      name: (short?.[1] ?? first).trim(),
      shortName: short?.[2]?.trim() ?? null,
      group: parts[1] ?? null,
      tier: parts[2] ?? null,
    };
  }).filter((r) => r.name !== '');
}

function wordsOf(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

/** The forms a person's name takes in a message: her Latin names, and their Cyrillic spellings. */
function formsOf(r: RosterRow, spellings: readonly Spelling[]): string[] {
  const latin = [r.name, r.shortName].filter((n): n is string => n !== null && n !== '').map(fold);
  const cyr = spellings.filter((s) => latin.includes(fold(s.latin))).map((s) => fold(s.cyrillic));
  return [...new Set([...latin, ...cyr])].filter((f) => !/\s/u.test(f) && [...f].length >= 3);
}

/**
 * Case endings a name may carry («Оюунаад», «Оюунаагаас», «Oyunaa-d»). A closed list, never any
 * continuation: «saraas» (from the month) is not Saraa, «tomoohon» (big) is not Tomoo (review,
 * 2026-10-09). A hyphen splits «Oyunaa-d» into two words; the «d» is then a booking word below.
 */
const NAME_ENDINGS: readonly string[] = [
  'д', 'т', 'аас', 'ээс', 'оос', 'өөс', 'гаас', 'гээс', 'тай', 'тэй', 'той', 'г', 'ыг', 'ийг', 'гийн', 'ийн', 'гаар', 'гээр', 'аар', 'ээр',
  'd', 't', 'aas', 'ees', 'oos', 'gaas', 'gees', 'tai', 'tei', 'toi', 'g', 'iig', 'giin', 'iin', 'gaar', 'geer', 'aar', 'eer',
];

/** Does `word` name the person: the form itself, or the form and one known case ending. */
function names(word: string, form: string): boolean {
  if (word === form) return true;
  if (!word.startsWith(form)) return false;
  const tail = word.slice(form.length);
  return NAME_ENDINGS.includes(tail);
}

/**
 * The words a plain booking ask is made of, and nothing else («Оюунаад цаг авч болох уу?»,
 * «Oyunaa-d tsag avmaar baina»). CLOSED on purpose: any other word — a past tense («авсан»,
 * «захиалсан»), a cancel or a change, «өөр», «нөхөртөө», a service, a complaint, a payment, the
 * customer introducing herself («Bi Saraa…») — sends the message to the model as before.
 */
const TIME_WORDS: readonly string[] = ['цаг', 'tsag', 'cag'];
const TAKE_WORDS: readonly string[] = ['авч', 'авах', 'авъя', 'авья', 'авмаар', 'avch', 'avah', 'avya', 'aviya', 'avmaar'];
const BOOK_WORDS: readonly string[] = [
  'захиалах', 'захиалъя', 'захиалья', 'захиалмаар', 'захиалж', 'zahialah', 'zahialya', 'zahialiya', 'zahialmaar', 'zahialj',
  'zakhialah', 'zakhialya', 'zakhialmaar', 'zakhialj',
];
const FILLER_WORDS: readonly string[] = [
  'болох', 'болно', 'бол', 'уу', 'үү', 'вэ', 'байна', 'бна', 'юм', 'd', 't', 'boloh', 'bolno', 'bol', 'uu', 'vv', 've', 'baina', 'bna', 'bn',
];

/** Every word but the name is a booking word, and there is a booking (time + take, or «захиал…»). */
function asksToBook(rest: readonly string[]): boolean {
  if (rest.length === 0) return false;
  const known = [...TIME_WORDS, ...TAKE_WORDS, ...BOOK_WORDS, ...FILLER_WORDS];
  if (!rest.every((w) => known.includes(w))) return false;
  return rest.some((w) => BOOK_WORDS.includes(w))
    || (rest.some((w) => TIME_WORDS.includes(w)) && rest.some((w) => TAKE_WORDS.includes(w)));
}

export type StylistNamedInput = {
  customerMessage: string;
  roster: readonly RosterRow[];
  spellings: readonly Spelling[];
  serviceNames: readonly PricedService[];
  depositRows: readonly string[];
  bookingLine: string | null;
  /** The price path's own test: a price question is never answered here. */
  asksPrice: (text: string) => boolean;
};

export type StylistNamed = { name: string; intent: 'bare' | 'booking'; body: string } | null;

export function stylistNamedReply(input: StylistNamedInput): StylistNamed {
  if (input.bookingLine === null || input.bookingLine.trim() === '') return null;
  const words = wordsOf(input.customerMessage);
  if (words.length === 0) return null;

  const hits = input.roster.filter((r) => {
    const forms = formsOf(r, input.spellings);
    return words.some((w) => forms.some((f) => names(w, f)));
  });
  if (hits.length !== 1) return null;
  const person = hits[0]!;
  if (person.tier === null || person.tier === '') return null;
  const forms = formsOf(person, input.spellings);
  const rest = words.filter((w) => !forms.some((f) => names(w, f)));

  const intent: 'bare' | 'booking' | null = rest.length === 0
    ? 'bare'
    : asksToBook(rest) && !input.asksPrice(input.customerMessage) ? 'booking' : null;
  if (intent === null) return null;

  const tier = fold(person.tier);
  const deposit = levelDepositRow(person, input.depositRows);
  if (deposit === null) return null;

  const lines = [`${person.name} — ${person.tier}`];
  if (intent === 'bare') {
    // Her level's token («SPECIAL», «Мастер», «1-р»), as the price list writes it in a variant.
    const level = tier.split(/\s+/u)[0] ?? '';
    const own = person.group === null ? '' : fold(person.group).split(/\s+/u)[0] ?? '';
    const others = [...new Set(input.roster.map((r) => (r.group === null ? '' : fold(r.group).split(/\s+/u)[0] ?? '')))]
      .filter((g) => g !== '' && g !== own);
    for (const sv of input.serviceNames) {
      for (const row of sv.rows) {
        const variant = /\(([^()]+)\)\s*:/u.exec(row)?.[1];
        if (variant === undefined || level === '') continue;
        const first = fold(variant).split(/[,\s]+/u)[0] ?? '';
        if (first !== level) continue;
        if (others.some((g) => fold(row).includes(g))) continue;
        lines.push(row);
      }
    }
  }
  lines.push(deposit);
  return { name: person.name, intent, body: `${lines.join('\n')}\n\n${input.bookingLine.trim()}` };
}

/**
 * The deposit row for a person's level: the first row naming her level's token («special»,
 * «мастер», «1-р»). Яармаг writes one row per level («SPECIAL үсчин: 20,000₮»), Парк Од one row
 * for two («SPECIAL болон Мастер үсчин: 20,000₮»); both are found. Null when no row names it.
 */
export function levelDepositRow(person: RosterRow, depositRows: readonly string[]): string | null {
  if (person.tier === null || person.tier === '') return null;
  const level = fold(person.tier).split(/\s+/u)[0] ?? '';
  if (level === '') return null;
  return depositRows.find((r) => fold(r).includes(level)) ?? null;
}

/** The roster people `text` names by Latin name or short name, whole words with a known ending. */
export function rosterNamedIn(text: string, roster: readonly RosterRow[]): RosterRow[] {
  const words = wordsOf(text);
  return roster.filter((r) => formsOf(r, []).some((f) => words.some((w) => names(w, f))));
}
