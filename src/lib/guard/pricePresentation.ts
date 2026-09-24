/**
 * A price may only appear beside the exact service name that owns it.
 *
 * Founder, 2026-09-21, two decisions that are one mechanism:
 *
 *   *"A price range built from two different services' prices must not pass. «us budalt»
 *   invented 176,000–200,000₮."*
 *   *"Take service names and prices off the model. A price is always shown with its exact
 *   service name from the data."*
 *
 * ## What was actually wrong, measured
 *
 * The model answered «us budalt» with
 * «Бүтэн будалт (дунд, урт зэргээс шалтгаалан): 176,000₮–200,000₮». Both numbers are real:
 * 176,000 is «Дунд үсний будаг» and 200,000 is «Урт үсний будаг». The RANGE is invented —
 * no service costs "between 176,000 and 200,000", and «Бүтэн будалт» is not a service at
 * all. A customer reads one service with a spread; the salon has two services with two
 * prices.
 *
 * Nothing caught it. `allowed_numbers` is a SET and both tokens are on it, which is exactly
 * the hole D-075 named — *the guard checks that a numeral is on the tenant's list and never
 * that it belongs to the service being discussed* — and read off the live snapshot on
 * 2026-09-21 that list carries `120,000 … 640,000`, i.e. the prices themselves. D-075's
 * remedy ("prices never enter `allowed_numbers`") describes a state the platform is not in.
 *
 * ## The rule, asked as an exact question
 *
 * Per LINE of the reply:
 *
 *   1. Every price token that belongs to SOME service must sit on a line that also contains,
 *      verbatim, the name of a service that has that price. Otherwise the price is orphaned
 *      from the thing it prices, which is how «Омбре 33,000₮» reads as authoritative.
 *   2. A numeric RANGE `X–Y` must have both endpoints owned by ONE service. Two names on the
 *      line does not rescue it: «Дунд үсний будаг, Урт үсний будаг: 176,000₮–200,000₮»
 *      satisfies (1) and still asserts a spread neither service has.
 *
 * Numerals that are not any service's price — the phone, opening hours, percentages, the
 * booking deposits — are not considered at all. This is a check about PRICES, and a token
 * the price list never rendered is not one.
 *
 * ## What happens on a violation is the part that is not obvious
 *
 * It does NOT fall through to the generic handoff. Discarding a correct answer and sending
 * «Уучлаарай, би энэ асуултад хариулж чадахгүй» is D-068's mistake, and it is worse here
 * than elsewhere because a price question is the one a customer is most likely to be asking
 * when they are ready to book.
 *
 * Instead the platform serves the PRICE LIST'S OWN ROWS for the services whose prices were
 * quoted — `gate/pinned.ts`'s move, one table over: discard the model's text whole, serve
 * the data's bytes. `rows` are captured verbatim from the compiled prefix rather than
 * re-formatted here, so "the exact service name from the data" is true by construction and
 * not by a formatting rule that could drift from the renderer.
 *
 * The cost is stated rather than discovered, as D-077 requires: serving the rows discards
 * whatever else the reply said, including a clarifying question that may have been good.
 * That is the founder's trade, made knowingly — a real price against the wrong service is
 * more plausible, and therefore more dangerous, than an invented one.
 *
 * Rule 6: comparison is over NFC-folded text, code points, no `\b`, no `[a-z]`.
 */
import { fold } from '../mn/text.ts';
import type { PricedService } from '../quality/serviceNames.ts';

export type PriceViolation =
  /** A price sits on a line naming no service that has it. */
  | { kind: 'orphaned'; price: string; line: string }
  /** A range whose endpoints are not both prices of one service. */
  | { kind: 'cross_service_range'; low: string; high: string; line: string };

export type PresentationReport = {
  violations: PriceViolation[];
  /**
   * Services the reply UNAMBIGUOUSLY quoted, in price-list order — what to serve instead.
   *
   * A service qualifies two ways: its name is on the line (so the reply said which), or the
   * price is uniquely its (so the number said which). A price several services share
   * identifies an AMOUNT and not a SERVICE, and is deliberately left out — see the
   * `ambiguous` note below.
   */
  quoted: PricedService[];
  /**
   * True when a violation rests only on prices whose owner cannot be determined.
   *
   * Measured 2026-09-21 against the real model, which is the only reason this exists.
   * «CICA хими байгаа юу?» was answered well — CICA is not a chemical service, here are
   * both its prices — with the prices attached to a paraphrase of the name rather than the
   * name. Rule (1) fires correctly. But 198,000 is also «Хуримын засалт» and 154,000 is
   * also «Усан хими», «Хими арчилт» and «Хуримын засалт», so serving "the rows for the
   * services whose prices were quoted" served FIVE services the customer never asked
   * about — visibly worse than the model's answer.
   *
   * So when the owner is unknowable the platform does not guess: the violation is counted
   * and the reply is left alone. It is loosely named and TRUE, and a true answer with an
   * imprecise name beats a list of unrelated services. This is the boundary of what the
   * mechanism can enforce, and it is stated rather than hidden.
   *
   * ALL-OR-NOTHING, and the second real-model run is why. A reply can mix an ambiguous
   * price with an unambiguous one, and substituting "the part we can account for" then
   * serves the part the customer did NOT ask about. Measured: «CICA хими байгаа юу?» was
   * answered "CICA is not a chemical service, it costs 198,000₮ (154,000₮ by course); if
   * you want a chemical service, there is…". The CICA prices are shared, the two chemical
   * ones are unique, so the substitution kept ONLY the chemical services and deleted the
   * answer to the question. Worse than the defect, again, and in a new way.
   *
   * So this is true whenever ANY violating price has an ambiguous owner, not only when
   * every one does: the platform serves the whole priced answer from data, or it serves
   * none of it and leaves the model's.
   */
  ambiguous: boolean;
};

