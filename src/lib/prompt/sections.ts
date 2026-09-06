/**
 * The last link: `prompt_blocks` rows → `PromptSection[]` → a compiled prefix.
 *
 * `renderStablePrefix` has been built, tested and unreachable since Track 1. It is a pure
 * function over sections and **nothing built sections**, so twelve signed gate blocks sat
 * in a table that no code read. Signed, seeded, never compiled. This closes that.
 *
 * ## Where this runs, and why it is not in the request path
 *
 * At **publish** time, not per message. `loadReceptionContext` reads `promptStable` out of
 * `config_snapshots` via `tenants.live_revision_id` — a frozen rendering, not a live
 * compile. That is deliberate (see `publish.ts`): a rollback must restore the exact bytes
 * that were live, which it cannot do if the prompt is recompiled from rows that may have
 * drifted since. So compilation happens once, its output is immutable, and the pointer
 * chooses which output is live.
 *
 * It is also why `renderStablePrefix` refuses a clock and a customer message: anything
 * per-request in the prefix takes the cache hit rate to zero, silently.
 *
 * ## Unreviewed blocks are LOADED, not filtered out
 *
 * The tempting query is `where reviewed_at is not null`, mirroring `statusPage.ts`. It is
 * wrong here, and the difference is worth stating because the two look identical.
 *
 * On the status page a missing block means *do not render the page* — the caller checks
 * the full key list and refuses, so filtering and refusing are the same outcome. Here a
 * filtered-out block means **a gate check silently absent from the prompt**: the compile
 * succeeds, the prefix is one Ш block shorter, and the boundary it enforced is simply
 * gone. Nothing would say so.
 *
 * So every block is loaded and `renderStablePrefix` refuses with
 * `canned_response_unreviewed`, naming them. Loud beats tidy on this path.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderStablePrefix, type PromptLayer, type PromptSection, type Rendered, type RenderRefusal } from './render.ts';
import { publishRevision, type PublishOutcome } from './publish.ts';
import { renderTenantSections, type PriceKind, type ServiceVariant, type TenantKb } from './tenant.ts';
import { isTenantConfirmed, unconfirmedNames } from '../provenance.ts';
import { byCodePoint } from '../mn/text.ts';

/** Layers the compiler renders. A row with `layer` null is not a prompt section at all —
 *  the data-deletion status strings and the comment reply template live in the same table
 *  and must never reach a system prompt. */
const RENDERABLE_LAYERS = new Set<string>(['L0', 'L1', 'L2', 'L3']);

export type SectionsOutcome =
  | { ok: true; sections: PromptSection[] }
  | { ok: false; code: 'unavailable'; detail: string };

function toSection(row: Record<string, unknown>): PromptSection | null {
  const layer = String(row['layer'] ?? '');
  if (!RENDERABLE_LAYERS.has(layer)) return null;
  const scope = String(row['scope'] ?? '');
  if (scope !== 'platform' && scope !== 'tenant') return null;
  const key = String(row['block_key'] ?? '');
  if (key === '') return null;

  const ordinal = Number(row['ordinal']);
  return {
    layer: layer as PromptLayer,
    key,
    // A non-numeric ordinal would sort as NaN, which compares false against everything and
    // makes the order depend on the input sequence — i.e. on what the database returned.
    // The column is NOT NULL integer, so this is belt and braces; it costs one check and
    // removes a whole class of non-deterministic prefix.
    ordinal: Number.isFinite(ordinal) ? ordinal : 0,
    body: String(row['body'] ?? ''),
    reviewedAt: row['reviewed_at'] === null || row['reviewed_at'] === undefined ? null : String(row['reviewed_at']),
    origin: scope,
  };
}

/**
 * Every renderable block for one tenant: the platform's, plus that tenant's own.
 *
 * One query, not two. The `or` is a single round trip and — more importantly — a single
 * consistent read: two queries could straddle a publish and compile half of one
 * configuration with half of another.
 *
 * The tenant filter is explicit rather than left to RLS. These reads run under
 * `service_role`, which holds BYPASSRLS, so there is no policy running to add it
 * (`supabase/clients.ts`). A missing `tenant_id` here would pull every tenant's blocks
 * into one prompt.
 */
