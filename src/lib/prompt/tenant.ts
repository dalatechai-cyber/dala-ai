/**
 * L2 + L3 — the tenant's own rows, rendered into fixed labelled sections.
 *
 * This is what gives `01_data_marker` something to point at. Until it existed the
 * compiled prompt was the boundary gate and nothing else: the gate said "everything below
 * the «=== ТУХАЙН БАЙГУУЛЛАГЫН МЭДЭЭЛЭЛ ===» marker is reference data" and there was no
 * marker and no data, and `allowed_numbers` was empty so the outbound guard refused every
 * numeral.
 *
 * Pure, like `render.ts`: rows in, sections out. No database, no clock. The loader is
 * `loadTenantKb`.
 *
 * ## The section labels are load-bearing strings, not decoration
 *
 * The signed gate blocks address these sections **by name**. Ш1 says «ХОРИОТОЙ СЭДВҮҮД»
 * хэсэгт жагсаасан; Ш2 says ҮНИЙН ЖАГСААЛТАД яг байгаа бол; Ш4 says багийн жагсаалтаас.
 * A heading that does not match is a check pointing at nothing — the model looks for the
 * list, does not find it, and improvises. That is the same class of defect
 * `check-gate-keys.mjs` exists to catch one level up, so `tenant.test.ts` asserts every
 * name the signed blocks reference is a heading this file emits.
 *
 * Mongolian is agglutinative, so the blocks reference these in inflected forms
 * (ЖАГСААЛТАД, жагсаалтаас). The nominative base is what a heading carries.
 *
 * ## These labels are mine, and they are gathered here so they can be red-penned
 *
 * They are scaffolding the model reads, not text a customer sees, which the founder ruled
 * sits outside the `prompt/platform` sign-off gate — the same ruling that covers
 * `volatile.ts`'s labels. That is a reason they need no signature, not a reason nobody
 * should read them: every string this file emits is in the two constants below.
 *
 * ## Why the currency symbol goes after EVERY price, without exception
 *
 * Because of how the outbound guard tokenises. `extractNumerals` joins digit runs across
 * `-` and `–` unconditionally, so a range written «33,000–55,000» is **one** numeral
 * whose digits are `3300055000`. `allowed_numbers` then contains that fused token and
 * nothing else — and a reply quoting either endpoint on its own is refused, because
 * neither `33,000` nor `55,000` is in the list. Verified by running it.
 *
 * Putting the symbol immediately after each number breaks the join from both sides:
 * «33,000₮ - 55,000₮» is two tokens, and a model that writes «33,000₮-55,000₮» also
 * produces two. Whichever way the model phrases it, the guard agrees with the list.
 */
import type { PromptSection } from './render.ts';
import { nfc } from '../mn/text.ts';

/**
 * Every section heading this file can emit.
 *
 * The first four are addressed by name from the signed gate blocks and **may not be
 * renamed without re-reading those blocks**. The rest are labels chosen here.
 */
export const SECTION_LABELS = {
  /** Declared verbatim by `01_data_marker`. Opens the tenant region. */
  dataMarker: 'ТУХАЙН БАЙГУУЛЛАГЫН МЭДЭЭЛЭЛ',
  /** Ш1 — «ХОРИОТОЙ СЭДВҮҮД» хэсэгт жагсаасан. */
  refusalTopics: 'ХОРИОТОЙ СЭДВҮҮД',
  /** Ш2 — ҮНИЙН ЖАГСААЛТАД яг байгаа бол. */
  priceList: 'ҮНИЙН ЖАГСААЛТ',
  /** Ш4 — багийн жагсаалтаас зэрэглэлийг олж. */
  staffList: 'БАГИЙН ЖАГСААЛТ',
  clarify: 'ТОДРУУЛАХ АСУУЛТ',
  deposits: 'УРЬДЧИЛГАА ТӨЛБӨР',
  documents: 'ТАНИЛЦУУЛГА',
  faqs: 'ТҮГЭЭМЭЛ АСУУЛТ',
  contacts: 'ХОЛБОО БАРИХ',
} as const;