/** Digit-runs reduced to digits alone, so `176,000` and `176 000` are one token.
 *
 *  There is deliberately NO four-digit floor here. It would be unreachable: every key in
 *  `byPrice` comes from `priceTokens`, which already refuses anything shorter, so a
 *  one-digit token cannot find an owner and is dropped by the lookup either way. A floor
 *  that cannot fire reads as a safety check for exactly as long as nobody tests it
 *  (D-064), and a mutation removing it passed every test here before it was deleted. The
 *  floor lives in ONE place, `servicesFromPrefix`, where it is reachable and tested. */
const FIGURE = /\d[\d,   ]*\d|\d/gu;

function digitsOf(s: string): string {
  return s.replace(/[^\d]/gu, '');
}

/** Every price-shaped token in a fragment, in order of appearance, with its raw text. */
function figures(fragment: string): { raw: string; digits: string }[] {
  const out: { raw: string; digits: string }[] = [];
  for (const m of fragment.matchAll(FIGURE)) {
    out.push({ raw: m[0], digits: digitsOf(m[0]) });
  }
  return out;
}

/**
 * Ranges on a line: two figures separated only by a dash and optional currency/space.
 *
 * Deliberately NOT "any two figures near each other" — «Эрэгтэй 66,000₮, эмэгтэй 88,000₮»
 * is two prices on one line and is fine (style rule (4) governs that, not this). Only a
 * DASH asserts a spread.
 */
const RANGE = /(\d[\d,   ]*\d)\s*₮?\s*[-–—]\s*(\d[\d,   ]*\d)/gu;

export function pricePresentation(text: string, services: readonly PricedService[]): PresentationReport {
  const byPrice = new Map<string, PricedService[]>();
  for (const s of services) {
    for (const p of new Set(s.prices)) byPrice.set(p, [...(byPrice.get(p) ?? []), s]);
  }

  const violations: PriceViolation[] = [];
  const quotedNames = new Set<string>();
  let sawAmbiguous = false;

  for (const line of text.split('\n')) {
    const folded = fold(line);

    // (2) first: a cross-service range is a distinct, more specific fault than an orphan,
    // and reporting it as an orphan would send a reader to the wrong question.
    for (const m of line.matchAll(RANGE)) {
      const lo = digitsOf(m[1] ?? '');
      const hi = digitsOf(m[2] ?? '');
      const loOwners = byPrice.get(lo) ?? [];
      const hiOwners = byPrice.get(hi) ?? [];
      if (loOwners.length === 0 && hiOwners.length === 0) continue; // not prices at all
      const shared = loOwners.some((a) => hiOwners.some((b) => b.name === a.name));
      if (!shared) violations.push({ kind: 'cross_service_range', low: lo, high: hi, line: line.trim() });
    }

    // (1) every price on the line must have an owner NAMED on that same line.
    for (const f of figures(line)) {
      const owners = byPrice.get(f.digits);
      if (owners === undefined) continue; // not a service price — phone, hours, deposit
      const named = owners.filter((o) => folded.includes(fold(o.name)));
      if (named.length === 0) {
        violations.push({ kind: 'orphaned', price: f.digits, line: line.trim() });
        // Only a price with exactly ONE owner says which service was meant.
        if (owners.length === 1 && owners[0] !== undefined) quotedNames.add(owners[0].name);
        else sawAmbiguous = true;
      } else {
        for (const o of named) quotedNames.add(o.name);
      }
    }
  }

  // Price-list order, not reply order: the rows are served as the data writes them.
  const quoted = services.filter((s) => quotedNames.has(s.name));
  return { violations, quoted, ambiguous: sawAmbiguous };
}

/**
 * The price list's own rows for these services, verbatim.
 *
 * Not re-formatted from `name` and `prices`: a second renderer is a second thing to keep in
 * agreement with the compiler, and this repository has already paid for that once — the
 * `btrim()`/`.trim()` near-miss that would have 503'd every reply with `canned_stale`.
 */
export function renderQuotedRows(quoted: readonly PricedService[]): string {
  return quoted.flatMap((s) => s.rows).join('\n');
}