export async function loadPromptSections(
  db: SupabaseClient,
  input: { tenantId: string; vertical: string },
): Promise<SectionsOutcome> {
  const { data, error } = await db
    .from('prompt_blocks')
    .select('scope, tenant_id, block_key, ordinal, layer, body, reviewed_at, vertical')
    .or(`and(scope.eq.platform,tenant_id.is.null),and(scope.eq.tenant,tenant_id.eq.${input.tenantId})`);

  if (error) return { ok: false, code: 'unavailable', detail: `prompt_blocks unreadable: ${error.message}` };

  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];

  // 0018: a platform block may be written for one vertical. Null (or empty) means every
  // tenant, which is every block that exists today.
  //
  // ## The match happens HERE and not in the `.or()` above
  //
  // `tenants.vertical` is free-form text an operator types, and interpolating it into a
  // PostgREST filter string is an injection surface — the tenant id above is a uuid and
  // safe, a vertical is not. The platform block set is a dozen rows, so filtering in
  // JavaScript costs nothing and removes the question entirely.
  //
  // ## Most specific wins, per block key
  //
  // A key may have a generic row and per-vertical rows; taking both would put two sections
  // in one layer/origin/ordinal slot and `renderStablePrefix` would refuse the whole
  // compile as `ambiguous_order`. Preferring the vertical makes that unrepresentable
  // rather than merely discouraged, and it means a vertical nobody has written examples
  // for keeps the generic block instead of losing it — a quieter gap, which is why
  // `catalog.sql` V29 asks separately whether every vertical is covered.
  const chosen = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (String(row['scope'] ?? '') !== 'platform') continue;
    const key = String(row['block_key'] ?? '');
    const vertical = typeof row['vertical'] === 'string' ? row['vertical'] : '';
    if (vertical !== '' && vertical !== input.vertical) continue;
    const held = chosen.get(key);
    const heldVertical = held === undefined ? null : (typeof held['vertical'] === 'string' ? held['vertical'] : '');
    if (held === undefined || (heldVertical === '' && vertical !== '')) chosen.set(key, row);
  }

  const sections: PromptSection[] = [];
  for (const row of rows) {
    const isPlatform = String(row['scope'] ?? '') === 'platform';
    if (isPlatform && chosen.get(String(row['block_key'] ?? '')) !== row) continue;
    const section = toSection(row);
    if (section !== null) sections.push(section);
  }
  return { ok: true, sections };
}

/**
 * What provenance changed about this compile (D-020).
 *
 * ## The asymmetry is the design, and it is not a compromise
 *
 * A row that is not `tenant_confirmed` is handled by what the row *does*, never by which
 * table it sits in:
 *
 *  - **A FAQ is a fact stated to a customer.** An unconfirmed one is EXCLUDED. A guessed
 *    answer in the prefix is a sentence the salon is then expected to honour, and — since
 *    `allowed_numbers` is drawn from the tenant sections — a guessed *price* in a FAQ also
 *    allow-lists itself past the outbound guard. Excluding costs a question the bot cannot
 *    answer, which falls to the handoff line.
 *  - **A refusal topic is an instruction not to answer.** An unconfirmed one is KEPT, and
 *    counted. Dropping it would disarm a refusal — the exact failure `matchRules` refuses
 *    to commit when a matcher will not parse. A seeded refusal is over-cautious; a missing
 *    one lets a price out. Those costs are not comparable.
 *
 * Both halves are reported, because "the compile was quieter than the rows suggest" must
 * be visible from the outside.
 */
export type KbProvenance = {
  /** Questions whose FAQ rows were withheld from the prefix. */
  faqsExcluded: string[];
  /** Refusal topics that fired into the prompt without confirmation. */
  refusalTopicsUnconfirmed: string[];
};

export const NO_UNCONFIRMED: KbProvenance = { faqsExcluded: [], refusalTopicsUnconfirmed: [] };

