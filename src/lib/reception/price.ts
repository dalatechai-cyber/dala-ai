/**
 * Serving a price from the row, with the model never holding the number (D-075, part 2).
 *
 * `0001` wrote the principle above `service_variants` before any of this existed: *a price
 * that is not in the prompt cannot be quoted, which is stronger than any rule forbidding
 * it.* Part 1 took the figures out of the compiled prefix. This is what puts one back in
 * front of a customer — from the row, as bytes, the way `gate/pinned.ts` serves a reviewed
 * sentence and `inbound/imageReply.ts` serves the image line.
 *
 * ## The asymmetry this whole module is built around
 *
 * A MISS costs a refusal, which is today's behaviour and therefore no regression. A wrong
 * SERVE costs a real price attached to the wrong service, which a customer cannot detect
 * and may act on. So every rule below resolves towards not serving, and `matchService`'s
 * `ambiguous` and `too_vague` verdicts are treated as refusals rather than as ties to break.
 *
 * ## What the four retired render tests became
 *
 * Part 1 deleted the figures from `price_list`, and four tests in `prompt/tenant.test.ts`
 * that asserted their shape looked obsolete. Three of their concerns were not obsolete at
 * all — they RELOCATED here, because this is now the only place a price becomes text:
 *
 *   - **Range fusion.** `extractNumerals` joins digit runs across `-` and `–`, so
 *     «80,000–150,000» reduces to one 11-digit token. The currency symbol after BOTH
 *     numbers is what breaks the join. Kept, by reusing `formatMoney` on each endpoint.
 *   - **A price the compiler cannot read.** `formatMoney` returns null rather than `0` or
 *     `NaN` for a value that is not a number. Here that must REFUSE TO SERVE, not print a
 *     partial line — a malformed row is the one case where saying nothing is right.
 *   - **One renderer, not two.** The publish path and this path both go through
 *     `formatMoney`, for D-058's reason: a second copy of a format is a second thing to
 *     keep in step, and the two only ever disagree in production.
 *
 * ## It is inert until the founder signs one sentence
 *
 * The served body is a label line the platform composes — a service name, digits and
 * punctuation, no grammar — followed by ONE reviewed sentence from `canned_responses`.
 * With no such row this refuses and the turn falls through to the model exactly as it does
 * today. That is deliberate: the label carries no Mongolian, so the only thing waiting on a
 * human is the sentence a customer actually reads.
 */
import { formatMoney, type PriceKind } from '../prompt/tenant.ts';
import { matchService, type ServiceEntry, type ServiceMatchResult } from '../services/match.ts';

/** A variant as the reply path reads it. `confirmedAt` is the tenant's signature (D-020). */
export type PriceVariant = {
  readonly variantKey: string;
  readonly priceKind: PriceKind;
  readonly priceMin: string | null;
  readonly priceMax: string | null;
  readonly confirmedAt: Date | null;
};

export type PricedService = {
  readonly serviceId: string;
  readonly name: string;
  /**
   * The salon's own price-list heading, shown ONLY when a family is served (D-102).
   *
   * It is the tenant's word, never ours — `services.category` as they wrote it — so this
   * adds no Mongolian to the reply that the client has not already published. A single
   * service answers without it, because there is nothing to tell apart.
   */
  readonly category: string | null;
  readonly variants: readonly PriceVariant[];
};

export type PriceQuoteInput = {
  readonly text: string;
  /** True when the tenant's own price-intent matcher fired. Never inferred here. */
  readonly priceIntent: boolean;
  readonly entries: readonly ServiceEntry[];
  readonly services: readonly PricedService[];
  /** The reviewed tail sentence, or null when the tenant has none. */
  readonly tail: string | null;
  readonly currencySymbol: string;
  readonly currencySymbolBefore: boolean;
};

export type PriceQuoteReason =
  /** The tenant's matcher did not call this a price question. */
  | 'no_price_intent'
  /** `matchService` returned none, ambiguous or too_vague. Never a tie to break. */
  | 'service_not_unique'
  /** The service matched but carries no variants at all. */
  | 'no_variant'
  /** `price_kind` is `none` or `on_inspection` — a real answer, and not ours to serve. */
  | 'not_numeric'
  /** The tenant has not signed the figure. D-020: we must not say it for them. */
  | 'unconfirmed_price'
  /** `formatMoney` could not read the value. A malformed row says nothing. */
  | 'price_unreadable'
  /** No reviewed tail sentence. The mechanism is inert until one exists. */
  | 'no_reviewed_tail';

