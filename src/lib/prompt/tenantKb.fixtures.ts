/**
 * The three tenant states worth testing against, as named things.
 *
 * ## Why this is a module and not an object inside one test file
 *
 * D-058 shipped a change that disarmed D-033's guard, and the reason no test caught it is
 * written here rather than in a commit message: **no test described a tenant that has canned
 * lines and nothing else.** Every fixture was either bare (`EMPTY_KB`) or fully provisioned
 * (a knowledge base, staff, hours), and the state in between — the one every tenant is in on
 * its first day — had no name, so nothing asserted anything about it.
 *
 * `DAY_ONE_KB` gives it a name. It is the shape of client #3 the morning after provisioning:
 * the canned lines the gate references by name, and no knowledge whatsoever.
 *
 * Imported by tests only; nothing in the runtime reaches for it. It lives outside
 * `*.test.ts` because `node --test` executes any test file it is imported from, so a shared
 * fixture inside one would re-run that file's suite in every importer's process.
 */
import type { TenantKb } from './tenant.ts';

/** Reviewed canned lines, the minimum a provisioned tenant carries. */
export const CANNED_ROWS: readonly { kind: string; body: string }[] = [
  { kind: 'handoff', body: 'Манай ажилтан тантай холбогдоно.' },
  { kind: 'refusal_health', body: 'Эмнэлгийн зөвлөгөө өгөх боломжгүй.' },
];

/** No rows of any kind. Compiles to the platform gate and nothing else. */
export const EMPTY_KB: TenantKb = {
  currencySymbol: '₮', currencySymbolBefore: false,
  refusalTopics: [], clarify: [], deposits: [], documents: [], canned: [],
  staff: [], services: [], faqs: [], contacts: [], bookingUrl: null, hours: [], branches: [],
};

/**
 * DAY ONE: the canned lines, and nothing else.
 *
 * Every tenant passes through this state, because `reception/load.ts` refuses a tenant with
 * NO canned rows as `not_provisioned` — so the first thing an operator enters is the canned
 * set, and the knowledge base comes later. It is therefore the state a real customer message
 * is most likely to meet during onboarding, and the one D-033 exists for.
 *
 * What must be true here: the data marker is NOT emitted, so `hasTenantData` is false and
 * `handleReception` sends the handoff line instead of letting a salon-flavoured gate invent
 * a business. Assert against this fixture, not against `EMPTY_KB` — `EMPTY_KB` is a state no
 * tenant that can reply is ever in.
 */
export const DAY_ONE_KB: TenantKb = { ...EMPTY_KB, canned: CANNED_ROWS };