export type TenantKbOutcome =
  | { ok: true; kb: TenantKb; unconfirmed: KbProvenance }
  | { ok: false; detail: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Order rows deterministically IN JAVASCRIPT, by code point, never by the database.
 *
 * SQL `order by` sorts under the server's collation, and the two environments do not agree:
 * CI runs `C.UTF-8` and the Supabase project runs `en_US.UTF-8`. Measured on the same six
 * Mongolian strings they produce completely different orders (see `byCodePoint`). That
 * order becomes the line order of the rendered L2/L3 sections, which becomes the prefix,
 * which becomes `content_hash` — the prompt-cache key.
 *
 * Two consequences, the second worse than the first: the prefix CI compiles from a set of
 * rows is not the one production compiles from the same rows; and glibc collation carries
 * a version, so an OS-level bump under the database would silently re-order every section
 * and cold-miss every cached prefix, with no error to notice. Sorting here makes the order
 * a property of the rows rather than of the machine they were read from.
 *
 * Every call passes enough keys to leave no ties to luck: the natural key first, then
 * whatever else distinguishes two rows. `Array.prototype.sort` is stable, but the input
 * order is PostgREST's, so stability alone would only preserve a nondeterminism.
 */
function ordered<T>(list: readonly T[], ...keys: readonly ((row: T) => string | number)[]): T[] {
  return [...list].sort((a, b) => {
    for (const key of keys) {
      const av = key(a);
      const bv = key(b);
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av !== bv) return av < bv ? -1 : 1;
      } else {
        const c = byCodePoint(String(av), String(bv));
        if (c !== 0) return c;
      }
    }
    return 0;
  });
}
const orNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/**
 * Every row L2 and L3 are rendered from, for one tenant.
 *
 * ## Ordering is decided HERE, in JavaScript — not by the database
 *
 * PostgREST returns rows in whatever order the planner produced, and an unordered read
 * makes the rendered prefix — and therefore `content_hash`, and therefore the prompt-cache
 * key — differ between two compiles of *identical rows*. The symptom is not an error: it
 * is a cache that never hits, silently, and a bill that roughly triples. That is
 * `renderStablePrefix`'s `ambiguous_order` refusal one layer down, where the renderer
 * cannot see it.
 *
 * The queries below still carry `.order()`, but **nothing relies on it**. Ordering the
 * database performs is collation-dependent, and the two environments disagree: CI runs
 * `C.UTF-8`, the Supabase project runs `en_US.UTF-8`, and on the same six Mongolian
 * strings they produce completely different orders (measured 2026-09-05; see
 * `byCodePoint`). So the prefix CI compiles is not the prefix production compiles from the
 * same rows — and worse, glibc collation is versioned, so an OS-level bump beneath the
 * database would re-order every section and cold-miss every warm cache entry with nothing
 * anywhere going red.
 *
 * `ordered()` therefore sorts by code point after loading, making the order a property of
 * the rows rather than of the server they were read from. The `.order()` calls stay as
 * documentation of intent and as deterministic pagination if a LIMIT is ever added.
 *
 * ## Every read that fails REFUSES
 *
 * `load.ts`'s discipline, for a stronger reason: this output is frozen into an immutable
 * snapshot and served until somebody publishes again. A half-loaded knowledge base at
 * request time is one bad reply; a half-loaded one at publish time is every reply until
 * the next publish, with a price list missing the rows whose read happened to fail.
 */
