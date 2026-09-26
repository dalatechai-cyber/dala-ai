/**
 * A tenant's reply LOOK, as data (`tenants.reply_style`, `0055`, D-133).
 *
 * Founder, 2026-09-26, for DalaTech (option A, approved): a price answer about a staff member
 * reads
 *
 *     💬 Дали — AI хүлээн авагч
 *     💰 Сарын төлбөр: 250,000₮
 *
 * and other replies "may use an emoji now and then, not often: at most one per reply, and
 * none on complaints or refusals. Prices and numbers still come only from our data."
 *
 * ## Only the presentation of rows that are already the tenant's data
 *
 * `stylePriceRows` touches a line only when it IS a price-list row, character for character
 * — the row the facts guard served, or the row a set answer quoted. It re-lays that row out
 * under the tenant's templates: the service name once, as a header, then each option. No
 * number is typed here; every digit comes from the row. A line that is not a row is left
 * exactly as it was, so a model sentence that mentions a price is still the facts guard's
 * business, not this file's.
 *
 * ## The emoji cap is on the MODEL's words
 *
 * Approved lines carry their own emoji and are never edited (the follow-up has three, the
 * thank-you one). `capEmoji` runs on the model's text only: past `max_emoji` the rest are
 * removed, and on a complaint or a refusal every one is. An emoji is decoration, so removing one changes
 * no meaning — unlike any other edit to a model reply.
 *
 * A tenant with no `reply_style` (Tara, every tenant before 0055) gets exactly what it got.
 */
import { nfc } from '../mn/text.ts';

export type ReplyStyle = {
  /** «💬 {service}» — the service name once, above its options. */
  priceHeader: string | null;
  /** «💰 {option}: {price}» — one line per option. */
  priceLine: string | null;
  /** At most this many emoji in the model's own words; null is no cap. */
  maxEmoji: number | null;
};

/** `tenants.reply_style` → a style, or null for none or a malformed one (then nothing changes). */
export function replyStyleOf(raw: unknown): ReplyStyle | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, slot: string): string | null =>
    typeof v === 'string' && v.includes(slot) ? nfc(v) : null;
  const header = text(r['price_header'], '{service}');
  const line = text(r['price_line'], '{price}');
  const max = typeof r['max_emoji'] === 'number' && Number.isInteger(r['max_emoji']) && r['max_emoji'] >= 0
    ? r['max_emoji'] : null;
  if (header === null && line === null && max === null) return null;
  // Both templates or neither: a header with no option line would lose the prices.
  const both = header !== null && line !== null;
  return { priceHeader: both ? header : null, priceLine: both ? line : null, maxEmoji: max };
}

type Row = { service: string; option: string | null; price: string };

/** A price-list row, split into its service, option and price. Null when it is not one. */
function parseRow(row: string, service: string): Row | null {
  if (!row.startsWith(service)) return null;
  const rest = row.slice(service.length);
  const m = /^\s*(?:\(([^()]+)\))?\s*:\s*(.+)$/u.exec(rest);
  if (m === null) return null;
  return { service, option: m[1] === undefined ? null : m[1].trim(), price: (m[2] ?? '').trim() };
}

/**
 * A line the model wrote to introduce the rows below it: one clause ending in a colon, with
 * no number in it. «Дали — AI хүлээн авагчийн үнэ дараах байдалтай байна:» is the measured
 * one (DalaTech's website, 2026-09-26 15:17): the facts guard kept it, the rows were styled,
 * and the reply named the service twice, once as that line and once as the 💬 header.
 *
 * Deliberately narrow. A line with a digit may carry a fact and is never removed; a line with
 * a sentence ending before its colon says more than "here are the prices" and stays.
 */
function isLeadIn(line: string): boolean {
  const t = nfc(line).trim();
  if (!/[:：]$/u.test(t)) return false;
  if (/\p{Nd}/u.test(t)) return false;
  return !/[.!?…](\s|$)/u.test(t.slice(0, -1));
}

/**
 * Re-lay the price-list rows in `body` under the tenant's templates. Only rows WITH an option
 * («Дали — … (Сарын төлбөр): 250,000₮») are styled — the staff-member prices the founder's
 * example shows. Consecutive rows of one service share one header.
 *
 * The header replaces the model's own lead-in (founder, 2026-09-26: *"Drop the intro line when
 * the styled header is there"*): a lead-in directly above a header, blank lines between
 * included, is removed. Only when a header is actually added; an unstyled reply keeps it.
 */
export function stylePriceRows(
  body: string,
  services: readonly { name: string; rows: readonly string[] }[],
  style: ReplyStyle | null,
): string {
  if (style === null || style.priceHeader === null || style.priceLine === null) return body;
  const rowOf = new Map<string, Row>();
  for (const s of services) {
    for (const r of s.rows) {
      const parsed = parseRow(nfc(r).trim(), s.name);
      if (parsed !== null && parsed.option !== null) rowOf.set(nfc(r).trim(), parsed);
    }
  }
  if (rowOf.size === 0) return body;
  const out: string[] = [];
  let last: string | null = null;
  let changed = false;
  for (const line of body.split('\n')) {
    const row = rowOf.get(nfc(line).trim().replace(/^[-•]\s*/u, ''));
    if (row === undefined) {
      out.push(line);
      last = null;
      continue;
    }
    changed = true;
    if (row.service !== last) {
      let i = out.length - 1;
      while (i >= 0 && (out[i] ?? '').trim() === '') i -= 1;
      if (i >= 0 && isLeadIn(out[i] ?? '')) out.splice(i);
      out.push(style.priceHeader.replace('{service}', row.service));
    }
    out.push(style.priceLine.replace('{option}', row.option ?? '').replace('{price}', row.price));
    last = row.service;
  }
  return changed ? out.join('\n') : body;
}

/** One emoji, with the modifiers and joiners that belong to it. */
const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;

export function countEmoji(text: string): number {
  return [...text.matchAll(EMOJI)].length;
}

/**
 * Keep at most `max` emoji in the model's words; with `none` (a complaint or a refusal), none. Double spaces left
 * behind are closed up. Text with fewer emoji than the cap is returned unchanged.
 */
export function capEmoji(text: string, max: number | null, none: boolean): string {
  if (max === null) return text;
  const keep = none ? 0 : max;
  if (countEmoji(text) <= keep) return text;
  let seen = 0;
  const out = text.replace(EMOJI, (m) => {
    seen += 1;
    return seen <= keep ? m : '';
  });
  return out.replace(/[ \t]{2,}/gu, ' ').replace(/[ \t]+\n/gu, '\n').replace(/[ \t]+([.,!?])/gu, '$1').trim();
}
