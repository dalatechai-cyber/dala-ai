/**
 * COMPILED CEILINGS. This file is one of exactly two places a spend limit may live,
 * and the other is `tenant_budgets`, which can only ever LOWER what is here.
 *
 * ## Why these are not environment variables
 *
 * An env var is editable in a dashboard by one person in ten seconds, with no review, no
 * diff, no audit trail and no second pair of eyes. A ceiling that can move that way is
 * not a ceiling. Putting them in a compiled file means raising one is a commit, a diff
 * and a reviewer. `scripts/guards/check-no-ceiling-env.mjs` fails the build if any
 * identifier matching /CEILING|BUDGET|LIMIT/ is ever read from `process.env`.
 *
 * ## Changing a value here
 *
 * Name the approver in the commit message. That is the whole review process, and it is
 * the reason this file exists rather than a dashboard field.
 */

// §6.2.6: model ids live in exactly ONE file, and it is JSON so the .mjs bake-off
// harness reads the same source. Guarded by scripts/guards/check-model-ids.mjs.
import MODELS from '../../config/models.json' with { type: 'json' };
import { usdToNano, type NanoUsd } from '../lib/money.ts';

/**
 * The hard cap per tenant per day, per surface. Derived from D-004's formula on the
 * DISCOUNTED floor price, because the bundle discounts are hard floors:
 *
 *     monthly_ceiling_usd = floor_price_mnt × (1 − target_margin) / fx_mnt_per_usd
 *     ₮200,000 × 0.40 / 3,500 = $22.86/month
 *
 * Divided across a 30.44-day month, with 2× headroom for a burst day, because a salon's
 * traffic is not flat — the measured spread was 28 to 94 replies in one week (D-016).
 * The MONTHLY ceiling is the real control; this daily one exists to stop a single runaway
 * day from consuming the month before anyone is awake to see the alert.
 */
export const SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY = 1.5;

/**
 * Across every tenant. This is the number that stands between a platform-wide bug and
 * the Anthropic invoice, and it is deliberately not a multiple of the per-tenant cap:
 * at two tenants it is generous, and it stays a real bound as tenants are added.
 */
export const PLATFORM_HARD_CAP_USD_PER_DAY = 10.0;

/**
 * Analytics and Quality are BUDGETED AT ZERO and must stay there.
 *
 * Next door, a generator with no dollar ceiling at all — no budget, no ledger, and an
 * affordability term that did not exist — was bounded only by a depth read, and that
 * read was cached. Zero is the only value that refuses without depending on a read
 * succeeding. Raising either re-opens an unbounded generator: say who approved it.
 */
export const ANALYTICS_RUN_BUDGET_USD = 0;
export const QUALITY_RUN_BUDGET_USD = 0;

/**
 * D-015: Reception is sold against this many conversations per month. Not a spend
 * ceiling — the ceiling is unchanged — but the number the ceiling is honest about.
 *
 * D-016 measured Matrix at ~307 conversations/month, inside this. It rests on A7 = 6
 * messages/conversation, which is NOT measured; the mirror phase re-derives it from
 * distinct PSIDs over 14 days. Do not defend 400 — replace it with the measurement.
 */
export const RECEPTION_CONVERSATION_BAND_PER_MONTH = 400;

/**
 * D-010: model ids are platform constants, never tenant config. A tenant carries a
 * `model_tier`; this registry is the only place a tier becomes an id, so a tenant's
 * configuration can never change what WE pay per message.
 *
 * No date suffixes — the schema CHECK rejects them, because the ancestor pinned
 * `claude-haiku-4-5-20251001` in one channel and `claude-sonnet-5` in another, and one
 * of them was stale.
 */
export const MODEL_REGISTRY = MODELS.tiers as {
  /** D-009: customer-facing Mongolian prose. No Haiku here — it is a fluency ceiling. */
  readonly reception: string;
  /** Internal and structured work, where the output is a row rather than a sentence. */
  readonly internal: string;
};

export type ModelTier = keyof typeof MODEL_REGISTRY;