export async function loadTenantKb(
  db: SupabaseClient,
  input: { tenantId: string },
): Promise<TenantKbOutcome> {
  const t = input.tenantId;
  const [
    tenant, disclosure, outOfScope, disambig, axes, deposits,
    documents, staff, services, variants, faqs, contacts, booking,
  ] = await Promise.all([
    db.from('tenants').select('currency_symbol, currency_symbol_before').eq('id', t).maybeSingle(),
    db.from('disclosure_rules').select('topic_key, decision_question, provenance').eq('tenant_id', t).order('topic_key'),
    db.from('out_of_scope_topics').select('topic_key, decision_question, provenance').eq('tenant_id', t).order('topic_key'),
    db.from('disambiguation_pairs').select('trigger_term, question').eq('tenant_id', t).order('trigger_term'),
    db.from('price_axes').select('axis, verbatim_question').eq('tenant_id', t).order('ordinal').order('axis'),
    db.from('deposit_rules').select('applies_to, rule_text').eq('tenant_id', t).order('ordinal').order('applies_to'),
    db.from('knowledge_documents').select('title, body').eq('tenant_id', t).order('title'),
    db.from('staff_members').select('name, short_name, group_name, tier').eq('tenant_id', t).eq('active', true).order('group_name').order('name'),
    db.from('services').select('id, name').eq('tenant_id', t).eq('active', true).order('name'),
    db.from('service_variants').select('service_id, variant_key, price_kind, price_min, price_max, refusal_topic').eq('tenant_id', t).order('variant_key'),
    db.from('faqs').select('question, answer, provenance').eq('tenant_id', t).order('ordinal').order('question'),
    db.from('contact_points').select('kind, value').eq('tenant_id', t).order('kind'),
    db.from('tenant_booking').select('booking_url').eq('tenant_id', t).maybeSingle(),
  ]);

  for (const [name, res] of [
    ['tenants', tenant], ['disclosure_rules', disclosure], ['out_of_scope_topics', outOfScope],
    ['disambiguation_pairs', disambig], ['price_axes', axes], ['deposit_rules', deposits],
    ['knowledge_documents', documents], ['staff_members', staff], ['services', services],
    ['service_variants', variants], ['faqs', faqs], ['contact_points', contacts],
    ['tenant_booking', booking],
  ] as const) {
    if (res.error) return { ok: false, detail: `${name} unreadable: ${res.error.message}` };
  }
  if (tenant.data === null) return { ok: false, detail: 'no such tenant' };

  // D-020, the facts half. Split rather than filtered inline so the excluded ones can be
  // named: a FAQ that vanished from the prompt with nothing said about it is the silence
  // this decision exists to end.
  const faqRows = rows(faqs.data);
  const faqsKept = faqRows.filter((r) => isTenantConfirmed(r['provenance']));
  const faqsExcluded = unconfirmedNames(faqRows.filter((r) => !isTenantConfirmed(r['provenance'])).map((r) => str(r['question'])));

  // D-020, the refusals half: kept whatever they claim, counted either way.
  const refusalRows = [...rows(disclosure.data), ...rows(outOfScope.data)];
  const refusalTopicsUnconfirmed = unconfirmedNames(
    refusalRows.filter((r) => !isTenantConfirmed(r['provenance'])).map((r) => str(r['topic_key'])),
  );

  const tRow = tenant.data as Record<string, unknown>;
  const byService = new Map<string, ServiceVariant[]>();
  for (const v of ordered(rows(variants.data), (r) => str(r['variant_key']))) {
    const id = str(v['service_id']);
    const list = byService.get(id) ?? [];
    list.push({
      variantKey: str(v['variant_key']),
      priceKind: str(v['price_kind']) as PriceKind,
      priceMin: orNull(v['price_min']),
      priceMax: orNull(v['price_max']),
      refusalTopic: orNull(v['refusal_topic']),
    });
    byService.set(id, list);
  }

  return {
    ok: true,
    unconfirmed: { faqsExcluded, refusalTopicsUnconfirmed },
    kb: {
      currencySymbol: str(tRow['currency_symbol']) || '\u20ae',
      currencySymbolBefore: tRow['currency_symbol_before'] === true,
      // Both refusal tables feed one list: Ш1 asks whether the message matches a topic in
      // «ХОРИОТОЙ СЭДВҮҮД», and does not care which table the topic came from.
      // Sorted by key, so two compiles of identical rows produce identical bytes — the
      // two tables are read separately and PostgREST promises nothing about their order
      // relative to each other.
      refusalTopics: ordered(
        refusalRows
          .map((r) => ({ key: str(r['topic_key']), question: str(r['decision_question']) }))
          .filter((t) => t.key !== ''),
        (t) => t.key,
      ),
      clarify: [
        ...ordered(rows(disambig.data), (r) => str(r['trigger_term']), (r) => str(r['question']))
          .map((r) => ({ term: str(r['trigger_term']), question: str(r['question']) })),
        // Ordinal first, because it is the tenant's own priority and not a tiebreak.
        ...ordered(rows(axes.data), (r) => num(r['ordinal']), (r) => str(r['axis']))
          .map((r) => ({ term: str(r['axis']), question: str(r['verbatim_question']) })),
      ],
      deposits: ordered(rows(deposits.data), (r) => num(r['ordinal']), (r) => str(r['applies_to']), (r) => str(r['rule_text']))
        .map((r) => `${str(r['applies_to'])}: ${str(r['rule_text'])}`),
      documents: ordered(rows(documents.data), (r) => str(r['title']), (r) => str(r['body']))
        .map((r) => ({ title: str(r['title']), body: str(r['body']) })),
      staff: ordered(rows(staff.data), (r) => str(r['group_name']), (r) => str(r['name']), (r) => str(r['tier']))
        .map((r) => ({
          name: str(r['name']), shortName: orNull(r['short_name']),
          groupName: orNull(r['group_name']), tier: orNull(r['tier']),
        })),
      services: ordered(rows(services.data), (r) => str(r['name']), (r) => str(r['id'])).map((r) => ({
        name: str(r['name']),
        variants: byService.get(str(r['id'])) ?? [],
      })),
      faqs: ordered(faqsKept, (r) => num(r['ordinal']), (r) => str(r['question']), (r) => str(r['answer']))
        .map((r) => ({ question: str(r['question']), answer: str(r['answer']) })),
      contacts: ordered(rows(contacts.data), (r) => str(r['kind']), (r) => str(r['value']))
        .map((r) => ({ kind: str(r['kind']), value: str(r['value']) })),
      bookingUrl: booking.data === null ? null : orNull((booking.data as Record<string, unknown>)['booking_url']),
    },
  };
}

