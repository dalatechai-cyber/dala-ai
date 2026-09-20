/**
 * What must be true before a tenant answers a customer, and what must go back to the client.
 *
 * ## Every check here is a way Matrix's onboarding actually went wrong
 *
 * None of this is invented. Each check is an existing exported function with its own tests,
 * wired to the question it answers, and each maps to a measured failure:
 *
 * | Check | What it would have caught |
 * |---|---|
 * | `subsetCollisions` | «Сор» vs «Оффис колор /Сор/», 3.2× apart, one name a subword of the other (D-075) |
 * | `allowedNumbersFrom` over the REAL render | `9` and `20` entering the allow-list from a promotion date nobody meant (D-055, D-074) |
 * | `kindsRequiredByRules` | a rule pointing at a sentence that does not exist — a 503 at the first customer |
 * | script check | «huuhdiin» firing no gate, so the children's rule the founder approved never ran (D-067) |
 * | `confirmedBy` | a price nobody at the client ever said (D-020) |
 *
 * ## Three severities, because they go to three different people
 *
 * `blocker` is ours and stops the stage. `ask_client` cannot be resolved here at any cost —
 * a service-name collision is settled by the salon renaming something, not by code.
 * `advisory` is shown and never blocks: the projected allow-list is the clearest example,
 * because the failure it prevents is nobody LOOKING at it.
 */
import { allowedNumbersFrom } from '../prompt/render.ts';
import { renderTenantSections, type ServiceVariant, type TenantKb } from '../prompt/tenant.ts';
import { entriesFrom, subsetCollisions, termIsSpecific, toTerm } from '../services/match.ts';
import { containsStem } from '../mn/match.ts';
import { scriptMatcher } from '../mn/text.ts';
import { parseMatcher } from '../gate/match.ts';
import type { IntakeDocument } from './intake.ts';

export type Severity = 'blocker' | 'ask_client' | 'advisory';
export type Finding = {
  severity: Severity;
  code: string;
  detail: string;
  /**
   * This finding keeps the tenant out of `ready` even though it is not a blocker.
   *
   * The criterion is consequence, not severity: set it when a WRONG ANSWER could reach a
   * customer while the question is open. A service-name collision is the case it was added
   * for — the matcher returns `ambiguous`, and the whole point of D-075 is that a real price
   * against the wrong service is more plausible, and therefore worse, than an invented one.
   * A missing Latin stem is not: a rule that fails to fire leaves the model answering
   * unrefused, which the outbound guard still bounds.
   */
  holdsReady?: boolean;
};

/** The intake document as the compiler will see it, so the projection is not a second renderer. */
export function toTenantKb(doc: IntakeDocument): TenantKb {
  return {
    currencySymbol: doc.business.currencySymbol,
    currencySymbolBefore: doc.business.currencySymbolBefore,
    refusalTopics: doc.neverSay.map((n) => ({ key: n.key, question: n.question })),
    clarify: [],
    deposits: [],
    documents: [],
    canned: Object.entries(doc.sentences).map(([kind, body]) => ({ kind, body })),
    staff: doc.staff.map((s) => ({ name: s.name, shortName: s.shortName, groupName: null, tier: null })),
    services: doc.services.map((s) => ({
      name: s.name,
      variants: s.variants.map((v): ServiceVariant => ({
        variantKey: v.variantKey,
        priceKind: v.priceKind,
        priceMin: v.priceMin,
        priceMax: v.priceMax,
        refusalTopic: v.refusalTopic,
      })),
    })),
    faqs: doc.faqs,
    contacts: doc.contacts,
    bookingUrl: doc.booking.url,
    hours: doc.hours,
  };
}

/**
 * Every numeral the bot would be permitted to say, if this document were published.
 *
 * Computed by rendering with the REAL compiler and reading the REAL extractor, never by a
 * second implementation — D-058's whole lesson is that two renderers agreeing is luck.
 */