/** The parenthetical that names a price's KIND. No digits, so none reaches the guard. */
export const PRICE_LABELS = {
  from: 'доод үнэ',
  onInspection: 'үзлэгээр тодорхойлно',
  none: 'үнэ мэдээлэхгүй',
} as const;

export type PriceKind = 'exact' | 'range' | 'from' | 'on_inspection' | 'none';

export type ServiceVariant = {
  variantKey: string;
  priceKind: PriceKind;
  priceMin: string | null;
  priceMax: string | null;
  refusalTopic: string | null;
};

export type TenantKb = {
  currencySymbol: string;
  currencySymbolBefore: boolean;
  /**
   * `disclosure_rules` + `out_of_scope_topics`, already merged by the loader.
   *
   * The `question` is the row's `decision_question` — the Mongolian first-line gate §8
   * designed this column to be, e.g. «Сүүлийн мессеж хүүхдийн үйлчилгээ, үнийн тухай юу?».
   * It is rendered alongside the key rather than instead of it: the key is what an
   * operator greps and what the alert names, and the question is the only half the model
   * can actually match Mongolian customer text against.
   */
  refusalTopics: readonly { key: string; question: string }[];
  clarify: readonly { term: string; question: string }[];
  deposits: readonly string[];
  documents: readonly { title: string; body: string }[];
  staff: readonly { name: string; groupName: string | null; tier: string | null }[];
  services: readonly { name: string; variants: readonly ServiceVariant[] }[];
  faqs: readonly { question: string; answer: string }[];
  contacts: readonly { kind: string; value: string }[];
  bookingUrl: string | null;
};

/**
 * `numeric(12,2)` as PostgREST serialises it — a string like `"33000.00"` — with the
 * trailing cents dropped when they are zero and thousands grouped with commas, which is
 * the form the gate's own examples use («33,000₮»).
 *
 * Returns null rather than guessing when the value is not a number: a price the compiler
 * cannot read must not silently become `0` or `NaN` in a price list.
 */
export function formatMoney(raw: string | null, symbol: string, before: boolean): string | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const whole = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const [intPart, frac] = whole.split('.') as [string, string | undefined];
  // ascii-safe: grouping ASCII digits produced by String(number), never user text.
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = frac === undefined ? grouped : `${grouped}.${frac}`;
  return before ? `${symbol}${amount}` : `${amount}${symbol}`;
}

function priceOf(v: ServiceVariant, kb: TenantKb): string {
  const money = (raw: string | null) => formatMoney(raw, kb.currencySymbol, kb.currencySymbolBefore);
  const min = money(v.priceMin);
  const max = money(v.priceMax);

  if (v.priceKind === 'exact' && min !== null) return min;
  // Spaces around the dash AND the symbol on both numbers. Either alone would leave a
  // join the guard cannot undo — see the module note.
  if (v.priceKind === 'range' && min !== null && max !== null) return `${min} - ${max}`;
  if (v.priceKind === 'from' && min !== null) return `${min} (${PRICE_LABELS.from})`;
  if (v.priceKind === 'on_inspection') return `(${PRICE_LABELS.onInspection})`;
  if (v.priceKind === 'none') {
    return v.refusalTopic === null
      ? `(${PRICE_LABELS.none})`
      : `(${PRICE_LABELS.none}: ${v.refusalTopic})`;
  }
  // A kind whose numbers are missing. The row is malformed; naming it beats printing a
  // price that is not there.
  return `(${PRICE_LABELS.none})`;
}

const heading = (label: string) => `=== ${label} ===`;

/** A section, or null when it has no rows. An empty heading invites the model to treat
 *  "the list is absent" as "the list is empty", and Ш8 already covers absence. */
function section(
  layer: 'L2' | 'L3',
  key: string,
  ordinal: number,
  label: string,
  lines: readonly string[],
  approvedAt: string,
): PromptSection | null {
  const body = lines.filter((l) => l.trim() !== '');
  if (body.length === 0) return null;
  return {
    layer,
    key,
    ordinal,
    body: nfc([heading(label), ...body].join('\n')),
    reviewedAt: approvedAt,
    origin: 'tenant',
  };
}

