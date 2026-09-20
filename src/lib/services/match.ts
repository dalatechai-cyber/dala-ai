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
import { cpLength, fold } from '../mn/text.ts';
import { MIN_STEM_CHARS } from '../gate/match.ts';

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
  /**
   * Did the term clear the specificity floor? See `matchService`.
   *
   * Carried on the match rather than recomputed by callers, so the count that goes in a
   * log line and the decision that suppresses the match cannot disagree.
   */
  readonly specific: boolean;
  /**
   * Are this term's tokens a strict subset of some OTHER service's term?
   *
   * Separate from `specific` on purpose. Both send a match to `too_vague`, and they are
   * different facts: `specific` is about the term's own size, `shadowed` is about the
   * catalogue around it. D-074's lesson is that a defect filed under the wrong reason
   * sends the reader to the wrong screen — a log line saying «Будаг» was too short would
   * be false, and would point at `MIN_STEM_CHARS` for a problem no floor can fix.
   */
  readonly shadowed: boolean;
};

export type ServiceMatchResult =
  | { readonly verdict: 'none' }
  /**
   * Something matched, and not specifically enough to act on. Distinct from `none` so the
   * case is COUNTABLE — «сорри» reaching «Сор» is a measurement worth having, and a silent
   * downgrade to `none` is the console.info that hid three lost messages in D-070.
   */
  | { readonly verdict: 'too_vague'; readonly matches: readonly ServiceMatch[] }
  | { readonly verdict: 'unique'; readonly match: ServiceMatch }
  /**
   * The text named ONE service, and the catalogue holds longer names containing it. The
   * customer may mean any of them, so the answer is the whole FAMILY rather than a refusal.
   *
   * D-102, the founder's call, once the structural fact arrived: Matrix runs a hair salon
   * and a NAIL salon under one Page, and «будаг» is a real word in both. «Будаг» is hair
   * colouring (135,000–200,000₮); «Дип будаг» (65,000₮) and «Будаг арилгалт» (8,000₮) are
   * manicure services. The names are not sloppy and nothing should be renamed — the word
   * genuinely means two things, and which one the customer means is theirs to say.
   *
   * So this generalises D-100's option B one level up. Option B answered «будаг» with the
   * three LENGTHS of one service and let the customer self-select; this answers it with the
   * three SERVICES, and the category label is what makes «Будаг арилгалт — 8,000₮» legible
   * beside a hair price.
   *
   * `family` always contains the matched service itself, first. A caller that does not know
   * this verdict refuses, because every existing one tests `=== 'unique'` — serving the set
   * is opt-in, which is the direction a new verdict must fail in.
   */
  | {
      readonly verdict: 'family';
      readonly match: ServiceMatch;
      readonly family: readonly { readonly serviceId: string; readonly name: string }[];
    }
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

/**
 * Is this term specific enough that matching it is evidence?
 *
 * D-092 measured the failure this exists for: «сорри» — a customer apologising — reaches
 * «Сор» at one token, because «сор» prefixes it. The name is three code points and the
 * gate's own floor for a bare stem is four, so the matcher was accepting as a service
 * identification exactly what `MIN_STEM_CHARS` refuses to accept as a topic stem.
 *
 * The rule reuses that floor rather than inventing a second number, and states the
 * exemption the same way `stem_sequence` does: **two tokens or more, or one token of at
 * least `MIN_STEM_CHARS`.** Several tokens that must all occur are their own specificity,
 * which is what the length floor is a proxy for in the single-token case.
 *
 * The consequence for «Сор» is that it becomes unmatchable on its own, and that is the
 * honest outcome rather than a regression: D-092 established the collision cannot be
 * repaired by any row, because the salon's name for the three-dye service CONTAINS its
 * name for the one-dye service. Refusing to guess makes the rename it needs visible.
 * «Оффис колор /Сор/» still resolves at three tokens, and a one-token name like «Ботокс»
 * clears the floor on its own.
 */
export function termIsSpecific(term: ServiceTerm): boolean {
  if (term.tokens.length >= 2) return true;
  const only = term.tokens[0];
  return only !== undefined && cpLength(only) >= MIN_STEM_CHARS;
}

