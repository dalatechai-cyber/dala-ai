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
 *
 * **Correction, measured 2026-09-07:** this used to say the spaces and the symbol were
 * each insufficient alone. That is wrong about the spaces, and the regex says why —
 * `NUMERAL` joins across `-` only when a digit follows it IMMEDIATELY, so
 * «33,000 - 55,000» is already two tokens with no symbol at all. The symbol earns its
 * place because it is how the gate's own examples read and because it survives a model
 * that closes the gap; the SPACES are what actually split the token. That distinction is
 * what lets `АЖЛЫН ЦАГ` below render «10:00 - 20:00» as two numerals with no symbol to
 * hang one on, and getting it wrong in the safe-sounding direction would have meant
 * inventing a separator for a problem that does not exist.
 */
import type { PromptSection } from './render.ts';
import { nfc } from '../mn/text.ts';
import { cannedSectionBody } from '../gate/match.ts';

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
  hours: 'БАЙГУУЛЛАГЫН АЖЛЫН ЦАГ',
  /**
   * The lines the model must reproduce letter for letter. Was a literal in
   * `app/api/workers/reception/route.ts` while the section lived in the volatile tail; it
   * is a compiled section now (D-058) and the heading is part of the cache key, so it
   * belongs with the others rather than at a call site.
   */
  canned: 'БЭЛЭН ХАРИУЛТ',
} as const;

/**
 * Weekday names, and the order the week is printed in.
 *
 * `business_hours.weekday` is 0 = Sunday because that is Postgres `dow`, and `volatile.ts`
 * reads it that way. A Mongolian week starts on Monday, so the ROW numbering and the
 * DISPLAY order are different facts and are written as different things: this array is the
 * display order, and each entry carries the `dow` it selects. Sorting by `weekday` would
 * put Sunday first, which is not wrong so much as not what anyone reads.
 *
 * Fixed, so the order does not depend on a locale or a collation (D-026).
 */
export const WEEKDAYS: readonly { dow: number; label: string }[] = [
  { dow: 1, label: 'Даваа' },
  { dow: 2, label: 'Мягмар' },
  { dow: 3, label: 'Лхагва' },
  { dow: 4, label: 'Пүрэв' },
  { dow: 5, label: 'Баасан' },
  { dow: 6, label: 'Бямба' },
  { dow: 0, label: 'Ням' },
];

/**
 * What each `contact_points.kind` is CALLED, in Mongolian.
 *
 * ## The labels were English keys, and the model translated them itself
 *
 * This section rendered `- phone: 7741-7777` — the column value verbatim. Matrix has one
 * contact point, a phone, and on 2026-09-14 a real customer opened with «Хаяг» (*address*).
 * The model correctly refused to invent a street, and then LABELLED what it did give:
 * «Хаяг, холбоо барих:» and «📍 Байршил, холбогдох утас: 7741-7777». A label promising an
 * address over a telephone number is worse than declining (D-069).
 *
 * It had nothing else to copy. The heading is Mongolian and every line beneath it was an
 * English identifier, so the one thing the model could not do was reuse the platform's own
 * word for the thing — it had to pick one, and it picked the customer's.
 *
 * So «Хаяг» is bound to `address` and to nothing else. A tenant with no address row cannot
 * have that word appear in its prefix at all, which is a structural answer rather than an
 * instruction the model may or may not follow — D-065's lesson, one layer up.
 *
 * ## Approved by the founder, 2026-09-15
 *
 * He is the native speaker and it was his call. Nothing here reached a customer before that:
 * the labels are compiled into the prefix by `scripts/publish/tenant.ts`, which needs a key
 * this repository's sessions do not hold, so the wording sat reviewable in a diff until he
 * had read it. **Changing any value here is changing customer-facing Mongolian** and goes
 * back to him.
 *
 * An unknown kind falls back to the key itself rather than being dropped: a contact point
 * the tenant entered must not vanish from the prompt because nobody added a translation.
 */
export const CONTACT_KIND_LABELS: Readonly<Record<string, string>> = {
  phone: 'Утас',
  email: 'И-мэйл',
  /** The ONLY place this word is used. See above. */
  address: 'Хаяг',
  maps_url: 'Байршлын холбоос',
  facebook: 'Фэйсбүүк',
  instagram: 'Инстаграм',
  website: 'Вэбсайт',
};

/** `tenant_booking.booking_url`, which is rendered into the same section. */
export const BOOKING_LABEL = 'Цаг захиалгын холбоос';