/**
 * Render one tenant's L2 and L3.
 *
 * `approvedAt` is the REVISION's approval, applied to every section, and that is
 * deliberate: `services` and `faqs` carry no `reviewed_at` of their own because the review
 * unit for tenant data is the revision — a draft somebody publishes — not the row. It is a
 * required parameter rather than a default so the compiler cannot mint an approval it was
 * never given.
 */
export function renderTenantSections(kb: TenantKb, approvedAt: string): PromptSection[] {
  const out: (PromptSection | null)[] = [];

  // ---- L2: the boundary pack. Lists that CONSTRAIN. ----------------------
  // `key: question`, the shape `clarify_axes` below already uses. Ш1 asks whether the
  // message belongs to a topic listed here, and until now the list was English snake_case
  // — so the model's own check compared Mongolian customer text against
  // `children_services`. The authoritative detection is `gate/match.ts`, which runs on
  // `matcher` stems before the model, so this was defence in depth doing less than it
  // looked. A row whose question is missing still renders its key: a topic that appears
  // without its Mongolian is worse read than one that does not appear at all.
  out.push(section('L2', 'refusal_topics', 1, SECTION_LABELS.refusalTopics,
    kb.refusalTopics.map((t) => (t.question === '' ? `- ${t.key}` : `- ${t.key}: ${t.question}`)), approvedAt));

  out.push(section('L2', 'clarify_axes', 2, SECTION_LABELS.clarify,
    kb.clarify.map((c) => `- ${c.term}: ${c.question}`), approvedAt));

  out.push(section('L2', 'deposit_rules', 3, SECTION_LABELS.deposits,
    kb.deposits.map((d) => `- ${d}`), approvedAt));

  // ---- L3: the knowledge base. Facts. ------------------------------------
  out.push(section('L3', 'kb_documents', 0, SECTION_LABELS.documents,
    kb.documents.map((d) => `${d.title}\n${d.body}`), approvedAt));

  out.push(section('L3', 'staff_list', 1, SECTION_LABELS.staffList,
    kb.staff.map((s) => {
      const parts = [s.name];
      if (s.groupName !== null && s.groupName !== '') parts.push(s.groupName);
      if (s.tier !== null && s.tier !== '') parts.push(s.tier);
      return `- ${parts.join(' · ')}`;
    }), approvedAt));

  out.push(section('L3', 'price_list', 2, SECTION_LABELS.priceList,
    kb.services.flatMap((svc) =>
      svc.variants.map((v) => {
        const name = v.variantKey === '' ? svc.name : `${svc.name} (${v.variantKey})`;
        return `- ${name}: ${priceOf(v, kb)}`;
      })), approvedAt));

  out.push(section('L3', 'faqs', 3, SECTION_LABELS.faqs,
    kb.faqs.map((f) => `- ${f.question}\n  ${f.answer}`), approvedAt));

  out.push(section('L3', 'contacts', 4, SECTION_LABELS.contacts,
    [
      ...kb.contacts.map((c) => `- ${c.kind}: ${c.value}`),
      ...(kb.bookingUrl === null ? [] : [`- booking: ${kb.bookingUrl}`]),
    ], approvedAt));

  const sections = out.filter((s): s is PromptSection => s !== null);
  if (sections.length === 0) return [];

  // The marker goes first, and ONLY when there is something behind it.
  //
  // It is its own section so that it precedes every tenant section whichever of them are
  // empty — `01_data_marker`'s declaration is false the moment anything tenant-authored
  // renders above it. And it is omitted entirely for a tenant with no rows, because a
  // marker introducing nothing is a declaration pointing at emptiness: worse than the
  // gate-only prompt it would replace, since the model is told to look below it.
  return [
    {
      layer: 'L2',
      key: 'tenant_data_marker',
      ordinal: 0,
      body: heading(SECTION_LABELS.dataMarker),
      reviewedAt: approvedAt,
      origin: 'tenant',
    },
    ...sections,
  ];
}
