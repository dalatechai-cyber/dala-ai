/**
 * Load everything one Reception reply needs, from rows.
 *
 * Separated from `handle.ts` so the decision logic has no database in it. Here the
 * opposite discipline applies: **every read that fails refuses.** There is no partial
 * context — a missing gate rule is a refusal that will not fire, a missing canned line is
 * a check with no answer, and either one changes what a customer is told.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_GATE, GATE_BY_RESPONSE_KIND, scriptForLocale } from '../../config/platform.ts';
import { loadLiveSnapshot } from '../prompt/publish.ts';
import type { CannedRow, GateRule } from '../gate/match.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';
import type { TenantGuardView } from '../guard/outbound.ts';
import { MAX_REPLY_CHARS } from './handle.ts';
import type { BusinessHours, Closure } from './volatile.ts';
import { canonicalizeUrl } from '../mn/extract.ts';
import type { Spelling } from '../mn/latin.ts';
import { appliedSpellings } from '../quality/spellings.ts';
import { branchNamesFromPrefix } from '../branches/branches.ts';
import { loadBranchContext, type BranchContext } from '../branches/load.ts';

export type TenantSettings = {
  defaultLocale: string;
  promptCacheMode: 'off' | '5m' | '1h';
};

export type ReceptionContext = {
  promptStable: string;
  /** Weekly hours, for L4's open/closed-now. */
  hours: BusinessHours[];
  /** Closures that could be active today, for L4's verbatim notice. */
  closures: Closure[];
  allowedNumbers: string[];
  /** D-058. null means this snapshot predates the canned section moving into the prefix. */
  cannedHash: string | null;
  /**
   * D-084. The gate blocks alone, which is what a disclosure is measured against. null
   * means the snapshot predates `0029` and the caller falls back to the whole prefix.
   */
  promptGate: string | null;
  revisionId: string;
  /**
   * The published snapshot's `content_hash` — the compiled prefix's identity, and the
   * prompt-cache key. Carried so a reply can be traced back to the exact text that
   * produced it: `revisionId` says which revision, this says which rendering of it.
   */
  contentHash: string;
  rules: GateRule[];
  deterministic: DeterministicRule[];
  /**
   * `service_aliases`, as the service NAME each points at. Read for one purpose: finding the
   * services a suitability question is about when the customer wrote «himi» or «budaad»
   * rather than a listed name (`handle.ts`, D-117). An alias of a service that is not on the
   * price list simply finds nothing there.
   */
  serviceAliases: { name: string; alias: string }[];
  /** `spellings` that are `settled` or `confirmed` (D-120): what the gate also matches against. */
  spellings: Spelling[];
  /**
   * The branches the live prefix lists, with their live stems, week and contact points
   * (D-125). `[]` unless the prefix lists two or more — every tenant today — and then the
   * branch tables are not read at all.
   */
  branches: BranchContext[];
  canned: CannedRow[];
  tenantGuard: TenantGuardView;
  cacheMode: 'off' | '5m' | '1h';
};

/**
 * Where this function's wall-clock went, in milliseconds.
 *
 * `context_load` is the largest single database phase on a real turn — 533ms of the
 * 1,667ms of database time measured on 2026-09-21 — and until now it was ONE number over
 * two stages that behave completely differently: a single row by key, then ten queries
 * issued together. Which of the two dominates decides whether there is anything to win
 * here, and the coarse number cannot say. Guessing produced the wrong answer once already
 * this week (the `generate` clause), so this is measured rather than reasoned about.
 */
export type LoadTimings = {
  /** `loadLiveSnapshot`: one row, by tenant and channel. */
  snapshot: number;
  /** The ten config reads, issued as one `Promise.all` — so this is the SLOWEST of them,
   *  plus whatever contention the client adds, never their sum. */
  batch: number;
};

export type LoadOutcome =
  | { ok: true; context: ReceptionContext; timings: LoadTimings }
  /** Any read that failed, or any state that cannot produce a safe reply. */
  | { ok: false; code: 'unavailable' | 'not_provisioned'; detail: string };