/** What a day with `closed = true` says. No digits, so nothing reaches the guard. */
export const CLOSED_LABEL = 'амарна';

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
  /**
   * `canned_responses` for the tenant's default locale, rendered into the CACHED prefix
   * rather than appended to the volatile tail on every request (D-058).
   *
   * The rows are still read at request time — the deterministic short-circuit answers from
   * them — so the missing/unreviewed guard did not move: nulling `reviewed_at` still stops
   * the sentence on the next reply, not at the next publish.
   */
  canned: readonly { kind: string; body: string }[];
  /**
   * `shortName` is what customers commonly call this person, when that differs from
   * `name`. It is an attribute of the person and NOT a resolver: a name matching neither
   * column is handled by asking (Ш10), which is the case that actually happens — see
   * `0019`'s note on why this is not an alias table.
   */
  staff: readonly {
    name: string;
    shortName: string | null;
    groupName: string | null;
    tier: string | null;
  }[];
  services: readonly { name: string; variants: readonly ServiceVariant[] }[];
  faqs: readonly { question: string; answer: string }[];
  contacts: readonly { kind: string; value: string }[];
  bookingUrl: string | null;
  /**
   * `business_hours`, one row per weekday, exactly as the table holds it.
   *
   * These rows already existed and already fed `volatile.ts`, which renders only «ОДОО:
   * НЭЭЛТТЭЙ / ХААЛТТАЙ» — whether the salon is open at this instant. The SCHEDULE was in
   * front of nobody: a customer asking «Хэдэн цагт ажилладаг вэ?» — which their incumbent
   * answers from its FAQ — got the handoff line, because the facts were not in the model's
   * context at all. Measured on the live project 2026-09-07.
   */
  hours: readonly { weekday: number; opens: string | null; closes: string | null; closed: boolean }[];
};