export type PriceQuote =
  | { readonly serve: true; readonly body: string; readonly serviceId: string; readonly serviceName: string }
  | { readonly serve: false; readonly reason: PriceQuoteReason; readonly verdict?: ServiceMatchResult['verdict'] };

/**
 * One variant as a price phrase, or null when it cannot be rendered honestly.
 *
 * The symbol goes on BOTH endpoints of a range and the dash keeps its spaces. Either alone
 * leaves a join `extractNumerals` reads as a single eleven-digit number — the trap the
 * retired render test was written for, moved to the only place that still renders a price.
 */
export function priceText(
  v: PriceVariant,
  symbol: string,
  before: boolean,
): string | null {
  const min = formatMoney(v.priceMin, symbol, before);
  const max = formatMoney(v.priceMax, symbol, before);
  if (v.priceKind === 'exact') return min;
  if (v.priceKind === 'range') return min === null || max === null ? null : `${min} - ${max}`;
  if (v.priceKind === 'from') return min;
  // `none` and `on_inspection` carry no number by construction and are handled by the
  // caller as `not_numeric`; reaching here with one is a malformed row.
  return null;
}

/**
 * Should this turn be answered with a price, and if so what exactly is sent?
 *
 * Pure. It reads no database and calls no model, so the decision is testable on its own and
 * the reasons are countable — `service_not_unique` in particular is the number that says
 * whether the salon's service NAMES need work, which is a question no code can settle.
 */
export function decidePriceQuote(input: PriceQuoteInput): PriceQuote {
  if (!input.priceIntent) return { serve: false, reason: 'no_price_intent' };

  const match = matchService(input.text, input.entries);
  if (match.verdict !== 'unique' && match.verdict !== 'family') {
    return { serve: false, reason: 'service_not_unique', verdict: match.verdict };
  }

  // A `family` answers with every service the short name could mean (D-102). One service
  // shows no category; several do, because the heading is the only thing distinguishing
  // «Будаг арилгалт — 8,000₮» from the hair prices above it.
  const wanted = match.verdict === 'family' ? match.family.map((f) => f.serviceId) : [match.match.serviceId];
  const chosen: PricedService[] = [];
  for (const id of wanted) {
    const s = input.services.find((x) => x.serviceId === id);
    // A family member with no priced row is not a partial answer to give. Refusing the
    // whole set is the same rule as refusing a service's readable half, one level up:
    // a customer shown two of three «будаг» services learns a price and not the choice.
    if (s === undefined || s.variants.length === 0) return { serve: false, reason: 'no_variant' };
    chosen.push(s);
  }
  const showCategory = chosen.length > 1;

  const all = chosen.flatMap((s) => s.variants);
  // EVERY variant is priced or none is served. A service with a Мастер and a 1-р зэрэг row
  // answered with one of them is the wrong-price failure wearing a right answer's clothes,
  // and picking one is exactly the tie-breaking `matchService` refuses to do one layer up.
  if (all.some((v) => v.priceKind === 'none' || v.priceKind === 'on_inspection')) {
    return { serve: false, reason: 'not_numeric' };
  }
  if (all.some((v) => v.confirmedAt === null)) {
    return { serve: false, reason: 'unconfirmed_price' };
  }

  const svc = chosen[0]!;
  const lines: string[] = [];
  for (const s of chosen) {
    for (const v of s.variants) {
      const text = priceText(v, input.currencySymbol, input.currencySymbolBefore);
      // One unreadable row refuses the WHOLE quote. Serving the readable half of a service's
      // prices is how a customer learns the master's rate and not the junior's.
      if (text === null) return { serve: false, reason: 'price_unreadable' };
      const label = v.variantKey === '' ? s.name : `${s.name} (${v.variantKey})`;
      const suffix = showCategory && s.category !== null && s.category !== '' ? ` [${s.category}]` : '';
      lines.push(`${label} — ${text}${suffix}`);
    }
  }

  if (input.tail === null || input.tail.trim() === '') {
    return { serve: false, reason: 'no_reviewed_tail' };
  }

  return {
    serve: true,
    body: `${lines.join('\n')}\n${input.tail}`,
    serviceId: svc.serviceId,
    serviceName: svc.name,
  };
}
