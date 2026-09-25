/**
 * Two things a reply must not say, found by reading what was SENT (D-123, goal 4 of the
 * overnight brief).
 *
 * The morning report missed «ci henbe»: the customer asked who the bot is and the reply named
 * the salon «Матрикс» — its name before the rebrand — and nothing in the flaw signals
 * (correction, repeat, handoff, refusal, "didn't understand") reads a reply's CONTENT. These
 * two checks do.
 *
 * 1. **A former name.** The names a tenant no longer uses are ROWS
 *    (`tenants.former_names`, 0046), never a literal here: the next salon to rebrand fills in
 *    a column. Links are masked first — `matrixecosalon.org` is the salon's real, current
 *    website until the domain changes, and quoting it is not calling the salon Matrix.
 * 2. **Internal instructions, unasked.** A gate label («Ш0»), a section heading copied in
 *    capitals («БЭЛЭН ХАРИУЛТ»), an internal identifier (`refusal_price_unlisted`,
 *    `facebook_page`), or the bot describing its instructions or the data it was given
 *    («надад өгсөн мэдээлэл», «зааварчилгаа»). Approved text is cut out first, so a reviewed
 *    line that happens to say «мэдээлэл» is never flagged; and when the CUSTOMER asked about
 *    the bot, its rules or its instructions, the mention is an answer, not a leak.
 *
 * Both are reported, not enforced. The outbound guard's item 0 already refuses a gate label
 * before sending (D-066); these read the replies that went out anyway.
 */
import { fold, nfc } from '../mn/text.ts';
import { containsStem, matchesStemSequence } from '../mn/match.ts';
import { maskUrls } from '../mn/extract.ts';
import { SECTION_LABELS } from '../prompt/tenant.ts';

/** The first former name the reply uses, or null. Whole-token prefix, after masking links. */
export function formerNameIn(reply: string, formerNames: readonly string[]): string | null {
  const text = maskUrls(reply);
  for (const name of formerNames) {
    const n = fold(nfc(name)).trim();
    if (n !== '' && containsStem(text, n)) return name;
  }
  return null;
}

const GATE_LABEL = /(?<![\p{L}\p{N}])Ш\d{1,2}(?![\p{L}\p{N}])/u;
/** Internal identifiers are lower_snake ASCII by construction: kinds, keys, channel names. */
const SNAKE_ID = /(?<![\p{L}\p{N}_])[a-z]+_[a-z_]+(?![\p{L}\p{N}_])/u; // ascii-safe: internal identifiers are ASCII snake_case

/**
 * Words that describe the bot's own instructions or the data it was handed. Matched as
 * token prefixes over the folded reply, after approved text is cut out.
 */
export const INSTRUCTION_STEMS: readonly string[] = [
  // «заавар» drops its vowel when inflected: «зааврын», «зааврынхаа». Both stems are needed;
  // the live «ci henbe» reply said «Дотоод зааврынхаа талаар…» and the first form missed it.
  'заавар', 'заавр', 'зааварчилгаа', 'дотоод', 'системийн', 'промпт', 'prompt', 'instruction',
  'тухайн байгууллагын мэдээлэл',
  'надад өгсөн', 'надад өгөгдсөн', 'өгөгдсөн мэдээлэл', 'миний мэдээлэлд', 'миний мэдээллийн',
  'мэдээллийн сан', 'тохиргоо', 'дүрмийн дагуу', 'дүрмээр',
];

/** A customer asking about the bot itself — then describing it is an answer. */
export const ASKED_ABOUT_BOT_STEMS: readonly string[] = [
  'заавар', 'заавр', 'дүрэм', 'prompt', 'промпт', 'систем', 'instruction', 'тохиргоо', 'бот', 'bot', 'хиймэл', 'robot', 'робот',
];

/** Remove every approved text from the reply, leaving a gap, so nothing spans the cut. */
function withoutApproved(reply: string, approved: readonly string[]): string {
  let out = nfc(reply);
  for (const a of [...approved].map((x) => nfc(x).trim()).filter((x) => x !== '').sort((x, y) => y.length - x.length)) {
    out = out.split(a).join('\n');
  }
  return out;
}

/** What internal thing the reply mentioned, or null. */
export function internalMentionIn(
  reply: string, customer: string, approved: readonly string[],
): string | null {
  if (ASKED_ABOUT_BOT_STEMS.some((s) => containsStem(customer, s))) return null;
  const rest = maskUrls(withoutApproved(reply, approved));
  const label = GATE_LABEL.exec(rest);
  if (label !== null) return `gate label ${label[0]}`;
  const id = SNAKE_ID.exec(rest);
  if (id !== null) return `identifier ${id[0]}`;
  if (rest.includes('===')) return 'section marker ===';
  for (const heading of Object.values(SECTION_LABELS)) {
    // Case-SENSITIVE on purpose: «холбоо барих» is ordinary Mongolian; the heading in
    // capitals is the prompt's own text copied out.
    if (rest.includes(heading)) return `heading ${heading}`;
  }
  const stem = INSTRUCTION_STEMS.find((s) => containsStem(rest, s));
  return stem === undefined ? null : `mentions «${stem}»`;
}

/**
 * The ENFORCED form of the check above, for the reply path (founder, 2026-09-26: "never mention
 * internal instructions unless asked"). Narrower on purpose: `internalMentionIn` reports, and a
 * report can afford «тохиргоо» (setup) and «мэдээллийн сан» (database), which DalaTech's own
 * answers about its product legitimately use. What refuses a reply here is only what cannot be
 * an answer about the business: the structural leaks (a gate label, an internal identifier, a
 * section marker or heading) and the bot talking about ITS instructions — «промпт», «заавар»
 * with «дотоод» or «систем» before it, or in the reflexive possessive («зааврынхаа»,
 * «заавартаа»), which is "my own instructions". Measured live: «Дотоод зааврынхаа талаар
 * хуваалцах боломжгүй» to a customer who asked «ci henbe».
 */
const LEAK_STEMS: readonly string[] = ['промпт', 'prompt', 'instruction', 'зааварчилгаа', 'зааврынхаа', 'заавартаа', 'зааврандаа', 'зааврыгаа'];
const LEAK_SEQUENCES: readonly (readonly string[])[] = [['дотоод', 'заавр'], ['дотоод', 'заавар'], ['системийн', 'заавр'], ['системийн', 'заавар']];

export function instructionLeakIn(reply: string, customer: string, approved: readonly string[]): string | null {
  if (ASKED_ABOUT_BOT_STEMS.some((s) => containsStem(customer, s))) return null;
  const rest = maskUrls(withoutApproved(reply, approved));
  const label = GATE_LABEL.exec(rest);
  if (label !== null) return `gate label ${label[0]}`;
  const id = SNAKE_ID.exec(rest);
  if (id !== null) return `identifier ${id[0]}`;
  if (rest.includes('===')) return 'section marker ===';
  for (const heading of Object.values(SECTION_LABELS)) {
    if (rest.includes(heading)) return `heading ${heading}`;
  }
  const stem = LEAK_STEMS.find((s) => containsStem(rest, s));
  if (stem !== undefined) return `mentions «${stem}»`;
  const seq = LEAK_SEQUENCES.find((q) => matchesStemSequence(rest, q, 24));
  return seq === undefined ? null : `mentions «${seq.join(' … ')}»`;
}
