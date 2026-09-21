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
 * For every service the KB knows, if the reply contains the name's DISTINCTIVE HEAD — its
 * longest token — but does not contain the full name verbatim, the name was altered.
 * Following `embeddedAdaptation`'s discipline: exact questions, no similarity score.
 *
 * The head-token test is what keeps it from firing on a reply that simply does not mention
 * the service. «Дунд урттай үс» contains «үсний»? No — it contains «үс», a DIFFERENT token.
 * So the head is chosen as the longest token, which for «Дунд үсний будаг» is «будаг»: a
 * reply that says «будаг» and not «Дунд үсний будаг» is talking about it and renaming it.
 *
 * Rule 6: comparison is over NFC-folded text, code points, no `\b`, no `[a-z]`.
 */
import { fold } from '../mn/text.ts';

export type NameReport = {
  /** KB names whose head appears while the full name does not. */
  altered: string[];
  /** KB names reproduced verbatim. */
  exact: string[];
};

/** The longest token of a name — its most distinctive word. */
function head(name: string): string {
  const parts = fold(name).split(/[\s()/,.]+/u).filter((t: string) => t !== '');
  let best = '';
  for (const t of parts) if ([...t].length > [...best].length) best = t;
  return best;
}

/**
 * `names` is every service name the tenant's price list renders, WITHOUT the parenthetical
 * variant: the variant is a gloss and a reply may legitimately drop it. The head noun is
 * what must survive, because that is what a customer books by.
 */
export function serviceNameReport(text: string, names: readonly string[]): NameReport {
  const t = fold(text);
  const altered: string[] = [];
  const exact: string[] = [];
  for (const name of names) {
    const folded = fold(name);
    if (folded === '' ) continue;
    if (t.includes(folded)) { exact.push(name); continue; }
    const h = head(name);
    // A one-token name has no head distinct from itself; absent means simply unmentioned.
    if (h !== '' && h !== folded && [...h].length >= 4 && t.includes(h)) altered.push(name);
  }
  // Code-unit sort: deterministic, no locale (D-026).
  return { altered: altered.sort(), exact: exact.sort() };
}

/**
 * The service names a compiled prefix's price list renders, WITHOUT their parentheticals.
 *
 * Read from the prefix rather than fetched, because the prefix is already in hand on the
 * reply path and a second query would make a COUNTER cost a round trip. The price list is
 * `- {name} ({variant}): {price}` or `- {name}: {price}`, written by `renderTenantSections`.
 *
 * D-057's rule applies and is why this returns `[]` rather than guessing when the heading
 * is absent: a tenant with no price list has no names to check, which is a determinate
 * answer, not a truncated parse. What it must never do is return the lines it managed to
 * read from a section it could not delimit — so the section is bounded by the NEXT heading,
 * and a heading that never closes simply runs to the end of the prefix, which is correct
 * because the price list is the last thing in it or is followed by one.
 */
export function serviceNamesFromPrefix(promptStable: string, priceListLabel: string): string[] {
  const head = `=== ${priceListLabel} ===`;
  const at = promptStable.indexOf(head);
  if (at === -1) return [];
  const rest = promptStable.slice(at + head.length);
  const next = rest.indexOf('\n=== ');
  const body = next === -1 ? rest : rest.slice(0, next);
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('- ')) continue;
    // Strip the price, then the parenthetical gloss. Both are optional.
    const noPrice = t.slice(2).split(':')[0] ?? '';
    const noVariant = noPrice.replace(/\s*\([^()]*\)\s*$/u, '').trim();
    if (noVariant !== '') names.add(noVariant);
  }
  // Code-unit sort: deterministic, no locale (D-026).
  return [...names].sort();
}
