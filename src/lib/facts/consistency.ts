/**
 * One fact, one spelling, one price: every copy of it must agree (founder, 2026-09-27).
 *
 * A tenant's facts are written in many places: the price rows, the FAQ, the fixed replies,
 * the reviewed canned lines, the KB documents, and outside this repo (the website chatbot).
 * On 2026-09-27 the role names were lower-cased in the price rows and a copy that still
 * said «Маркетинг менежер» was only found because a customer saw it. This check finds the
 * copies that disagree before a publish can send them:
 *
 *  - **Spelling.** A service named «X — label» fixes how the label is written. A copy that
 *    writes the same label with different capitals is a finding, unless the difference is
 *    only the first letter at the start of a sentence, where a capital is the grammar.
 *  - **Price.** A line that names a service may state only amounts that service's rows
 *    carry (every service it names, pooled: a bundle line names its parts). An amount in
 *    ₮ or «төгрөг» that no named service carries is a second price for the item.
 *
 * The services are rows, so nothing here names a tenant. A line that names no service says
 * nothing about a price and is not read for one (a VAT rate, a discount percentage).
 * Matching is by code point on NFC text (rule 6): no `\b`, no `\w`, no locale.
 */
import { nfc } from '../mn/text.ts';

export type FactService = { name: string; amounts: readonly number[] };
/** `prices: false`: read for spelling only. The platform's approved lines hold deliberately
 *  made-up example prices («Чёлк тайралт 33,000₮» in a refusal example), which are not a
 *  tenant's price and must never block one. */
export type FactCopy = { source: string; text: string; prices?: false };
export type FactFinding = { kind: 'spelling' | 'price'; source: string; line: string; detail: string };

/** The part before « — » names the service; the part after is its label. */
function split(name: string): { head: string; label: string | null } {
  const at = name.indexOf(' — ');
  return at < 0 ? { head: name.trim(), label: null } : { head: name.slice(0, at).trim(), label: name.slice(at + 3).trim() };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Case endings a short name may carry and still be the name. A short head matched as a mere
 * prefix is not evidence: «сорри» begins with «Сор», «үндэсний» with «Үндэс» (the same
 * specificity problem CLAUDE.md names for `services/match.ts`).
 */
const SHORT_HEAD_CHARS = 5;
const SUFFIXES = ['гийн', 'гаас', 'гээс', 'гоос', 'гөөс', 'ийн', 'ын', 'ийг', 'ыг', 'аас', 'ээс', 'оос', 'өөс',
  'тай', 'тэй', 'той', 'руу', 'рүү', 'д', 'т', 'г', 'н'];

/** «Дали», «Далигийн», «Дали-г». A head longer than five letters may carry any ending; a
 *  shorter one only a whole word or a case ending from the list. */
function headPattern(head: string): RegExp {
  const h = escape(head.toLowerCase());
  if ([...head].length > SHORT_HEAD_CHARS || /\s/u.test(head)) return new RegExp(`(?<![\\p{L}\\p{N}])${h}`, 'u');
  return new RegExp(`(?<![\\p{L}\\p{N}])${h}(?:-?(?:${SUFFIXES.join('|')}))?(?![\\p{L}\\p{N}])`, 'u');
}

/** Amounts in ₮ or «төгрөг», digits only (the separators are presentation). */
const AMOUNT = /(?<![\p{L}\p{N}])(\d{1,3}(?:[,.  ]\d{3})+|\d+)(?:\.\d+)?\s*(?:₮|төгрөг)/gu;

export function amountsIn(line: string): number[] {
  return [...line.matchAll(AMOUNT)].map((m) => Number((m[1] ?? '').replace(/[^0-9]/gu, '')));
}

/** A capital here is the grammar, not a spelling: the start of the line (after any bullet,
 *  emoji, number or quote) or of a sentence. */
function sentenceStart(text: string, at: number): boolean {
  const before = text.slice(0, at);
  return /^[^\p{L}]*$/u.test(before) || /[.!?:«"'“]\s*$/u.test(before);
}

function spelling(services: readonly FactService[], copy: FactCopy, line: string): FactFinding[] {
  const out: FactFinding[] = [];
  const lower = line.toLowerCase();
  for (const s of services) {
    const { label } = split(nfc(s.name));
    if (label === null || [...label].length < 4) continue;
    const want = label.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(want, from);
      if (at < 0) break;
      from = at + want.length;
      const before = at === 0 ? '' : (lower[at - 1] ?? '');
      const after = lower[at + want.length] ?? '';
      // A whole phrase, not a piece of a longer word.
      if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
      const got = line.slice(at, at + want.length);
      if (got === label) continue;
      const onlyFirst = got.slice(1) === label.slice(1);
      if (onlyFirst && sentenceStart(line, at)) continue;
      out.push({ kind: 'spelling', source: copy.source, line, detail: `«${got}» where the row «${s.name}» writes «${label}»` });
    }
  }
  return out;
}

/** 350000 → «350,000», by hand: `toLocaleString` would depend on the runtime's locale. */
function money(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

function prices(services: readonly FactService[], copy: FactCopy, line: string): FactFinding[] {
  const found = amountsIn(line);
  if (found.length === 0) return [];
  const lower = line.toLowerCase();
  const named = services.filter((s) => headPattern(split(nfc(s.name)).head).test(lower));
  if (named.length === 0) return [];
  const allowed = new Set(named.flatMap((s) => s.amounts));
  return found.filter((a) => !allowed.has(a)).map((a) => ({
    kind: 'price' as const, source: copy.source, line,
    detail: `${money(a)}₮ with ${named.map((s) => `«${s.name}»`).join(', ')}, whose rows carry `
      + `${[...allowed].sort((x, y) => x - y).map(money).join(', ') || 'no price'}`,
  }));
}

/** Every disagreement between the copies and the rows, in the copies' order. */
export function checkFactCopies(services: readonly FactService[], copies: readonly FactCopy[]): FactFinding[] {
  const out: FactFinding[] = [];
  for (const copy of copies) {
    for (const raw of nfc(copy.text).split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      out.push(...spelling(services, copy, line), ...(copy.prices === false ? [] : prices(services, copy, line)));
    }
  }
  return out;
}

/** One line per finding, for the build log and the publish output. */
export function renderFactFindings(slug: string, findings: readonly FactFinding[]): string {
  if (findings.length === 0) return `facts: ${slug}: every copy agrees with the rows.`;
  return [`facts: ${slug}: ${findings.length} cop${findings.length === 1 ? 'y disagrees' : 'ies disagree'} with the rows`,
    ...findings.map((f) => `  ${f.kind}  ${f.source}: ${f.detail}\n      ${f.line.slice(0, 200)}`)].join('\n');
}
