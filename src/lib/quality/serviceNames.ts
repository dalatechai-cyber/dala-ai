/**
 * Did the reply write a service's name the way the knowledge base writes it?
 *
 * ## Why this is a COUNTER, and why it exists at all
 *
 * Founder, 2026-09-21: *"Service names must be used exactly as written. It still rewrites
 * «Дунд үсний будаг» as «Дунд урттай (мөрнөөс дээш) үс». That's wrong every time."*
 *
 * Three instructions have now been aimed at this and none held: `sh11_completeness`'s
 * (11в) said to write the name «ЖАГСААЛТАД БИЧСЭН ЯГ ТЭР ХЭВЭЭР», a signed (11ж) said it
 * again with the structure spelled out, and the model went on answering «Дунд урттай үс
 * (мөрнөөс дээш): 176,000₮». D-065's rule is the one that applies: an instruction to the
 * model is a request until something checks it.
 *
 * This checks. It does not yet ENFORCE, and that is a decision for the founder rather than
 * an omission — refusing a reply over a name would discard an otherwise correct answer and
 * send the generic handoff, which is D-068's mistake in a new table. So it counts, and the
 * rate is what a decision about enforcing can be made from.
 *
 * ## What "altered" means, asked as an exact question
 *
 * A service was renamed when the reply QUOTES ONE OF THAT SERVICE'S PRICES and does not
 * contain its name verbatim. Both halves are exact string questions over folded text, in
 * `embeddedAdaptation`'s discipline: no similarity score, no heuristic for distinctiveness.
 *
 * ## The version this replaces fired on ordinary Mongolian nouns, and its own docstring
 * ## carried the counter-example
 *
 * It asked whether the reply contained the name's "distinctive head", defined as its
 * LONGEST TOKEN. The prose justified that with a worked example: the head of «Дунд үсний
 * будаг» is «будаг», so a reply saying «будаг» without the full name is renaming it.
 *
 * The code does not do that. Tokens «дунд»(4) «үсний»(5) «будаг»(5) tie at five, the loop
 * keeps the first strictly-longer one, and the head is «үсний» — *of hair*. Measured
 * 2026-09-21 by execution: `serviceNameReport('Танай үсний урт ямар вэ?', …)` reported
 * «Дунд үсний будаг» AND «Урт үсний будаг» as renamed. That is a clarifying question about
 * hair length, renaming nothing. «CMC тэжээл» reduced to «тэжээл», «Чёлк тайралт» to
 * «тайралт», «CICA нөхөн сэргээх эмчилгээ» to «эмчилгээ» — four of the tenant's commonest
 * words, each flagging any reply that used them.
 *
 * The cost was a number reported to the founder as evidence: 28 of 96 replies "rewrote a
 * service name", used to argue that three prompt instructions had failed and the job had
 * to be taken off the model. Re-measured with the price-anchored question, the genuine
 * rate is 8 of 96. The defect is real — «Дунд урттай үс (мөрнөөс дээш): 176,000₮» for
 * «Дунд үсний будаг» is exactly it — and it is four to five times rarer than the broken
 * counter claimed.
 *
 * Note the shape rather than the arithmetic: the prose and the code each read as correct
 * on their own, and only running the function on a sentence nobody would think to test —
 * an innocent one — separated them. The repository's own rule, from the preflight that
 * gated a build on a contract its caller did not implement: a rule and the code it
 * describes have to be read TOGETHER.
 *
 * ## Why a price, and why only a price the service does not share
 *
 * A price is the tenant's own datum and cannot be a common word. A reply that quotes
 * 176,000₮ is talking about the service that costs 176,000₮, whatever it called it. Prices
 * shared by two or more services are dropped from the test: quoting one of those says
 * which AMOUNT is meant and not which SERVICE, so it cannot support the claim.
 *
 * Rule 6: comparison is over NFC-folded text, code points, no `\b`, no `[a-z]`.
 */
import { fold } from '../mn/text.ts';

export type NameReport = {
  /** KB names a distinctive price of which the reply quoted, without the name itself. */
  altered: string[];
  /** KB names reproduced verbatim. */
  exact: string[];
};

/**
 * A service the price list names, with the prices rendered against it and the price list's
 * OWN rows for it.
 *
 * `rows` exist so that anything serving a price back to a customer can serve the data's
 * bytes rather than re-format `name` and `prices` into a second rendering — see
 * `guard/pricePresentation.ts`. A second renderer is a second thing to keep in agreement
 * with the compiler, and the `btrim()`/`.trim()` near-miss is what that costs.
 */
export type PricedService = { name: string; prices: readonly string[]; rows: readonly string[] };

/** The digit groups in a price fragment, folded to their digits so `176,000` and
 *  `176 000` compare equal. Never a substring test: `20` must not match `20,000`,
 *  which is the digits-only reduction the price guarantee already rests on. */
function priceTokens(fragment: string): string[] {
  const out: string[] = [];
  for (const m of fragment.matchAll(/\d[\d,\u00a0 ]*\d|\d/gu)) {
    const digits = m[0].replace(/[^\d]/gu, '');
    if (digits.length >= 4) out.push(digits);
  }
  return out;
}

/** Every digit-run in the text, reduced the same way, as a SET for exact membership. */
function textPriceSet(text: string): Set<string> {
  return new Set(priceTokens(text));
}