/** `HH:MM` from a PostgREST `time`, which arrives as `10:00:00`. Null when unusable. */
export function clockTime(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  // ascii-safe: a `time` column serialises as ASCII digits and colons, never user text.
  const m = /^(\d{2}):(\d{2})/.exec(t);
  return m === null ? null : `${m[1]}:${m[2]}`;
}

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

  // The canned lines, in the cached prefix. `cannedSectionBody` renders the whole section
  // including its own heading, and `section()` adds one too — so the body is passed as the
  // lines and the label is stripped back off. Rendering it through the same function the
  // request path uses is what makes the hash comparison meaningful.
  out.push(section('L2', 'canned_responses', 4, SECTION_LABELS.canned,
    cannedSectionBody(SECTION_LABELS.canned, kb.canned).split('\n').slice(1), approvedAt));

  // ---- L3: the knowledge base. Facts. ------------------------------------
  out.push(section('L3', 'kb_documents', 0, SECTION_LABELS.documents,
    kb.documents.map((d) => `${d.title}\n${d.body}`), approvedAt));

  out.push(section('L3', 'staff_list', 1, SECTION_LABELS.staffList,
    kb.staff.map((s) => {
      // The short form goes in parentheses immediately after the name so BOTH spellings
      // are in the roster the model reads, and the roster stays one line per person. It
      // carries no digits, so nothing here reaches `allowed_numbers`.
      const shown = s.shortName === null || s.shortName === '' ? s.name : `${s.name} (${s.shortName})`;
      const parts = [shown];
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

  // The schedule the rows already held and nothing rendered.
  //
  // THE HEADING NAMES THE ORGANISATION ON PURPOSE. Ш4 refuses «тодорхой ажилтны ажлын
  // цаг, ирц, сул цаг» — a SPECIFIC EMPLOYEE's hours, attendance and free slots — and its
  // wrong-example is a person at 14:00. A heading of plain «АЖЛЫН ЦАГ» sits one word away
  // from that check's own subject, and the failure mode is the D-042 shape: two reasonable
  // rules composing into a refusal, so «Хэдэн цагт ажилладаг вэ?» gets the staff-schedule
  // line while the answer is three lines below it. «БАЙГУУЛЛАГЫН» is the same word
  // `01_data_marker` uses for the tenant region, so the distinction reads as the platform's
  // own vocabulary rather than a coinage — and it is vertical-neutral, which «САЛОНЫ»
  // would not have been for tenant #2's garage.
  //
  // Two properties this format is chosen for, both measured rather than assumed:
  //
  //   * «10:00 - 20:00» is TWO numerals, `10:00` and `20:00`, so both reach
  //     `allowed_numbers` and the guard stops refusing the salon's own opening hours as
  //     `outbound_price`. Written «10:00-20:00» it would be ONE numeral whose digits are
  //     `10002000` — a token no reply can ever match, which is the price-range trap in the
  //     module note reappearing with no currency symbol available to break it.
  //   * A day is printed only when this file can state it. `closed = true` says so; a row
  //     with no times is OMITTED rather than guessed at, which is the same "we do not know
  //     is not closed" rule `isOpenAt` already applies per request. A day with no row at
  //     all was never in the list to begin with.
  out.push(section('L3', 'business_hours', 4, SECTION_LABELS.hours,
    WEEKDAYS.flatMap(({ dow, label }) => {
      const row = kb.hours.find((h) => h.weekday === dow);
      if (row === undefined) return [];
      if (row.closed) return [`- ${label}: ${CLOSED_LABEL}`];
      const opens = clockTime(row.opens);
      const closes = clockTime(row.closes);
      if (opens === null || closes === null) return [];
      return [`- ${label}: ${opens} - ${closes}`];
    }), approvedAt));

  out.push(section('L3', 'contacts', 5, SECTION_LABELS.contacts,
    [
      ...kb.contacts.map((c) => `- ${CONTACT_KIND_LABELS[c.kind] ?? c.kind}: ${c.value}`),
      ...(kb.bookingUrl === null ? [] : [`- ${BOOKING_LABEL}: ${kb.bookingUrl}`]),
    ], approvedAt));

  const sections = out.filter((s): s is PromptSection => s !== null);

  /**
   * THE CANNED LINES DO NOT COUNT AS TENANT DATA, and this is load-bearing (D-058).
   *
   * D-033's guard is `hasTenantData`, which reads the marker below: a tenant with no rows
   * of its own gets the gate and nothing else, and `handleReception` takes the handoff line
   * before the provider call rather than letting a salon-flavoured gate invent a business.
   *
   * Moving the canned lines into the prefix nearly disarmed that. Canned responses are
   * REFUSAL BOILERPLATE the gate itself references by name — every one of Ш0 to Ш9 ends
   * "write the such-and-such line from «БЭЛЭН ХАРИУЛТ»" — so every tenant has them from
   * the day it is provisioned, including one with no knowledge base at all. Counting them
   * as data makes the marker unconditional and the guard dead for exactly the tenant it
   * was written for.
   *
   * Measured, not reasoned: tenant #0 today is nine canned rows and nothing else, and its
   * live prefix is the twelve gate blocks with no marker. Without this filter its next
   * publish emits the marker, `hasTenantData` flips true, and it answers as a beauty salon
   * again — D-033 restored by a change about prompt caching, visible only on republish.
   *
   * The section still renders. It is machinery the gate points at, and a tenant that ever
   * does reach the model should have the sentences it is told to reproduce.
   */
  const knowledge = sections.filter((s) => s.key !== 'canned_responses');
  if (knowledge.length === 0) return sections;

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

/**
 * Does this compiled prefix carry any of the tenant's own data?
 *
 * ## Why this question needs asking at all
 *
 * `renderTenantSections` returns `[]` for a tenant with no rows, so the compiled prefix is
 * the platform gate and nothing else — and the gate is written for a tenant that HAS a
 * knowledge base. `00_gate_preamble` rule (4) says «Ямар ч шалгалт бэлэн хариулт
 * шаардаагүй бол доорх мэдлэгийн санд тулгуурлан хэвийн хариул» — answer normally from
 * the knowledge base below — and there is no rule for the case where nothing is below.
 * `01_data_marker` points at a marker that was never emitted, for the same reason.
 *
 * Measured on the first real reply this platform ever sent (D-033): tenant #0, whose
 * `vertical` is `software`, greeted a customer as a beauty salon and offered price
 * information. The word «салон» appears four times in the compiled prefix — in Ш1, Ш3, Ш6
 * and Ш8's own examples — and the tenant's name and vertical appear nowhere, so it was the
 * only business-type noun in the model's context.
 *
 * ## Derived from the prefix, not stored beside it
 *
 * The alternative was a boolean on `config_snapshots` written at compile time. It reads
 * better and answers worse: every snapshot compiled before the column existed would carry
 * `null`, including the live one that has the defect, and neither reading of `null` is
 * acceptable — fail closed silences provisioned tenants, fail open keeps the bug exactly
 * where it already is. Deriving it answers correctly for every snapshot ever compiled,
 * with no republish and no migration.
 *
 * ## The marker as its OWN LINE is the whole test
 *
 * `renderTenantSections` emits `=== ТУХАЙН БАЙГУУЛЛАГЫН МЭДЭЭЛЭЛ ===` as a section of its
 * own, and only when at least one tenant section follows it. `01_data_marker` also names
 * the marker — inside a sentence, mid-line — which is why a substring test would answer
 * `true` for every tenant on the platform. Measured against the live snapshot: one
 * mention, zero standalone lines.
 *
 * That coupling is guarded rather than hoped for: `tenant.test.ts` asserts that no signed
 * platform block contains the marker on a line of its own, so a future block edit breaks
 * the build instead of silently re-enabling the model for tenants with nothing to say.
 */
export function hasTenantData(promptStable: string): boolean {
  const marker = heading(SECTION_LABELS.dataMarker);
  return nfc(promptStable).split('\n').some((line) => line.trim() === marker);
}
