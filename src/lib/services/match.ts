/**
 * Which service is the customer talking about?
 *
 * ## Why this exists, and what it is deliberately not allowed to do
 *
 * D-074 measured the gap that motivates it: the outbound guard checks that a numeral is
 * ON the tenant's list, never that it BELONGS to the service under discussion. Every
 * check in `guard/outbound.ts` is a property of the reply text — a URL, a numeral, a
 * percentage, a script share — and none is relational. So «Омбре 33,000₮» passes: a real
 * price, a real service, and the wrong pairing, which is more plausible to a customer
 * than an invented number and therefore worse.
 *
 * The answer chosen (D-075) is not to teach the guard the pairing. It is to keep prices
 * out of the model's reach entirely — out of `allowed_numbers` AND out of the prefix —
 * and let the platform serve a price line from the row, the way `gate/pinned.ts` already
 * discards the model's text and serves a reviewed row's own bytes. `0001` says the same
 * thing about `price_kind = 'none'`, above `service_variants`, and has since the schema
 * was written: *a price that is not in the prompt cannot be quoted, which is stronger
 * than any rule forbidding it.*
 *
 * This module is the first half of that: deciding WHICH service, from the customer's own
 * words. It holds no prices, renders nothing, and cannot put a numeral anywhere. What it
 * returns is a service id and a verdict.
 *
 * ## The matching rule: every token, most specific wins
 *
 * A term matches only when **every** token in it occurs in the customer's text. That is
 * the choice the whole design turns on, so it is worth stating what the alternative costs:
 * matching on ANY token makes «Сор» and «Оффис колор /Сор/» permanently indistinguishable,
 * because the first name's only token is a subset of the second's. Requiring all tokens
 * separates them — «сортой будаг» reaches only «Сор», because «оффис» is absent — and it
 * separates the three CICA names for the same reason.
 *
 * When several services match, the one that required the MOST tokens wins. «оффис колор
 * сор» satisfies both names; the three-token one is the more specific reading and is what
 * a person would understand. That is `0018`'s most-specific-wins selection applied to
 * names instead of prompt blocks, not a new idea.
 *
 * Tokens are matched with `containsStem`, so agglutination is covered without a
 * morphological analyser: «сортой» is «сор» plus the comitative, and a token-prefix hit
 * finds it. The same property is why Latin spellings need no transliteration engine —
 * an alias row holding `sor` matches `sortoi` by prefix (D-067).
 *
 * ## Ambiguity is a result, not a tie to break
 *
 * Two services matching at the same token count returns `ambiguous` with both, and the
 * caller must ask rather than pick. This is the one place where being decisive is the
 * failure: a confident wrong service is exactly the plausible-and-wrong answer the whole
 * mechanism exists to prevent, and the salon's own list contains names that collide.
 *
 * Over-matching is inherited and accepted, as in `mn/match.ts`: the stem `сор` also fires
 * on «сорил» (a test). A stem list is reviewable; a heuristic buried in code is not.
 */
import { containsStem } from '../mn/match.ts';
import { fold } from '../mn/text.ts';

/** One name for a service — its own, or an alias row. */
export type ServiceTerm = {
  /** As stored, for the record and for the log line. */
  readonly text: string;
  /** Folded tokens, all of which must occur. Empty means the term can never match. */
  readonly tokens: readonly string[];
};

export type ServiceEntry = {
  readonly serviceId: string;
  readonly name: string;
  /** The service's own name first, then every alias. */
  readonly terms: readonly ServiceTerm[];
};

export type ServiceMatch = {
  readonly serviceId: string;
  readonly name: string;
  /** The term that matched, and how many tokens it needed — the specificity. */
  readonly term: string;
  readonly tokens: number;
};

export type ServiceMatchResult =
  | { readonly verdict: 'none' }
  | { readonly verdict: 'unique'; readonly match: ServiceMatch }
  | { readonly verdict: 'ambiguous'; readonly matches: readonly ServiceMatch[] };

/**
 * Split a name into the tokens every match must find.
 *
 * ascii-safe: the class is `\p{L}\p{N}`, so «Оффис колор /Сор/» and «Хими эмэгтэй / CICA»
 * lose their punctuation and keep their words in either script. Rule 6 forbids `\w` here
 * for the reason D-066 names — it is defined against ASCII and would behave differently
 * in the one language this platform is written for.
 */