/** Nano-USD forms, computed once. */
export const CAPS = {
  perTenantPerSurfacePerDay: usdToNano(SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY),
  platformPerDay: usdToNano(PLATFORM_HARD_CAP_USD_PER_DAY),
  analyticsRun: usdToNano(ANALYTICS_RUN_BUDGET_USD),
  qualityRun: usdToNano(QUALITY_RUN_BUDGET_USD),
} satisfies Record<string, NanoUsd>;

/**
 * What one Messenger send costs at the provider: nothing.
 *
 * Standard messaging inside the 24-hour window is not billed by Meta, so this is zero and
 * says so out loud rather than by omission. `outbound_messages.unit_cost_nanousd` is
 * nevertheless NOT NULL for a sent row — the `sent_has_a_cost` CHECK — because the column
 * exists for the surfaces that DO cost money per message, and "we did not meter this one"
 * and "this one was free" must not be the same value in the ledger.
 */
export const MESSENGER_SEND_UNIT_COST = usdToNano(0);

/**
 * Boundary gates whose forbidden vocabulary is checked on EVERY outbound reply, whether
 * or not their inbound matcher fired (§6.7).
 *
 * The rest are checked only when the gate fired, because a flat list refuses benign
 * replies and makes the per-gate counters meaningless. These three are the exception
 * because their failure is expensive and can appear in a reply to a question that did
 * not obviously ask for it: a hedged price (Ш2), an invented booking confirmation (Ш3),
 * and a promised discount (Ш6). Ш6 in particular is always-on by design — the dangerous
 * discount answer is confident, so it evades a forbidden list made of hedges, and the
 * draft that buried it inside the abuse check let a polite question route straight past.
 */
export const ALWAYS_ON_GATES = ['Ш2', 'Ш3', 'Ш6'] as const;

/**
 * How long the Reception provider call may run before the AbortController cancels it.
 *
 * A compiled constant, not a `tenants` column, because no tenant needs a different value
 * yet and a nullable column nobody sets is a config surface that only ever confuses. §6.10.4
 * names a per-tenant `upstream_timeout_ms` and the day one is needed this becomes its
 * default — the read site already takes it as a parameter.
 *
 * It is NOT a ceiling: `check-no-ceiling-env` does not apply, and raising it spends
 * nothing extra. It bounds latency, and the reservation's own expiry bounds the money.
 */
export const RECEPTION_UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Which boundary check answers a given canned kind.
 *
 * `disclosure_rules` and `out_of_scope_topics` carry a `response_kind` but no gate
 * column, and the gate is what the outbound guard keys forbidden vocabulary by. Rather
 * than add a column that would duplicate a fact the response kind already determines,
 * the mapping lives here — platform reference data next to the gate list it belongs to.
 *
 * An unmapped kind falls to Ш8 ("not in the knowledge base"), which is the correct
 * default: a refusal we cannot classify is still a refusal, and Ш8's forbidden list is
 * hedging vocabulary, which is safe to apply to any of them.
 */
export const GATE_BY_RESPONSE_KIND: Readonly<Record<string, string>> = {
  refusal_public_channel: 'Ш0',
  refusal_topic:          'Ш1',
  refusal_price_unlisted: 'Ш2',
  booking_line:           'Ш3',
  refusal_staff_schedule: 'Ш4',
  refusal_health:         'Ш5',
  refusal_no_promotion:   'Ш6',
  refusal_off_topic:      'Ш7',
  handoff:                'Ш8',
  assistant_identity:     'Ш9',
};

export const DEFAULT_GATE = 'Ш8';

/**
 * The writing system a locale is written in, for the §6.10.3 script check.
 *
 * Derived from `tenants.default_locale` rather than stored, because it IS derivable and a
 * second column holding the same fact is a second thing that can be wrong. Russian and
 * Mongolian both resolve to Cyrillic, which is exactly right — the check asks "is this
 * reply in the customer's writing system", not "which language is it".
 */
export function scriptForLocale(locale: string): string {
  // ascii-safe: BCP-47 language tags are ASCII by definition.
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? '';
  if (['mn', 'ru', 'uk', 'bg', 'sr', 'kk', 'ky', 'be'].includes(lang)) return 'Cyrillic';
  if (['zh', 'ja', 'ko'].includes(lang)) return 'Han';
  return 'Latin';
}