export type CompileOutcome =
  | { ok: true; rendered: Rendered; sectionCount: number; unconfirmed: KbProvenance }
  | { ok: false; code: 'unavailable'; detail: string }
  /** The renderer refused. Every case names the sections responsible. */
  | { ok: false; code: 'refused'; refusal: RenderRefusal }
  /** No platform block reached the renderer. See below — this is the dangerous one. */
  | { ok: false; code: 'no_gate'; detail: string };

/**
 * Compile one tenant's stable prefix.
 *
 * ## The `no_gate` refusal is the load-bearing check here
 *
 * Without it, a database whose `prompt_blocks` platform rows are missing — `0010` not
 * applied, a bad restore, someone's DELETE — compiles **successfully** into a prompt made
 * only of that tenant's own knowledge base. That prompt has the price list and the staff
 * roster and none of Ш0–Ш9: no public-channel rule, no refusal topics, no price
 * discipline, no health boundary. It is not a degraded product, it is the *opposite*
 * product, and every check this codebase spends its effort on lives in those blocks.
 *
 * `empty_prefix` does not catch it, because the prefix is not empty. Nothing else would.
 */
export async function compileStablePrefix(
  db: SupabaseClient,
  input: { tenantId: string; approvedAt: string },
): Promise<CompileOutcome> {
  // The tenant's vertical selects which per-vertical platform blocks apply (0018). Read
  // before the blocks rather than alongside them: an unreadable tenant must not silently
  // become a tenant with no vertical, which would compile the generic prompt for a tenant
  // that has examples of its own.
  const { data: tenantRow, error: tenantErr } = await db
    .from('tenants').select('vertical').eq('id', input.tenantId).maybeSingle();
  if (tenantErr) return { ok: false, code: 'unavailable', detail: `tenants unreadable: ${tenantErr.message}` };
  if (tenantRow === null) return { ok: false, code: 'unavailable', detail: 'no such tenant' };
  const vertical = String((tenantRow as Record<string, unknown>)['vertical'] ?? '');

  const loaded = await loadPromptSections(db, { tenantId: input.tenantId, vertical });
  if (!loaded.ok) return loaded;

  // L2/L3 from the tenant's own rows. `prompt_blocks` can also hold tenant-scope sections
  // and both are merged here; today nothing writes those, so in practice this is the
  // platform gate plus the rendered knowledge base.
  const kb = await loadTenantKb(db, { tenantId: input.tenantId });
  if (!kb.ok) return { ok: false, code: 'unavailable', detail: kb.detail };

  const sections = [...loaded.sections, ...renderTenantSections(kb.kb, input.approvedAt)];

  if (!sections.some((s) => s.origin === 'platform')) {
    return {
      ok: false,
      code: 'no_gate',
      detail:
        'no platform prompt blocks: the compiled prompt would carry this tenant\'s knowledge base ' +
        'with none of the Ш0–Ш9 boundary checks. Seed them with migration 0010.',
    };
  }

  const result = renderStablePrefix(sections);
  return result.ok
    ? { ok: true, rendered: result.rendered, sectionCount: sections.length, unconfirmed: kb.unconfirmed }
    : { ok: false, code: 'refused', refusal: result.refusal };
}