/**
 * `services` is what the tenant's price list renders: a name without its parenthetical
 * variant, and the prices shown against it. The variant is a gloss and a reply may
 * legitimately drop it; the name is what a customer books by.
 */
export function serviceNameReport(text: string, services: readonly PricedService[]): NameReport {
  const t = fold(text);
  const said = textPriceSet(text);
  // A price two services share cannot say which of them a reply meant.
  const owners = new Map<string, number>();
  for (const s of services) for (const p of new Set(s.prices)) owners.set(p, (owners.get(p) ?? 0) + 1);

  const altered: string[] = [];
  const exact: string[] = [];
  for (const s of services) {
    const folded = fold(s.name);
    if (folded === '') continue;
    if (t.includes(folded)) { exact.push(s.name); continue; }
    const distinctive = [...new Set(s.prices)].filter((p) => owners.get(p) === 1);
    if (distinctive.some((p) => said.has(p))) altered.push(s.name);
  }
  // Code-unit sort: deterministic, no locale (D-026).
  return { altered: altered.sort(), exact: exact.sort() };
}

/**
 * The services a compiled prefix's price list renders: name without its parenthetical
 * variant, plus every price shown against that name.
 *
 * Read from the prefix rather than fetched, because the prefix is already in hand on the
 * reply path and a second query would make a COUNTER cost a round trip. The price list is
 * `- {name} ({variant}): {price}` or `- {name}: {price}`, written by `renderTenantSections`.
 *
 * Variants are FOLDED TOGETHER under one name on purpose: «CICA нөхөн сэргээх эмчилгээ
 * (1 удаа)» and «… (Курсээр, 1 удаагийн үнэ)» are one service a customer books by one
 * name, and both of their prices are evidence that a reply is talking about it.
 *
 * D-057's rule applies and is why this returns `[]` rather than guessing when the heading
 * is absent: a tenant with no price list has no names to check, which is a determinate
 * answer, not a truncated parse. What it must never do is return the lines it managed to
 * read from a section it could not delimit — so the section is bounded by the NEXT heading,
 * and a heading that never closes simply runs to the end of the prefix, which is correct
 * because the price list is the last thing in it or is followed by one.
 */
/**
 * The `- …` rows of one compiled-prefix section, verbatim and in order, dash stripped.
 *
 * Shared by every reader that needs a section's own bytes back — the price list and the
 * deposit rules today. D-057's rule is why an absent heading returns `[]` rather than a
 * guess: a tenant without that section has no rows, which is a determinate answer, not a
 * truncated parse. The section is bounded by the NEXT heading so it can never run on into
 * the one below it.
 */
export function sectionRows(promptStable: string, label: string): string[] {
  const heading = `=== ${label} ===`;
  const at = promptStable.indexOf(heading);
  if (at === -1) return [];
  const rest = promptStable.slice(at + heading.length);
  const next = rest.indexOf('\n=== ');
  const body = next === -1 ? rest : rest.slice(0, next);
  return body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
}

/**
 * The FAQ ANSWERS a compiled prefix renders, in order.
 *
 * `renderTenantSections` writes each FAQ as two lines — `- {question}` then the answer,
 * indented — so `sectionRows` alone cannot read it: that returns only the dashed lines,
 * which are the QUESTIONS. Reading the questions and calling them answers is the shape of
 * mistake this repository keeps finding, so the parser is separate and named for what it
 * returns.
 *
 * A question with no answer line beneath it is skipped rather than paired with the next
 * question's text: an incomplete pair is not a determinate answer (D-057).
 */
export function faqAnswersFromPrefix(promptStable: string, faqLabel: string): string[] {
  const heading = `=== ${faqLabel} ===`;
  const at = promptStable.indexOf(heading);
  if (at === -1) return [];
  const rest = promptStable.slice(at + heading.length);
  const next = rest.indexOf('\n=== ');
  const lines = (next === -1 ? rest : rest.slice(0, next)).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!(lines[i] ?? '').trim().startsWith('- ')) continue;
    const answer = (lines[i + 1] ?? '').trim();
    // The next line must be an answer, not the next question and not the section's end.
    if (answer === '' || answer.startsWith('- ')) continue;
    out.push(answer);
  }
  return out;
}

export function servicesFromPrefix(promptStable: string, priceListLabel: string): PricedService[] {
  const order: string[] = [];
  const prices = new Map<string, Set<string>>();
  const rows = new Map<string, string[]>();
  for (const row of sectionRows(promptStable, priceListLabel)) {
    const colon = row.indexOf(':');
    if (colon === -1) continue;
    const name = row.slice(0, colon).replace(/\s*\([^()]*\)\s*$/u, '').trim();
    if (name === '') continue;
    if (!prices.has(name)) { order.push(name); prices.set(name, new Set()); rows.set(name, []); }
    for (const p of priceTokens(row.slice(colon + 1))) prices.get(name)?.add(p);
    rows.get(name)?.push(row);
  }
  // PRICE-LIST ORDER, not sorted: these rows are served to a customer, and the order the
  // tenant wrote them in is the order that reads correctly (cheapest first, variants
  // together). Deterministic because the prefix is (D-026) — no locale, no comparator.
  return order.map((name) => ({
    name,
    prices: [...(prices.get(name) ?? [])],
    rows: rows.get(name) ?? [],
  }));
}
