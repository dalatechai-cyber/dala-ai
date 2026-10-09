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
 * The message must name exactly ONE person on the roster: her Latin name as a word (a suffix may
 * follow: «Oyunaad»), or a Cyrillic spelling the tenant's `spellings` rows give for it («Оюунаа»,
 * «Оюунаад»). A tenant with no spelling for a name is matched on the Latin name only (Парк Од's
 * hairdressers have none yet: never guessed). Then either the name is ALL the message says
 * (punctuation and emoji aside), or it asks to book («цаг ав…», «захиал…», Latin «tsag av…»,
 * «zahial…»/«zakhial…») and does not ask a price (a price question is the price path's). Anything
 * else, two names, or a person whose level, deposit row or the booking line is missing, goes on
 * as before. Rule 6: words split on letters and digits (`\p{L}\p{N}`), stems by code point.
 */
import { fold } from '../mn/text.ts';
import { containsStem } from '../mn/match.ts';
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

/** Does `word` name the person: the form itself, or (four letters or more) the form with a suffix. */
function names(word: string, form: string): boolean {
  return word === form || ([...form].length >= 4 && word.startsWith(form));
}

const BOOK_STEMS: readonly string[] = ['захиал', 'zahial', 'zakhial', 'zaxial'];
const TIME_STEMS: readonly string[] = ['цаг', 'tsag', 'cag'];
const TAKE_STEMS: readonly string[] = ['ав', 'av'];

function asksToBook(text: string): boolean {
  return BOOK_STEMS.some((s) => containsStem(text, s))
    || (TIME_STEMS.some((s) => containsStem(text, s)) && TAKE_STEMS.some((s) => containsStem(text, s)));
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
    : asksToBook(input.customerMessage) && !input.asksPrice(input.customerMessage) ? 'booking' : null;
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
