/**
 * Does a reply quote a price that belongs to a DIFFERENT service from the one asked about?
 *
 * ## Why the obvious check is the wrong one
 *
 * `allowed_numbers` is a SET (D-075): the outbound guard asks whether a numeral is on this
 * tenant's list and never whether it belongs to the service being discussed. «Омбре
 * 33,000₮» — a 500,000–640,000 service at a haircut's price — passes every check the
 * platform has. D-112 put 42 confirmed prices in front of the model on the founder's
 * instruction, which is what makes that risk live rather than theoretical, and nothing
 * measured it. This does.
 *
 * ## Naming the other service is DISAMBIGUATION, not a defect
 *
 * The ancestor answers «Сор хэд вэ?» with Сор's range and then adds, in as many words, that
 * «Оффис колор» is a different service costing 380,000–460,000. That reply contains a price
 * belonging to another service and is BETTER for it — the two names collide (D-075) and the
 * contrast is the useful part. A check that failed on "another service's price appears"
 * would mark the best reply in the corpus as broken, and the first person to see that would
 * rightly delete the check.
 *
 * So the rule is narrower and is the one that matches the actual failure: **a price
 * belonging to another service, quoted WITHOUT naming that service.** Silent substitution
 * fails; explicit contrast passes.
 *
 * ## Comparison is on the digits-only reduction, and URLs are masked first
 *
 * Both for the reasons the guard already has. `digitsOf` means `135,000` and `135000` are
 * the same claim while `20` does not license `20,000`; `maskUrls` means a Maps slug that
 * happens to contain digits is not read as a price (D-074, where exactly that put a `9` on
 * Matrix's allow-list).
 */
import { digitsOf, extractNumerals, maskUrls } from '../../src/lib/mn/extract.ts';
import { containsStem } from '../../src/lib/mn/match.ts';
import { fold } from '../../src/lib/mn/text.ts';

export type OtherService = { name: string; prices: readonly string[] };

export type PriceBinding = {
  /** The service the customer asked about. */
  service: string;
  /**
   * Every price that legitimately answers THAT question. Not read by `checkPriceBinding` —
   * the guard's allow-list covers "is this numeral published at all". It is carried so the
   * report can print what the right answer WAS beside a failure, which is the difference
   * between a reader believing the finding and re-deriving it.
   */
  allowedPrices: readonly string[];
  /** Services whose prices must not be served as the answer. */
  otherServices: readonly OtherService[];
};

/**
 * One shape only, and deliberately.
 *
 * "A price for the right service that is not one of its real prices" was the obvious second
 * variant and is NOT here, because the outbound guard already refuses it: a numeral the
 * tenant never published is not in `allowed_numbers`, and that check runs on every reply.
 * The gap this module exists for is the one the guard structurally cannot see — a price
 * that IS on the allow-list because it belongs to this tenant, served for the wrong
 * service. Declaring a variant nothing produces would make this look like it covers both.
 */
export type BindingFailure = { code: 'foreign_price'; price: string; belongsTo: string };

/** Every distinct digits-only numeral in the reply, links masked out first. */
function quotedDigits(reply: string): Set<string> {
  return new Set(
    extractNumerals(maskUrls(reply))
      .map((n) => digitsOf(n.raw))
      // A bare `1` or `3` is an ordinal or a count, never a price, and including them
      // would collide with every price's leading digit under a prefix comparison.
      // Exact equality is used below, so the floor is only about noise in the report.
      .filter((d) => d.length >= 4),
  );
}

/**
 * Is this service NAMED in the reply? Every token of the name must occur, as a token
 * prefix — `containsStem`, the same matcher the gate uses, never a substring test.
 *
 * The substring version is what this function was first written as, and it was wrong in
 * the way rule 6 forbids: `fold(reply).includes(fold(name))` matches inside an unrelated
 * word. It was caught by a test that would not fail — the fake service «X» in the
 * maps-link case matched the `X` inside `ckEXBLoq4FnxJHq16`, silently exempted the
 * service, and made the assertion unfalsifiable. On real data the same flaw is live:
 * «Сор» is three characters, so «сорри» — a customer apologising — would have counted as
 * naming the service and waved a foreign price through. That is D-075's own example,
 * reproduced inside the check written to enforce D-075.
 *
 * Every token must occur, so «CMC тэжээл» is not named by «тэжээл» alone — which is the
 * subset collision this module is partly here to measure.
 */
function names(reply: string, service: string): boolean {
  // `fold(t)` is NOT redundant. `containsStem` folds the TEXT and matches the stem
  // verbatim, so a capitalised stem silently returns false — and every `services.name`
  // is a proper noun, so «Оффис», «CMC» and «Гелэн» all failed while their lowercase
  // second tokens matched. Measured, not assumed: three disambiguation tests went red
  // the moment the token matcher was introduced, and that asymmetry is what exposed it.
  const tokens = service.split(/\s+/u).filter((t) => t !== '');
  return tokens.length > 0 && tokens.every((t) => containsStem(reply, fold(t)));
}

export function checkPriceBinding(reply: string, spec: PriceBinding): BindingFailure[] {
  const quoted = quotedDigits(reply);
  const failures: BindingFailure[] = [];

  for (const other of spec.otherServices) {
    if (names(reply, other.name)) continue; // explicit contrast — see the module note
    for (const price of other.prices) {
      if (quoted.has(digitsOf(price))) {
        failures.push({ code: 'foreign_price', price, belongsTo: other.name });
      }
    }
  }

  return failures;
}
