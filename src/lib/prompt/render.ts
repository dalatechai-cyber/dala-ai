/**
 * The prompt compiler's pure core: config rows in, a byte-stable prefix out.
 *
 * ## What this function structurally cannot do
 *
 * It takes no customer message. That is not an oversight — it is the enforcement of the
 * byte-stability rule (§6.4.2):
 *
 * > The cached block must be byte-identical for every request from a given
 * > `(tenant, config_version)`. Anything that varies per message goes after the
 * > breakpoint, or the cache does not exist.
 *
 * Two attractive ideas violate it. Selecting which gate checks to include based on the
 * inbound message would shrink the prefix and take the cache hit rate to **zero**. Adding
 * "today is {{date}}" to the prefix does the same. Both are silent: no error, no symptom,
 * and the bill roughly triples. `salonBrain.js:155` is one edit away from exactly that
 * bug today. Giving the renderer no access to a message or a clock makes the mistake
 * unavailable rather than forbidden.
 *
 * ## Why a tenant row can never become a platform rule
 *
 * §6.4.1: "a tenant may only tighten, never loosen" is enforced **by the renderer, not by
 * trust**. L0 and L1 are platform-origin; L2 and L3 are tenant data. A tenant-origin
 * section claiming layer L0 is refused rather than rendered, so there is no template path
 * in which a row's text lands above a platform rule, and no row shape whose value is
 * "delete check N".
 *
 * ## Platform blocks are rendered FIRST, and that is worth real money
 *
 * Ordering the platform block ahead of everything tenant-specific makes it **one cache
 * entry for the whole platform** instead of one per tenant — measured at 64% of the
 * prompt. Worth little at two tenants and a great deal at twenty, and it costs nothing
 * but ordering.
 */
import { createHash } from 'node:crypto';
import { extractNumerals } from '../mn/extract.ts';
import { cpLength, nfc } from '../mn/text.ts';

export type PromptLayer = 'L0' | 'L1' | 'L2' | 'L3';

/** Layers in wire order. L4 is the volatile tail and is never part of this. */
const LAYER_ORDER: readonly PromptLayer[] = ['L0', 'L1', 'L2', 'L3'];

/** Which layers a platform block may occupy, and which a tenant row may. */
const PLATFORM_LAYERS = new Set<PromptLayer>(['L0', 'L1']);
const TENANT_LAYERS = new Set<PromptLayer>(['L2', 'L3']);

export type PromptSection = {
  layer: PromptLayer;
  /** ASCII key for diagnostics — `gate_scaffold`, `price_list`. Never rendered. */
  key: string;
  ordinal: number;
  /** The Mongolian, from a signed platform file or a tenant row. Never from this file. */
  body: string;
  /**
   * Null until a native speaker has signed it off. A null here REFUSES the compile —
   * a partially provisioned tenant is an operator-visible state, not a silent
   * degradation (§6.5 caveat 2).
   */
  reviewedAt: string | null;
  origin: 'platform' | 'tenant';
};

export type RenderRefusal =
  /** A section has no native-speaker sign-off. The route 503s. */
  | { code: 'canned_response_unreviewed'; sections: string[] }
  /** A tenant row tried to occupy a platform layer, or vice versa. */
  | { code: 'layer_violation'; sections: string[] }
  /** Two sections claim the same slot, so the prefix would not be deterministic. */
  | { code: 'ambiguous_order'; sections: string[] }
  /** Nothing to render. An empty prompt is not a prompt. */
  | { code: 'empty_prefix'; sections: string[] };

export type Rendered = {
  /** L0+L1+L2+L3. Byte-stable per (tenant, config_version). Carries the cache breakpoint. */
  promptStable: string;
  /** sha256 over the STABLE prefix only — this is the prompt-cache identity. */
  contentHash: string;
  /** Characters, not UTF-16 units and not bytes. */
  promptChars: number;
  /** Every numeral the model may emit, from the prefix it can actually see. */
  allowedNumbers: string[];
  /** Section keys, in the exact order rendered. The reviewable artifact. */
  order: string[];
};