export function termTokens(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
}

/** Build a term from a stored string. */
export function toTerm(text: string): ServiceTerm {
  return { text, tokens: termTokens(text) };
}

/**
 * Assemble the entries a matcher runs against: the service's own name, then its aliases.
 *
 * The name is included as a term on purpose. An alias table that must repeat the name
 * before the name can be matched is a table whose first row is always boilerplate, and
 * client #3 filling in a config should not have to write it.
 */
export function entriesFrom(
  services: readonly { id: string; name: string }[],
  aliases: readonly { serviceId: string; alias: string }[],
): ServiceEntry[] {
  const byService = new Map<string, ServiceTerm[]>();
  for (const svc of services) byService.set(svc.id, [toTerm(svc.name)]);
  for (const a of aliases) byService.get(a.serviceId)?.push(toTerm(a.alias));
  return services.map((svc) => ({
    serviceId: svc.id,
    name: svc.name,
    terms: byService.get(svc.id) ?? [toTerm(svc.name)],
  }));
}

/** The best term of one entry that the text satisfies, or null. */
function bestTerm(folded: string, entry: ServiceEntry): ServiceMatch | null {
  let best: ServiceMatch | null = null;
  for (const term of entry.terms) {
    if (term.tokens.length === 0) continue;
    if (!term.tokens.every((tok) => containsStem(folded, tok))) continue;
    if (best === null || term.tokens.length > best.tokens) {
      best = { serviceId: entry.serviceId, name: entry.name, term: term.text, tokens: term.tokens.length };
    }
  }
  return best;
}

/**
 * Which service the text names.
 *
 * `none` is a safe answer and the common one: it means the deterministic path does not
 * fire and the turn falls through to whatever handles it today. A miss costs a worse
 * reply; a wrong unique costs a wrong price, so the asymmetry is deliberate.
 */
export function matchService(text: string, entries: readonly ServiceEntry[]): ServiceMatchResult {
  const folded = fold(text);
  const hits: ServiceMatch[] = [];
  for (const entry of entries) {
    const m = bestTerm(folded, entry);
    if (m !== null) hits.push(m);
  }
  if (hits.length === 0) return { verdict: 'none' };

  let top = 0;
  for (const h of hits) if (h.tokens > top) top = h.tokens;
  const winners = hits.filter((h) => h.tokens === top);
  // Deterministic order: the compiled prompt is not downstream of this, but a log line and
  // a `quality_flags` row are, and a set that reorders between runs is unreadable.
  // guard-ok:locale — byCodePoint is not needed; ids are ASCII uuids compared as such.
  winners.sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0));
  return winners.length === 1 ? { verdict: 'unique', match: winners[0]! } : { verdict: 'ambiguous', matches: winners };
}

/**
 * Names whose tokens are a subset of another name's, which is the collision no alias row
 * can repair.
 *
 * «Сор» is a strict subset of «Оффис колор /Сор/». That does not make them unmatchable —
 * the all-tokens rule separates them, because text naming only «сор» never reaches the
 * longer name. It makes them UNVERIFIABLE in one direction: a customer who means the
 * office colour and types only «сор» is indistinguishable from one who means «Сор», and
 * no data added to either row changes that. The repair is upstream, in what the salon
 * calls its services.
 *
 * Reported rather than resolved, because a rename is the tenant's decision.
 */
export function subsetCollisions(
  entries: readonly ServiceEntry[],
): { subset: string; superset: string; via: string }[] {
  const out: { subset: string; superset: string; via: string }[] = [];
  for (const a of entries) {
    for (const b of entries) {
      if (a.serviceId === b.serviceId) continue;
      for (const ta of a.terms) {
        if (ta.tokens.length === 0) continue;
        for (const tb of b.terms) {
          if (tb.tokens.length <= ta.tokens.length) continue;
          if (ta.tokens.every((tok) => tb.tokens.includes(tok))) {
            out.push({ subset: a.name, superset: b.name, via: ta.text });
          }
        }
      }
    }
  }
  return out;
}