const CACHE_MODES = new Set(['off', '5m', '1h']);

function gateFor(responseKind: string): string {
  return GATE_BY_RESPONSE_KIND[responseKind] ?? DEFAULT_GATE;
}

/** Rows from one of the two refusal tables, normalised into `GateRule`. */
export function toRules(rows: unknown, quotePriceDefault: boolean): GateRule[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    const responseKind = String(r['response_kind'] ?? '');
    return {
      gate: gateFor(responseKind),
      topicKey: String(r['topic_key'] ?? ''),
      matcher: r['matcher'],
      // Both refusal tables carry `quote_price` since 0037; the fallback is for a
      // database that predates it, and the default passed by both callers is `false`,
      // which is the semantics the column's absence always had.
      //
      // 0037 is where the reasoning lives. In short: "we cannot know" was doing two
      // different jobs. A topic refused for want of a FACT (we cannot see the
      // photograph) must not carry a number. A topic refused for want of a JUDGEMENT
      // («Шулуун хими» is priced in the KB; only its suitability is unknowable) has no
      // such need, and blanket-refusing it threw away a correct, row-backed price on
      // 2026-09-21.
      quotePrice: 'quote_price' in r ? r['quote_price'] === true : quotePriceDefault,
      deterministicShortcircuit: r['deterministic_shortcircuit'] === true,
      // `0041`. Only `out_of_scope_topics` carries it; a disclosure row reads as false,
      // which is the behaviour before the column existed.
      groundedOnly: r['grounded_only'] === true,
      responseKind,
      // Raw, unread. `isTenantConfirmed` is the only thing that interprets it, so a row
      // whose column is absent — a database that predates 0011 — reads as unconfirmed
      // rather than being credited with a confirmation nobody gave.
      provenance: r['provenance'],
    };
  });
}

/**
 * `deterministic_replies` rows as the gate reads them. Exported so the bake-off harness
 * shapes a dumped row exactly as production does, rather than a second reading of it.
 */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function toDeterministic(rows: unknown): DeterministicRule[] {
  return (Array.isArray(rows) ? rows : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const stems = r['stems'];
    return {
      intent: String(r['intent']),
      body: String(r['body']),
      enabled: r['enabled'] === true,
      // An unrecognised mode falls to whole_message, the high-precision one. A typo must
      // not silently widen a matcher into the mode that steals questions.
      matchMode: r['match_mode'] === 'contains_stem' || r['match_mode'] === 'covers_message' || r['match_mode'] === 'on_topic'
        || r['match_mode'] === 'on_correction'
        ? r['match_mode']
        : 'whole_message',
      stems: strings(stems),
      coverWords: strings(r['cover_words']),
      // Absent or unknown reads as `replace`, which is what every row was before `0041`.
      placement: r['placement'] === 'append' ? 'append' : 'replace',
      quoteServices: strings(r['quote_services']),
      // Absent reads as TRUE: greeting a customer mid-conversation is the worse error.
      requiresEmptyHistory: r['requires_empty_history'] !== false,
      provenance: r['provenance'],
    };
  });
}

/**
 * Every link the tenant has declared in a contact point, from `contact_points` or a branch's
 * `branch_contact_points` — the values the URL guard allows alongside the booking link.
 *
 * All four URL-shaped kinds, not just `maps_url`: restricting it to the one kind needed
 * today rebuilds the same gap for `website` the first time anybody adds one. A kind that
 * holds a handle rather than a link is inert here rather than dangerous — it canonicalises
 * to something no extracted URL matches — but it is filtered out anyway so the allow-list
 * contains only things that are actually links.
 */
export const URL_CONTACT_KINDS: ReadonlySet<string> = new Set(['maps_url', 'website', 'facebook', 'instagram']);

export function linkValues(contacts: readonly { kind: string; value: string }[]): string[] {
  return contacts
    .filter((c) => URL_CONTACT_KINDS.has(c.kind) && c.value !== '' && canonicalizeUrl(c.value) !== null)
    .map((c) => c.value);
}