export type RenderResult = { ok: true; rendered: Rendered } | { ok: false; refusal: RenderRefusal };

/**
 * Deterministic order: layer, then origin, then ordinal, then key.
 *
 * The final `key` tiebreak is not decoration. Two sections with the same (layer, ordinal)
 * would otherwise render in whatever order the database returned them, so the prefix —
 * and therefore the cache key — would change between deployments for no visible reason.
 * `ambiguous_order` refuses that case outright rather than relying on the tiebreak,
 * because a silently reordered prompt is a silently different product.
 */
function sortSections(sections: readonly PromptSection[]): PromptSection[] {
  return [...sections].sort((a, b) => {
    const layerDiff = LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer);
    if (layerDiff !== 0) return layerDiff;
    if (a.origin !== b.origin) return a.origin === 'platform' ? -1 : 1;
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function renderStablePrefix(sections: readonly PromptSection[]): RenderResult {
  const unreviewed = sections.filter((s) => s.reviewedAt === null).map((s) => s.key);
  if (unreviewed.length > 0) return { ok: false, refusal: { code: 'canned_response_unreviewed', sections: unreviewed } };

  const misplaced = sections
    .filter((s) =>
      (s.origin === 'platform' && !PLATFORM_LAYERS.has(s.layer)) ||
      (s.origin === 'tenant' && !TENANT_LAYERS.has(s.layer)))
    .map((s) => `${s.key}(${s.origin}/${s.layer})`);
  if (misplaced.length > 0) return { ok: false, refusal: { code: 'layer_violation', sections: misplaced } };

  const slots = new Map<string, string[]>();
  for (const s of sections) {
    const slot = `${s.layer}/${s.origin}/${s.ordinal}`;
    slots.set(slot, [...(slots.get(slot) ?? []), s.key]);
  }
  const clashes = [...slots.entries()].filter(([, keys]) => keys.length > 1).map(([slot]) => slot);
  if (clashes.length > 0) return { ok: false, refusal: { code: 'ambiguous_order', sections: clashes } };

  const ordered = sortSections(sections);
  const promptStable = ordered.map((s) => nfc(s.body)).join('\n\n');
  if (promptStable.trim() === '') return { ok: false, refusal: { code: 'empty_prefix', sections: [] } };

  return {
    ok: true,
    rendered: {
      promptStable,
      contentHash: createHash('sha256').update(promptStable, 'utf8').digest('hex'),
      promptChars: cpLength(promptStable),
      allowedNumbers: allowedNumbersFrom(promptStable),
      order: ordered.map((s) => s.key),
    },
  };
}

/**
 * Every numeral the compiled prompt contains — prices, the phone number, opening hours,
 * deposit amounts. This is `config_snapshots.allowed_numbers`, and the outbound guard
 * refuses any numeral in a reply that is not in it.
 *
 * **Deliberately NOT included: numerals from the customer's own message.** A customer who
 * writes «Үс засалт 5000₮ юу?» has put a number in front of the model, and echoing it back
 * as confirmation invents a price the salon never set — the customer merely suggested it.
 * The cost of the strict reading is a false refusal when a reply repeats a time the
 * customer proposed, which sends the pinned handoff line. That is the §6.5 composition
 * trade again, and it is recorded as an open question in V1.md rather than decided here.
 */
export function allowedNumbersFrom(text: string): string[] {
  return [...new Set(extractNumerals(text).map((n) => n.raw))].sort();
}

/**
 * The volatile tail, L4. Never hashed, never cached, never allowed to touch the prefix.
 *
 * Splitting this into its own block is what makes the trap structurally unavailable: the
 * ancestor concatenates its closure section onto the cached base prompt, so anything
 * date-shaped added there would invalidate every entry. ~180 uncached tokens cost
 * $0.00036/message — the price of never having that bug.
 */
export function renderVolatileTail(parts: readonly string[]): string {
  return parts.map(nfc).filter((p) => p.trim() !== '').join('\n');
}