/**
 * Every term whose tokens are a strict subset of some other service's term.
 *
 * D-101 measured why this has to gate matching and not merely be reported. «Будаг» is a
 * hair service; «Дип будаг» and «Будаг арилгалт» are MANICURE services whose names contain
 * it. A customer writing «үсний будаг арилгах» — *remove my hair colour* — satisfies only
 * «Будаг», at one token, five code points, clearing `MIN_STEM_CHARS` comfortably. The old
 * answer was `unique`, and the three dye-APPLICATION prices would have been quoted to
 * somebody asking about REMOVAL.
 *
 * `subsetCollisions` has always computed this relation; it only ever printed it. The
 * docstring there says the pair is "UNVERIFIABLE in one direction" and that no row repairs
 * it — which is precisely the argument for refusing, rather than for reporting and then
 * answering anyway. **A collision the code can describe and does not act on is a comment.**
 *
 * Keyed by serviceId and term text together: two services may legitimately carry the same
 * term text, and shadowing is a property of the pair, not of the string.
 */
function shadowedTerms(entries: readonly ServiceEntry[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const a of entries) {
    for (const ta of a.terms) {
      if (ta.tokens.length === 0) continue;
      for (const b of entries) {
        if (b.serviceId === a.serviceId) continue;
        for (const tb of b.terms) {
          if (tb.tokens.length <= ta.tokens.length) continue;
          if (ta.tokens.every((tok) => tb.tokens.includes(tok))) {
            out.add(`${a.serviceId}\u0000${ta.text}`);
          }
        }
      }
    }
  }
  return out;
}

/** The best term of one entry that the text satisfies, or null. */
function bestTerm(folded: string, entry: ServiceEntry, shadowed: ReadonlySet<string>): ServiceMatch | null {
  let best: ServiceMatch | null = null;
  for (const term of entry.terms) {
    if (term.tokens.length === 0) continue;
    if (!term.tokens.every((tok) => containsStem(folded, tok))) continue;
    if (best === null || term.tokens.length > best.tokens) {
      best = {
        serviceId: entry.serviceId, name: entry.name, term: term.text,
        tokens: term.tokens.length, specific: termIsSpecific(term),
        shadowed: shadowed.has(`${entry.serviceId}\u0000${term.text}`),
      };
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
  const shadowed = shadowedTerms(entries);
  const hits: ServiceMatch[] = [];
  for (const entry of entries) {
    const m = bestTerm(folded, entry, shadowed);
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

  // The floor is applied to the WINNERS, after most-specific-wins has run — not to each
  // term as it is tested. An entry that matches vaguely and specifically at once should be
  // judged on its best reading, and `bestTerm` has already chosen that.
  if (!winners.every((w) => w.specific)) return { verdict: 'too_vague', matches: winners };

  // SEVERAL winners is `ambiguous`, and shadowing does not change that. Both verdicts
  // refuse, so the temptation is to fold them together — and the first version of D-101
  // did, which turned «гоёл» (reaching «Хумсны гоёл» AND «Гоёлын засалт») from a verdict
  // naming both services into a vaguer one. `ambiguous` is the more precise answer
  // whenever it is available, and a rule that makes an answer LESS specific in the name of
  // safety has confused the two.
  if (winners.length > 1) return { verdict: 'ambiguous', matches: winners };

  // One winner, and the catalogue holds a longer name containing it. D-101 refused here;
  // D-102 answers with the family instead, having learned WHY the collision exists — two
  // salons under one Page, and «будаг» is a real word in both. The refusal was right about
  // the danger (a confident single price) and wrong about the remedy: what the customer
  // cannot settle from the text, the REPLY can settle by listing the alternatives.
  const only = winners[0]!;
  if (only.shadowed) {
    return { verdict: 'family', match: only, family: familyOf(entries, only) };
  }

  return { verdict: 'unique', match: only };
}

/**
 * The matched service, then every service holding a term that strictly CONTAINS the matched
 * term — the set a customer who typed the short name might have meant.
 *
 * Ordered by serviceId after the match itself, for the reason `matchService` sorts winners:
 * a reply and a log line are downstream, and a set that reorders between runs is unreadable.
 * The matched service leads because it is the one the text actually named.
 */
function familyOf(
  entries: readonly ServiceEntry[], match: ServiceMatch,
): { serviceId: string; name: string }[] {
  const want = toTerm(match.term).tokens;
  const rest: { serviceId: string; name: string }[] = [];
  for (const e of entries) {
    if (e.serviceId === match.serviceId) continue;
    const contains = e.terms.some(
      (t) => t.tokens.length > want.length && want.every((tok) => t.tokens.includes(tok)),
    );
    if (contains) rest.push({ serviceId: e.serviceId, name: e.name });
  }
  // guard-ok:locale — serviceIds are ASCII uuids, compared as such.
  rest.sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0));
  return [{ serviceId: match.serviceId, name: match.name }, ...rest];
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