export function projectedAllowedNumbers(doc: IntakeDocument, now = new Date()): string[] {
  const sections = renderTenantSections(toTenantKb(doc), now.toISOString());
  return allowedNumbersFrom(sections.map((s) => s.body).join('\n'));
}

/** Does any stem in this list match text written in the tenant's own script? */
function hasNonPrimaryScriptForm(stems: readonly string[], primaryScript: string): boolean {
  const re = scriptMatcher(primaryScript);
  // A stem written in a script OTHER than the tenant's primary one is the Latin form we
  // are asking for. Reading it this way rather than hardcoding "Latin" keeps it true for
  // tenant #7, whose primary script may not be Cyrillic at all (rule 6).
  return stems.some((s) => s !== '' && !re.test(s));
}

export function validateIntake(doc: IntakeDocument, now = new Date()): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, code: string, detail: string, holdsReady = false) =>
    out.push(holdsReady ? { severity, code, detail, holdsReady } : { severity, code, detail });

  // --- Service names that collide -------------------------------------------------------
  //
  // This finding used to hold `ready` in every case, and said the client must rename one.
  // D-102 retired that advice: a subset collision is now ANSWERED — a customer naming only
  // the short term is shown every service containing it, each under the salon's own category
  // heading. Matrix is why. «Будаг» is hair colouring and «Дип будаг» is a manicure, because
  // Matrix runs two salons under one Page, so the name is not sloppy and nothing should be
  // renamed. A validator still blocking on it was asking the client to fix the catalogue to
  // suit a refusal the code had stopped making.
  //
  // The hold survives in the one case the family branch cannot reach. `matchService` applies
  // the specificity floor to the winners BEFORE it looks at shadowing, so a subset term below
  // it returns `too_vague` and nothing is served at all. That is «Сор» — 120,000–190,000
  // against «Оффис колор /Сор/» 380,000–460,000, prices 3.2× apart, a real customer wrote
  // «сортой» on 2026-09-14, and seven of Matrix's 164 corpus messages still reach it. Three
  // code points cannot be made to carry a decision, and no alias and no verdict changes that.
  const entries = entriesFrom(
    doc.services.map((s) => ({ id: s.name, name: s.name })),
    doc.services.flatMap((s) => s.aliases.map((a) => ({ serviceId: s.name, alias: a }))),
  );
  // Grouped by the NAME PAIR and judged on every term that produces it: one service may hold
  // both a long term and a short one, and reporting whichever `subsetCollisions` happened to
  // list first would decide the hold on the order of a nested loop.
  const vias = new Map<string, { c: { subset: string; superset: string }; terms: string[] }>();
  for (const c of subsetCollisions(entries)) {
    const key = `${c.subset}\u0000${c.superset}`;
    const at = vias.get(key) ?? { c, terms: [] };
    if (!at.terms.includes(c.via)) at.terms.push(c.via);
    vias.set(key, at);
  }
  for (const { c, terms } of vias.values()) {
    const vague = terms.filter((t) => !termIsSpecific(toTerm(t)));
    // The colliding thing is a TERM, which is the service's name only sometimes. «Тэжээлийн
    // тос» is not a subword of «CMC тэжээл»; its ALIAS «тэжээл» is, and a finding that named
    // the service would send the client to check a name that resolves perfectly well.
    const via = terms.length === 1 && terms[0] === c.subset ? '' : ` (via «${terms.join('», «')}»)`;
    if (vague.length === 0) {
      add('ask_client', 'service_name_collision',
        `«${c.subset}»${via} collides with «${c.superset}» — a customer typing only the shared `
        + 'words is answered with BOTH, each under its own category heading (D-102). Confirm '
        + 'that is the reply you want; renaming one is the alternative, and no longer the only repair.');
    } else {
      add('ask_client', 'service_name_collision',
        `«${c.subset}»${via} collides with «${c.superset}», and «${vague.join('», «')}» is too short `
        + 'to act on, so the matcher refuses it as too vague and NO price is served. No alias '
        + 'fixes this; the client renames one.',
        true);
    }
  }

  // --- A service no customer can ever reach ----------------------------------------------
  //
  // Separate from the collision above on purpose, because it is a different fact and the
  // repair is different (D-074: a defect filed under the wrong reason sends the reader to
  // the wrong screen). «Сор» is unreachable whether or not «Оффис колор /Сор/» exists — the
  // floor refuses a one-token term of three code points as evidence, since «сорри», a
  // customer apologising, reaches it too. Splitting the two names, which is what Matrix did,
  // removes the collision and leaves this untouched; without this finding the service would
  // simply have vanished from the sheet.
  //
  // It does NOT hold `ready`. Nothing wrong is served — the turn falls through to the model
  // exactly as it does today — so it is a question that cannot produce a wrong answer, which
  // is the same footing as `no_latin_stems`.
  for (const s of doc.services) {
    const all = [s.name, ...s.aliases].filter((t) => t.trim() !== '');
    if (all.length > 0 && all.every((t) => !termIsSpecific(toTerm(t)))) {
      add('ask_client', 'service_name_unmatchable',
        `«${s.name}» has no term long enough to match on — every one of «${all.join('», «')}» is `
        + 'a single short token, so the matcher answers `too_vague` and this service can never '
        + 'be priced. A longer alias the customers actually type is the cheapest repair.');
    }
  }

  // --- Duplicate names, which would make the matcher ambiguous for a different reason -----
  const byName = new Map<string, number>();
  for (const s of doc.services) byName.set(s.name, (byName.get(s.name) ?? 0) + 1);
  for (const [name, n] of byName) if (n > 1) add('blocker', 'duplicate_service', `«${name}» appears ${n} times`);

  // --- Every sentence a rule reaches for must exist --------------------------------------
  const haveKinds = new Set(Object.keys(doc.sentences).filter((k) => doc.sentences[k]?.trim() !== ''));
  for (const rule of doc.neverSay) {
    if (rule.responseKind !== '' && !haveKinds.has(rule.responseKind)) {
      add('blocker', 'missing_sentence',
        `rule «${rule.key}» answers with "${rule.responseKind}" and no such sentence is in the document`);
    }
  }
  for (const s of doc.services) {
    for (const v of s.variants) {
      if (v.priceKind === 'none' && v.refusalTopic !== null && !doc.neverSay.some((n) => n.key === v.refusalTopic)) {
        add('blocker', 'missing_refusal_topic',
          `«${s.name}» is priced 'none' and bound to «${v.refusalTopic}», which is not in neverSay`);
      }
    }
  }

  // --- A topic rule that cannot fire for half the customers -------------------------------
  const primary = doc.business.locale.startsWith('mn') ? 'Cyrillic' : 'Latin';
  for (const rule of doc.neverSay) {
    if (rule.stems.length === 0) {
      add('blocker', 'rule_without_stems', `rule «${rule.key}» has no stems, so it can never fire`);
    } else if (!hasNonPrimaryScriptForm(rule.stems, primary)) {
      add('ask_client', 'no_latin_stems',
        `rule «${rule.key}» has only ${primary} stems. A customer typing the same words in another script `
        + 'fires no gate at all (D-067) — four of the mirror corpus’s first eleven turns were Latin. '
        + 'Ask which spellings their customers use, and store the shortest distinctive stem.');
    }
  }
  // --- Comment rules: the surface where a mistake is public and permanent ---------------
  //
  // Validated with `parseMatcher`, the SAME function that runs the rule at request time.
  // A provisioning-only validator would be a second reader of one jsonb, free to disagree
  // with the first — and the direction it would disagree in is "accepted here, refuses the
  // whole job there", which is a tenant switched on and silently unable to answer.
  const VERDICTS = new Set(['escalate', 'reply', 'ignore']);
  const ruleKeys = new Set<string>();
  for (const rule of doc.commentRules) {
    if (rule.key === '') add('blocker', 'comment_rule_unnamed', 'a comment rule has no key');
    if (ruleKeys.has(rule.key)) {
      add('blocker', 'comment_rule_duplicate', `two comment rules share the key «${rule.key}»`);
    }
    ruleKeys.add(rule.key);

    if (!VERDICTS.has(rule.verdict)) {
      add('blocker', 'comment_rule_verdict',
        `comment rule «${rule.key}» has verdict "${rule.verdict}"; it must be escalate, reply or ignore. `
        + '`unclassified` is the ABSENCE of a matching rule and cannot be written in a row — a rule able to '
        + 'assert it would edit the operator\u2019s own to-do list.');
    }

    const parsed = parseMatcher(rule.matcher);
    if (!parsed.ok) {
      add('blocker', 'comment_rule_matcher', `comment rule «${rule.key}»: ${parsed.detail}`);
      continue;
    }
    // Stems only; `has_attachment` kinds are Meta's identifiers and never customer text.
    const stems = parsed.spec.mode === 'contains_stem' ? parsed.spec.stems
      : parsed.spec.mode === 'stem_sequence' ? parsed.spec.stems
      : parsed.spec.mode === 'whole_message' ? parsed.spec.phrases
      : [];
    if (stems.length > 0 && !hasNonPrimaryScriptForm([...stems], primary)) {
      add('ask_client', 'comment_rule_no_latin',
        `comment rule «${rule.key}» has only ${primary} stems. 52% of the measured corpus carries no `
        + 'Cyrillic at all (D-067/D-085), and on the comment surface a missed rule is a lost sale in public. '
        + 'Ask which spellings their customers use.');
    }
  }

  // A rule set with no ESCALATE rule is the one shape that cannot be read from the counters
  // later: every complaint would be answered "come to DM" or ignored, and both look like the
  // classifier working. Four of the 71 measured messages were complaints (D-085).
  if (doc.commentRules.length > 0 && !doc.commentRules.some((r) => r.verdict === 'escalate')) {
    add('ask_client', 'comment_rules_no_escalate',
      'no comment rule escalates. A public complaint — «Утсаа авахгүй байна» — would be answered with '
      + 'the "message us privately" line under the business\u2019s own post, or silently ignored. Ask what '
      + 'their customers complain about in public and store those words.');
  }

  // Rules without the sentence they ultimately serve are rules that can never produce one.
  if (doc.commentRules.some((r) => r.verdict === 'reply')
      && (doc.sentences['comment_public_reply'] ?? '').trim() === '') {
    add('blocker', 'comment_rules_without_line',
      'comment rules would reply, and there is no `comment_public_reply` sentence for them to send');
  }

  for (const s of doc.services) {
    if (s.aliases.length > 0 && !hasNonPrimaryScriptForm(s.aliases, primary)) {
      add('advisory', 'service_without_latin_alias',
        `«${s.name}» has no alias outside ${primary} — a customer typing it in another script will not match it`);
    }
  }

  // --- The facts are the client's to confirm ----------------------------------------------
  if (doc.confirmedBy === null) {
    add('blocker', 'facts_unconfirmed',
      'confirmedBy is null. Prices, hours and the address must be confirmed BY THE CLIENT — the price '
      + 'guarantee rests on the tenant having said the number, and we must not say it for them.');
  }

  // --- Shown, never blocking, because the failure is nobody looking -----------------------
  const numbers = projectedAllowedNumbers(doc, now);
  add('advisory', 'allowed_numbers',
    numbers.length === 0
      ? 'no numeral would be permitted — the bot can state no price, hour or phone number'
      : `${numbers.length} numerals would be permitted: ${numbers.join(', ')}`);

  const ranges = doc.services.flatMap((s) => s.variants).filter((v) => v.priceKind === 'range').length;
  const priced = doc.services.flatMap((s) => s.variants).filter((v) => v.priceKind !== 'none').length;
  if (ranges > 0) {
    add('advisory', 'price_ranges',
      `${ranges} of ${priced} priced entries are ranges — each one answers a price question with `
      + '«between X and Y», then a clarifying question, then the link (D-042)');
  }

  // Deterministic order: the same document must produce the same report on every run, or a
  // diff between two intake reviews is unreadable (D-026 — no locale comparison anywhere).
  const rank: Record<Severity, number> = { blocker: 0, ask_client: 1, advisory: 2 };
  // guard-ok:locale — comparing ASCII codes, not collating Mongolian.
  out.sort((a, b) => rank[a.severity] - rank[b.severity]
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
    || (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Readiness: absence is a recorded state, never a gap
// ---------------------------------------------------------------------------

/**
 * The stages Matrix went through by hand, named.
 *
 * Refusing to provision until every field is present would have meant provisioning nothing:
 * Matrix's chemistry answers were in flight for days. So a tenant sits at the last stage it
 * fully satisfies, and what is missing is NAMED rather than silently absent — which is the
 * rule this platform already lives by (`hasTenantData`, `not_provisioned`, `price_kind
 * = 'none'` with a bound refusal, `UNREADABLE` rather than zero).
 */
export type Stage = 'nothing' | 'routing' | 'sentences' | 'knowledge' | 'ready';

export type Readiness = {
  stage: Stage;
  /** What the NEXT stage is waiting on, in the words an operator would use with the client. */
  waitingOn: string[];
  /** Blockers and client questions from `validateIntake`, carried so one report says everything. */
  findings: Finding[];
};

/** Canned kinds without which the reply path cannot answer at all. */
export const ESSENTIAL_SENTENCES = ['handoff'] as const;

export function assessReadiness(doc: IntakeDocument, now = new Date()): Readiness {
  const findings = validateIntake(doc, now);
  const waiting: string[] = [];

  const hasRouting = doc.slug !== '' && doc.business.displayName !== '' && doc.business.timezone !== '';
  const have = (k: string) => (doc.sentences[k] ?? '').trim() !== '';
  const missingEssential = ESSENTIAL_SENTENCES.filter((k) => !have(k));
  const hasSentences = missingEssential.length === 0;
  const hasKnowledge = doc.services.length > 0 && doc.hours.length > 0 && doc.contacts.length > 0;
  const blockers = findings.filter((f) => f.severity === 'blocker');
  // Not every client question holds the tenant back, but some do — see `Finding.holdsReady`.
  // An open service-name collision is the founder's own stop condition: it must be settled
  // before a customer can hit «Сор», not after.
  const holding = findings.filter((f) => f.holdsReady === true);

  if (!hasRouting) waiting.push('business details: slug, display name, timezone');
  if (missingEssential.length > 0) waiting.push(`sentences: ${missingEssential.join(', ')}`);
  if (doc.services.length === 0) waiting.push('services and prices');
  if (doc.hours.length === 0) waiting.push('opening hours');
  if (doc.contacts.length === 0) waiting.push('contact details — a phone, and an address if there is one');
  for (const b of blockers) waiting.push(b.detail);
  for (const a of findings.filter((f) => f.severity === 'ask_client')) waiting.push(`client: ${a.detail}`);

  const stage: Stage = !hasRouting ? 'nothing'
    : !hasSentences ? 'routing'
    : !hasKnowledge ? 'sentences'
    : blockers.length > 0 || holding.length > 0 ? 'knowledge'
    : 'ready';

  return { stage, waitingOn: waiting, findings };
}

/**
 * One line per tenant not yet live, for the daily digest.
 *
 * A readiness state nobody reads is the same shape as the dropped attachments D-070 found:
 * correct behaviour and worst behaviour indistinguishable from outside. `ready` returns
 * null — a finished tenant is not news, and the digest's job is to stay quiet enough to read.
 */
export function readinessDigestLine(slug: string, r: Readiness): string | null {
  if (r.stage === 'ready') return null;
  const head = `${slug}: ${r.stage}`;
  if (r.waitingOn.length === 0) return `${head} — nothing named as missing, which is itself worth checking`;
  const shown = r.waitingOn.slice(0, 3).join('; ');
  const rest = r.waitingOn.length > 3 ? ` (+${r.waitingOn.length - 3} more)` : '';
  return `${head} — waiting on ${shown}${rest}`;
}
