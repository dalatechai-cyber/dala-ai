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
  input: { tenantId: string },
): Promise<SectionsOutcome> {
  const { data, error } = await db
    .from('prompt_blocks')
    .select('scope, tenant_id, block_key, ordinal, layer, body, reviewed_at')
    .or(`and(scope.eq.platform,tenant_id.is.null),and(scope.eq.tenant,tenant_id.eq.${input.tenantId})`);

  if (error) return { ok: false, code: 'unavailable', detail: `prompt_blocks unreadable: ${error.message}` };

  const sections: PromptSection[] = [];
  for (const raw of Array.isArray(data) ? data : []) {
    const section = toSection(raw as Record<string, unknown>);
    if (section !== null) sections.push(section);
  }
  return { ok: true, sections };
}

export type TenantKbOutcome =
  | { ok: true; kb: TenantKb }
  | { ok: false; detail: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const orNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/**
 * Every row L2 and L3 are rendered from, for one tenant.
 *
 * ## Every query is explicitly ORDERED, and that is not tidiness
 *
 * PostgREST returns rows in whatever order the planner produced. An unordered read makes
 * the rendered prefix — and therefore `content_hash`, and therefore the prompt-cache key —
 * differ between two compiles of *identical rows*. The symptom is not an error: it is a
 * cache that never hits, silently, and a bill that roughly triples. That is the same
 * failure `renderStablePrefix` refuses as `ambiguous_order` at the section level, one
 * layer down at the row level, where the renderer cannot see it.
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
    db.from('disclosure_rules').select('topic_key').eq('tenant_id', t).order('topic_key'),
    db.from('out_of_scope_topics').select('topic_key').eq('tenant_id', t).order('topic_key'),
    db.from('disambiguation_pairs').select('trigger_term, question').eq('tenant_id', t).order('trigger_term'),
    db.from('price_axes').select('axis, verbatim_question').eq('tenant_id', t).order('ordinal').order('axis'),
    db.from('deposit_rules').select('applies_to, rule_text').eq('tenant_id', t).order('ordinal').order('applies_to'),
    db.from('knowledge_documents').select('title, body').eq('tenant_id', t).order('title'),
    db.from('staff_members').select('name, group_name, tier').eq('tenant_id', t).eq('active', true).order('group_name').order('name'),
    db.from('services').select('id, name').eq('tenant_id', t).eq('active', true).order('name'),
    db.from('service_variants').select('service_id, variant_key, price_kind, price_min, price_max, refusal_topic').eq('tenant_id', t).order('variant_key'),
    db.from('faqs').select('question, answer').eq('tenant_id', t).order('ordinal').order('question'),
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

  const tRow = tenant.data as Record<string, unknown>;
  const byService = new Map<string, ServiceVariant[]>();
  for (const v of rows(variants.data)) {
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
    kb: {
      currencySymbol: str(tRow['currency_symbol']) || '\u20ae',
      currencySymbolBefore: tRow['currency_symbol_before'] === true,
      // Both refusal tables feed one list: Ш1 asks whether the message matches a topic in
      // «ХОРИОТОЙ СЭДВҮҮД», and does not care which table the topic came from.
      refusalTopics: [
        ...rows(disclosure.data).map((r) => str(r['topic_key'])),
        ...rows(outOfScope.data).map((r) => str(r['topic_key'])),
      ].filter((k) => k !== '').sort(),
      clarify: [
        ...rows(disambig.data).map((r) => ({ term: str(r['trigger_term']), question: str(r['question']) })),
        ...rows(axes.data).map((r) => ({ term: str(r['axis']), question: str(r['verbatim_question']) })),
      ],
      deposits: rows(deposits.data).map((r) => `${str(r['applies_to'])}: ${str(r['rule_text'])}`),
      documents: rows(documents.data).map((r) => ({ title: str(r['title']), body: str(r['body']) })),
      staff: rows(staff.data).map((r) => ({
        name: str(r['name']), groupName: orNull(r['group_name']), tier: orNull(r['tier']),
      })),
      services: rows(services.data).map((r) => ({
        name: str(r['name']),
        variants: byService.get(str(r['id'])) ?? [],
      })),
      faqs: rows(faqs.data).map((r) => ({ question: str(r['question']), answer: str(r['answer']) })),
      contacts: rows(contacts.data).map((r) => ({ kind: str(r['kind']), value: str(r['value']) })),
      bookingUrl: booking.data === null ? null : orNull((booking.data as Record<string, unknown>)['booking_url']),
    },
  };
}

export type CompileOutcome =
  | { ok: true; rendered: Rendered; sectionCount: number }
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
  const loaded = await loadPromptSections(db, { tenantId: input.tenantId });
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
    ? { ok: true, rendered: result.rendered, sectionCount: sections.length }
    : { ok: false, code: 'refused', refusal: result.refusal };
}


export type CompilePublishOutcome =
  | { ok: true; revisionId: string; contentHash: string; sectionCount: number }
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
      }
    : { ok: false, code: published.code, detail: published.detail };
}