export async function loadReceptionContext(
  db: SupabaseClient,
  input: { tenantId: string; channel: string; settings: TenantSettings; localDate: string },
): Promise<LoadOutcome> {
  const tSnapshot = Date.now();
  const snapshot = await loadLiveSnapshot(db, { tenantId: input.tenantId, channel: input.channel });
  const snapshotMs = Date.now() - tSnapshot;
  if (!snapshot.ok) {
    // `no_live_revision` is a provisioning state, not a transient one: there are no
    // defaults to fall back to, and inventing one would be a bot answering with a prompt
    // nobody approved.
    return snapshot.code === 'unavailable'
      ? { ok: false, code: 'unavailable', detail: snapshot.detail }
      : { ok: false, code: 'not_provisioned', detail: snapshot.detail };
  }

  // NOTE for anyone about to merge this batch into the snapshot call above: none of the
  // ten queries below reads `snapshot`. Every one keys on `input.tenantId`, the locale or
  // the local date, all of which exist before the snapshot is issued — so the two stages
  // are sequential by LAYOUT, not by data dependency, and could be one `Promise.all` of
  // eleven. That is deliberately not done yet. It would make a not-provisioned tenant pay
  // ten pointless reads, and more importantly `timings` has not yet said whether the
  // snapshot is a meaningful share of the 533ms. Measure, then move it.
  const tBatch = Date.now();
  const [disclosure, outOfScope, canned, booking, services, phrasings, hoursRes, closuresRes, detRes, contactsRes, aliasRes, spellRes] = await Promise.all([
    db.from('disclosure_rules')
      .select('topic_key, matcher, quote_price, response_kind, deterministic_shortcircuit, provenance')
      .eq('tenant_id', input.tenantId),
    db.from('out_of_scope_topics')
      .select('topic_key, matcher, response_kind, deterministic_shortcircuit, provenance, quote_price, grounded_only')
      .eq('tenant_id', input.tenantId),
    db.from('canned_responses')
      .select('kind, body, reviewed_at')
      .eq('tenant_id', input.tenantId)
      .eq('locale', input.settings.defaultLocale),
    db.from('tenant_booking').select('booking_url').eq('tenant_id', input.tenantId),
    db.from('services').select('id, name').eq('tenant_id', input.tenantId),
    // Platform-wide rows carry tenant_id null and apply to everyone; a tenant's own rows
    // are added to them, never instead of them.
    db.from('forbidden_phrasings')
      .select('gate, stems, tenant_id')
      .or(`tenant_id.is.null,tenant_id.eq.${input.tenantId}`),
    db.from('business_hours')
      .select('weekday, opens, closes, closed')
      .eq('tenant_id', input.tenantId),
    // Only closures that could still be active. `ends_on >= today` on the TENANT's
    // calendar — the caller supplies it, because "today" is a question about their clock.
    db.from('tenant_closures')
      .select('starts_on, ends_on, title, message')
      .eq('tenant_id', input.tenantId)
      .gte('ends_on', input.localDate),
    db.from('deterministic_replies')
      .select('intent, body, enabled, match_mode, stems, cover_words, placement, quote_services, requires_empty_history, provenance')
      .eq('tenant_id', input.tenantId),
    // Read for `allowedUrls` only. The section body itself is compiled at publish time by
    // `prompt/sections.ts`; this is the request-path half, because the URL guard runs
    // against what the model just wrote rather than against the snapshot.
    db.from('contact_points').select('kind, value').eq('tenant_id', input.tenantId),
    db.from('service_aliases').select('service_id, alias').eq('tenant_id', input.tenantId),
    // Only what matching applies. An `ask` row is a question for the founder, and a
    // `rejected` one is his no — neither may change what fires.
    db.from('spellings').select('latin, cyrillic, status').eq('tenant_id', input.tenantId)
      .in('status', ['settled', 'confirmed']),
  ]);

  for (const [name, res] of [
    ['disclosure_rules', disclosure], ['out_of_scope_topics', outOfScope],
    ['canned_responses', canned], ['tenant_booking', booking], ['services', services],
    ['forbidden_phrasings', phrasings], ['business_hours', hoursRes], ['tenant_closures', closuresRes],
    ['deterministic_replies', detRes], ['contact_points', contactsRes], ['service_aliases', aliasRes],
    ['spellings', spellRes],
  ] as const) {
    if (res.error) return { ok: false, code: 'unavailable', detail: `${name} unreadable: ${res.error.message}` };
  }

  const cannedRows: CannedRow[] = (Array.isArray(canned.data) ? canned.data : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return { kind: String(r['kind']), body: String(r['body']), reviewedAt: r['reviewed_at'] === null ? null : String(r['reviewed_at']) };
  });
  if (cannedRows.length === 0) {
    return { ok: false, code: 'not_provisioned', detail: 'the tenant has no canned responses for this locale' };
  }

  const rules = [
    ...toRules(disclosure.data, false),
    // "We cannot know" never licenses a number.
    ...toRules(outOfScope.data, false),
  ];

  /**
   * Every link the tenant has declared, from BOTH tables that can hold one.
   *
   * It was `tenant_booking.booking_url` alone, and a URL from anywhere else was refused by
   * `urlsNotAllowed` — so Matrix's location, which `contact_points.kind` has allowed as
   * `maps_url` since `0001`, could be compiled into the prefix, quoted correctly by the
   * model, and then thrown away by the guard. That is D-068's shape in a different check:
   * a reply punished for using the tenant's own approved data. Which kinds count: see
   * `linkValues`, which the branch links below go through too.
   */
  const contactUrls = linkValues((Array.isArray(contactsRes.data) ? contactsRes.data : []).map((raw) => ({
    kind: String((raw as Record<string, unknown>)['kind'] ?? ''),
    value: String((raw as Record<string, unknown>)['value'] ?? ''),
  })));

  const hours: BusinessHours[] = (Array.isArray(hoursRes.data) ? hoursRes.data : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      weekday: Number(r['weekday']),
      opens: r['opens'] === null ? null : String(r['opens']),
      closes: r['closes'] === null ? null : String(r['closes']),
      closed: r['closed'] === true,
    };
  });

  // Branches (D-125), read ONLY when the live prefix lists two or more. The gate is the
  // prefix, not the tables: a tenant whose snapshot lists none never issues these reads, so
  // this path is safe for every tenant before `0047` is pushed — see `branches/load.ts`.
  const branchNames = branchNamesFromPrefix(snapshot.snapshot.promptStable);
  let branches: BranchContext[] = [];
  if (branchNames.length > 0) {
    const loadedBranches = await loadBranchContext(db, { tenantId: input.tenantId, names: branchNames, tenantHours: hours });
    if (!loadedBranches.ok) return { ok: false, code: 'unavailable', detail: loadedBranches.detail };
    branches = loadedBranches.branches;
  }
  // A branch's own map link is the tenant's approved data exactly as the tenant-wide one is,
  // and a guard that refused it would be D-068's shape again.
  const branchUrls = linkValues(branches.flatMap((b) => b.contacts));

  const allowedUrls = [
    ...(Array.isArray(booking.data) ? booking.data : [])
      .map((raw) => String((raw as Record<string, unknown>)['booking_url'] ?? ''))
      .filter((u) => u !== ''),
    ...contactUrls,
    ...branchUrls,
  ];

  const serviceNames = (Array.isArray(services.data) ? services.data : [])
    .map((raw) => String((raw as Record<string, unknown>)['name'] ?? ''))
    .filter((n) => n !== '');

  // Concession stems come from the tenant's own Ш6 rule, so a garage's vocabulary differs
  // from a salon's without a line of code changing.
  const concessionStems = rules
    .filter((r) => r.responseKind === 'refusal_no_promotion')
    .flatMap((r) => {
      const m = r.matcher as Record<string, unknown> | null;
      const stems = m === null || typeof m !== 'object' ? [] : m['stems'];
      return Array.isArray(stems) ? stems.filter((s): s is string => typeof s === 'string') : [];
    });

  // Item 7's per-gate lists. A row with no gate is DOCUMENTARY — evidence recorded but
  // not yet reduced to stems — and is skipped rather than silently flattened into some
  // other gate's list, which is the exact failure §6.7(a) describes.
  const forbiddenStemSeqs: Record<string, string[][]> = {};
  for (const raw of Array.isArray(phrasings.data) ? phrasings.data : []) {
    const r = raw as Record<string, unknown>;
    const gate = r['gate'];
    const stems = r['stems'];
    if (typeof gate !== 'string' || !Array.isArray(stems) || stems.length === 0) continue;
    const seq = stems.filter((x): x is string => typeof x === 'string' && x !== '');
    if (seq.length === 0) continue;
    (forbiddenStemSeqs[gate] ??= []).push(seq);
  }

  const tenantGuard: TenantGuardView = {
    primaryScript: scriptForLocale(input.settings.defaultLocale),
    allowedUrls,
    allowedNumbers: snapshot.snapshot.allowedNumbers,
    // A promotion is "the Ш6 rule exists and its own quote is permitted" — modelled as
    // the presence of a reviewed `refusal_no_promotion` line being ABSENT. Until
    // promotions are a first-class table this stays false, which refuses rather than
    // permits, and is stated here rather than hidden in a default.
    kbHasPromotion: false,
    concessionStems,
    forbiddenStemSeqs,
    // THE GATE, not the whole prefix (D-084, founder's call 2026-09-18: «a customer
    // reading Matrix's own knowledge base isn't a disclosure — that's the material the bot
    // exists to relay»). The fallback is the old corpus, and it is the safe direction: a
    // snapshot published before `0029` over-refuses exactly as it does today rather than
    // skipping the check, and the next republish narrows it.
    promptCorpus: snapshot.snapshot.promptGate ?? snapshot.snapshot.promptStable,
    cannedResponses: cannedRows.map((c) => c.body),
    scriptShareExclusions: [...serviceNames, ...allowedUrls],
    maxReplyChars: MAX_REPLY_CHARS,
  };

  const cacheMode = CACHE_MODES.has(input.settings.promptCacheMode) ? input.settings.promptCacheMode : 'off';

  const closures: Closure[] = (Array.isArray(closuresRes.data) ? closuresRes.data : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      startsOn: String(r['starts_on']), endsOn: String(r['ends_on']),
      title: String(r['title']), message: String(r['message']),
    };
  });

  const deterministic = toDeterministic(detRes.data);

  const nameById = new Map((Array.isArray(services.data) ? services.data : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return [String(r['id'] ?? ''), String(r['name'] ?? '')] as const;
  }));
  const serviceAliases = (Array.isArray(aliasRes.data) ? aliasRes.data : []).flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const name = nameById.get(String(r['service_id'] ?? ''));
    const alias = String(r['alias'] ?? '');
    return name === undefined || name === '' || alias === '' ? [] : [{ name, alias }];
  });

  const spellings = appliedSpellings((Array.isArray(spellRes.data) ? spellRes.data : []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return { latin: String(r['latin'] ?? ''), cyrillic: String(r['cyrillic'] ?? ''), status: String(r['status'] ?? '') };
  }).filter((r) => r.latin !== '' && r.cyrillic !== ''));

  return {
    ok: true,
    context: {
      promptStable: snapshot.snapshot.promptStable,
      deterministic,
      serviceAliases,
      spellings,
      branches,
      hours,
      closures,
      allowedNumbers: snapshot.snapshot.allowedNumbers,
      cannedHash: snapshot.snapshot.cannedHash,
      promptGate: snapshot.snapshot.promptGate,
      revisionId: snapshot.snapshot.revisionId,
      contentHash: snapshot.snapshot.contentHash,
      rules,
      canned: cannedRows,
      tenantGuard,
      cacheMode,
    },
    // Measured across the whole function, so `batch` includes the row-shaping below it
    // rather than the network alone. That is the honest bound: it is the time the caller
    // actually waits, which is what the phase is for.
    timings: { snapshot: snapshotMs, batch: Date.now() - tBatch },
  };
}
