/**
 * Reply cases for a new tenant's key facts, generated from its own answers (D-120).
 *
 * A case is a customer message and what the reply must contain. These are written for the
 * facts a customer asks first and a wrong answer costs most: each price, the hours, the
 * address, the booking link, the deposit, each thing the client said Дали must not say,
 * and a video link (which must get the reviewed media line, never the model).
 *
 * ## Which cases need the model, and why most do
 *
 * Only the media-link case is EXACT: it is answered by a reviewed row before any model
 * call, so the publish gate checks it for free (D-137). Every fact case is a MODEL case —
 * `must_include` of the tenant's own figures — because a price or an hour is phrased by the
 * model and then held to the data by `guard/facts.ts`. They are skipped by the free gate
 * and run by the one paid pre-publish check (`--with-model`, D-151).
 *
 * The strings required are the ones the platform RENDERS, not the ones the client typed:
 * «60,000₮» because `prompt/tenant.ts` groups digits with commas and puts the tenant's
 * symbol after them, whatever spacing the form used.
 *
 * Customer messages here are test inputs, not wording any customer is sent, so they are
 * not the founder's to sign (CLAUDE.md: test fixtures are not customer-visible Mongolian).
 */
import { nfc } from '../mn/text.ts';
import { mediaLinksIn } from '../handover/media.ts';
import type { IntakeDocument, IntakeVariant } from './intake.ts';

export type GeneratedCase = {
  /** Stable within the tenant: re-running the command updates the case, never duplicates it. */
  id: string;
  message: string;
  expectedBody: string | null;
  mustInclude: string[];
  mustNotInclude: string[];
  why: string;
};

/** The platform's own rendering: digits grouped in threes with commas, `₮` after. */
export function renderAmount(digits: string, symbol = '₮', before = false): string {
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return before ? `${symbol}${grouped}` : `${grouped}${symbol}`;
}

function figuresOf(v: IntakeVariant, d: IntakeDocument): string[] {
  const r = (x: string | null) => (x === null ? [] : [renderAmount(x, d.business.currencySymbol, d.business.currencySymbolBefore)]);
  if (v.priceKind === 'exact' || v.priceKind === 'from') return r(v.priceMin);
  if (v.priceKind === 'range') return [...r(v.priceMin), ...r(v.priceMax)];
  return [];
}

/** The longest comma-separated part of an address: the part a reply cannot omit. */
function addressCore(address: string): string {
  const parts = address.split(/[,\n]/u).map((p) => p.trim()).filter((p) => p !== '');
  return parts.reduce((a, b) => ([...b].length > [...a].length ? b : a), '');
}

const DAY_NAMES: Record<number, string> = { 1: 'Даваа', 2: 'Мягмар', 3: 'Лхагва', 4: 'Пүрэв', 5: 'Баасан', 6: 'Бямба', 0: 'Ням' };

/** A public video link, recognised by `handover/media.ts` exactly as the reply path does. */
export const MEDIA_PROBE = 'https://youtu.be/dQw4w9WgXcQ';

export function generateCases(
  d: IntakeDocument,
  deposits: readonly { ruleText: string }[],
): GeneratedCase[] {
  const out: GeneratedCase[] = [];
  const add = (c: GeneratedCase) => out.push({ ...c, message: nfc(c.message) });

  d.services.forEach((s, i) => {
    const figures = s.variants.flatMap((v) => figuresOf(v, d));
    if (figures.length === 0) return;
    add({
      id: `price_${i + 1}`,
      message: `${s.name} хэд вэ?`,
      expectedBody: null,
      mustInclude: [...new Set(figures)],
      mustNotInclude: [],
      why: `the price of «${s.name}» as the client stated it`,
    });
  });

  const open = d.hours.filter((h) => !h.closed && h.opens !== null && h.closes !== null);
  const first = open.find((h) => h.weekday === 1) ?? open[0];
  if (first !== undefined) {
    add({
      id: 'hours',
      message: `${DAY_NAMES[first.weekday]} гарагт хэдэн цагаас хэдэн цаг хүртэл ажилладаг вэ?`,
      expectedBody: null,
      mustInclude: [first.opens!, first.closes!],
      mustNotInclude: [],
      why: `${DAY_NAMES[first.weekday]}'s hours`,
    });
  }
  const address = d.contacts.find((c) => c.kind === 'address');
  if (address !== undefined) {
    add({
      id: 'address',
      message: 'Хаяг хаана байдаг вэ?',
      expectedBody: null,
      mustInclude: [addressCore(address.value)],
      mustNotInclude: [],
      why: 'the address, in the client\'s words',
    });
  }

  if (d.booking.url !== null) {
    add({
      id: 'booking',
      message: 'Цаг захиалмаар байна',
      expectedBody: null,
      mustInclude: [d.booking.url],
      mustNotInclude: [],
      why: 'the booking link',
    });
  }

  deposits.forEach((dep, i) => {
    const digits = [...dep.ruleText.matchAll(/\d{1,3}(?:[ ,.]\d{3})+(?!\d)|\d{4,}/gu)]
      .map((m) => renderAmount(m[0].replace(/[ ,.]/gu, ''), d.business.currencySymbol, d.business.currencySymbolBefore));
    if (digits.length === 0) return;
    add({
      id: `deposit_${i + 1}`,
      message: 'Урьдчилгаа төлбөр хэд вэ?',
      expectedBody: null,
      mustInclude: [digits[0]!],
      mustNotInclude: [],
      why: 'the deposit, as the client stated it',
    });
  });

  for (const rule of d.neverSay) {
    if (rule.key === 'price_on_request') continue;
    const line = d.sentences[rule.responseKind];
    if (line === undefined) continue;
    // The customer's question is the client's own phrase: the rule's one stem.
    add({
      id: `rule_${rule.key}`,
      message: rule.stems[0] === undefined ? '' : `${rule.stems[0]}?`,
      expectedBody: null,
      mustInclude: [],
      // The rule working means none of the tenant's prices is quoted in the answer.
      mustNotInclude: d.services.flatMap((s) => s.variants.flatMap((v) => figuresOf(v, d))).slice(0, 12),
      why: `the client said Дали must not discuss «${rule.stems[0] ?? rule.key}»`,
    });
  }

  if (d.sentences['handover_notice'] !== undefined && mediaLinksIn(MEDIA_PROBE).length > 0) {
    add({
      id: 'media_link',
      message: MEDIA_PROBE,
      // A tenant with the reel question asks it instead (D-176): the probe is a video link.
      expectedBody: d.sentences['reel_price_question'] ?? d.sentences['handover_notice'],
      mustInclude: [],
      mustNotInclude: [],
      why: d.sentences['reel_price_question'] !== undefined
        ? 'a video link gets the reviewed reel question and nothing else (D-176) — answered with no model'
        : 'a video link gets the reviewed media line and nothing else (D-152) — answered with no model',
    });
  }

  // A case must assert something (`reply_cases`' own CHECK) and ask something.
  return out.filter((c) => c.message.trim() !== ''
    && (c.expectedBody !== null || c.mustInclude.length > 0 || c.mustNotInclude.length > 0));
}
