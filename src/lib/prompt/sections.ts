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
  input: { tenantId: string },
): Promise<CompileOutcome> {
  const loaded = await loadPromptSections(db, input);
  if (!loaded.ok) return loaded;

  if (!loaded.sections.some((s) => s.origin === 'platform')) {
    return {
      ok: false,
      code: 'no_gate',
      detail:
        'no platform prompt blocks: the compiled prompt would carry this tenant\'s knowledge base ' +
        'with none of the Ш0–Ш9 boundary checks. Seed them with migration 0010.',
    };
  }

  const result = renderStablePrefix(loaded.sections);
  return result.ok
    ? { ok: true, rendered: result.rendered, sectionCount: loaded.sections.length }
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

  const compiled = await compileStablePrefix(db, { tenantId: input.tenantId });
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