export type CompilePublishOutcome =
  /**
   * `unconfirmed` is part of the SUCCESS shape on purpose. A publish that quietly dropped
   * four FAQs is a successful publish of a different configuration, and a caller that
   * never sees which rows were withheld cannot tell the two apart.
   */
  | { ok: true; revisionId: string; contentHash: string; sectionCount: number; unconfirmed: KbProvenance }
  | { ok: false; code: 'unavailable' | 'refused' | 'no_gate' | 'publish_failed' | 'no_snapshot' | 'not_draft'; detail: string };

/**
 * Compile a tenant's prefix and publish it as a revision. The whole chain, in one call.
 *
 * This is what makes `renderStablePrefix` reachable. Until it existed the compiler, the
 * publisher and the signed blocks were three finished pieces with no wire between them.
 *
 * ## One compile, one snapshot per channel
 *
 * `config_snapshots` is keyed per channel, but the prefix is not channel-specific and must
 * not become so: **Ш0 is the channel rule, and it lives inside the prompt.** The model is
 * told to ask itself whether this reply is public and to behave accordingly — which is
 * what lets one cached prefix serve both surfaces. Compiling per channel would double the
 * cache entries to say the same thing, and would create a prompt in which Ш0 could be
 * omitted for the DM channel "because it does not apply" — the exact reasoning that makes
 * a public price leak possible.
 *
 * So: compiled once, stored once per channel, identical bytes and identical
 * `content_hash`.
 */
export async function compileAndPublish(
  db: SupabaseClient,
  input: {
    tenantId: string;
    revisionId: string;
    channels: readonly string[];
    now: Date;
    compiledBy?: string | null;
    publishedBy?: string | null;
  },
): Promise<CompilePublishOutcome> {
  if (input.channels.length === 0) {
    return { ok: false, code: 'no_snapshot', detail: 'a revision with no channel cannot render a reply' };
  }

  const compiled = await compileStablePrefix(db, {
    tenantId: input.tenantId,
    // The revision IS the approval unit for tenant data — see renderTenantSections.
    approvedAt: input.now.toISOString(),
  });
  if (!compiled.ok) {
    return compiled.code === 'refused'
      ? {
          ok: false,
          code: 'refused',
          detail: `${compiled.refusal.code}: ${compiled.refusal.sections.join(', ')}`,
        }
      : { ok: false, code: compiled.code, detail: compiled.detail };
  }

  const published: PublishOutcome = await publishRevision(db, {
    tenantId: input.tenantId,
    revisionId: input.revisionId,
    snapshots: input.channels.map((channel) => ({
      channel,
      rendered: compiled.rendered,
      compiledBy: input.compiledBy ?? null,
    })),
    now: input.now,
    publishedBy: input.publishedBy ?? null,
  });

  return published.ok
    ? {
        ok: true,
        revisionId: published.revisionId,
        contentHash: compiled.rendered.contentHash,
        sectionCount: compiled.sectionCount,
        unconfirmed: compiled.unconfirmed,
      }
    : { ok: false, code: published.code, detail: published.detail };
}
