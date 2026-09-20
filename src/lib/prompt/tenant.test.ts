import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { clockTime, formatMoney, hasTenantData, renderTenantSections, SECTION_LABELS, type TenantKb } from './tenant.ts';
import { cannedSectionBody, renderCannedSection } from '../gate/match.ts';
import { CANNED_ROWS, DAY_ONE_KB, EMPTY_KB } from './tenantKb.fixtures.ts';
import { renderStablePrefix, type PromptSection } from './render.ts';
import { extractNumerals, numeralsNotAllowed } from '../mn/extract.ts';

const APPROVED = '2026-09-04T00:00:00Z';

const EMPTY = EMPTY_KB;

/** A Matrix-shaped knowledge base, small enough to read in a failure message. */
const MATRIX: TenantKb = {
  ...EMPTY,
  refusalTopics: [
    { key: 'children_services', question: 'Сүүлийн мессеж хүүхдийн үйлчилгээ, үнийн тухай юу?' },
    { key: 'medical_advice', question: 'Сүүлийн мессеж эмчилгээ, эрүүл мэндийн зөвлөгөөний тухай юу?' },
  ],
  clarify: [{ term: 'тайралт', question: 'Эмэгтэй эсвэл эрэгтэй тайралт уу?' }],
  deposits: ['үс будалт: 20,000₮ урьдчилгаа'],
  documents: [{ title: 'Танилцуулга', body: 'Матрикс эко салон.' }],
  staff: [{ name: 'Сараа', shortName: null, groupName: 'Үсчин', tier: 'ахлах' }],
  services: [
    { name: 'Чёлк тайралт', variants: [{ variantKey: '', priceKind: 'exact', priceMin: '33000.00', priceMax: null, refusalTopic: null }] },
    { name: 'Үс будалт', variants: [{ variantKey: 'эмэгтэй', priceKind: 'range', priceMin: '80000.00', priceMax: '150000.00', refusalTopic: null }] },
    { name: 'Хүүхдийн тайралт', variants: [{ variantKey: '', priceKind: 'none', priceMin: null, priceMax: null, refusalTopic: 'children_services' }] },
  ],
  faqs: [{ question: 'Зогсоол байдаг уу?', answer: 'Барилгын ард байрлана.' }],
  contacts: [{ kind: 'phone', value: '7741-7777' }],
  bookingUrl: 'https://matrix.mn/booking',
};

const bodyOf = (s: PromptSection[], key: string) => s.find((x) => x.key === key)?.body ?? '';

// ---------------------------------------------------------------------------
// The gate addresses these sections BY NAME
// ---------------------------------------------------------------------------

/** Section names the signed blocks reference that are rendered somewhere else. */
const RENDERED_ELSEWHERE: Record<string, string> = {
  'БЭЛЭН ХАРИУЛТ': 'renderCannedSection, per request, in the volatile tail',
  'ХАРИУЛАХЫН ӨМНӨХ ЗААВАЛ ШАЛГАХ ЖАГСААЛТ': "00_gate_preamble's own heading",
  'ХАРИУЛТЫН ХЭВ МАЯГ': "02_style's own heading",
  'ҮГҮЙ': 'a word in Ш8, not a section name',
};

const signedBlocks = () =>
  readdirSync('prompt/platform')
    .filter((f) => f.endsWith('.mn.txt'))
    .map((f) => readFileSync(`prompt/platform/${f}`, 'utf8'))
    .join('\n');

/**
 * Does the gate reference this label?
 *
 * Mongolian is agglutinative and the blocks inflect these: Ш2 writes ҮНИЙН ЖАГСААЛТАД
 * (dative), Ш4 writes багийн жагсаалтаас (ablative, and lower case). So the final word is
 * matched as a PREFIX and the comparison is case-insensitive. `\w` is ASCII-only under
 * the `u` flag and would match nothing here, hence `\p{L}`.
 */
function gateReferences(label: string, blocks: string): boolean {
  const words = label.trim().split(/\s+/u);
  const last = words[words.length - 1] as string;
  const head = words.slice(0, -1).map((w) => `${w}\\s+`).join('');
  return new RegExp(`${head}${last}\\p{L}*`, 'iu').test(blocks);
}

/** The four the signed gate addresses by name. Renaming one silently breaks that check. */
const GATE_ADDRESSED = ['dataMarker', 'refusalTopics', 'priceList', 'staffList'] as const;

test('DONE-TEST: every section the signed gate addresses by name is one this file emits', () => {
  // The gate says «ХОРИОТОЙ СЭДВҮҮД» хэсэгт жагсаасан, ҮНИЙН ЖАГСААЛТАД яг байгаа бол,
  // багийн жагсаалтаас зэрэглэлийг олж. A heading that does not match is a check pointing
  // at nothing: the model looks for the list, does not find it, and improvises — which is
  // exactly what Ш2 and Ш4 exist to stop. This is check-gate-keys.mjs's job, one layer up.
  //
  // Checked in BOTH directions, because the first version of this test only had the
  // second and was vacuous for the case it existed for: renaming `priceList` passed,
  // since Ш2 references it as bare inflected text rather than in «» or between === ===.
  const blocks = signedBlocks();

  // 1. Every gate-addressed label is actually referenced by a signed block.
  for (const key of GATE_ADDRESSED) {
    const label = SECTION_LABELS[key];
    // At least two words, and that is a rule about the LABEL, not about this test.
    // A one-word heading cannot be checked: «ҮНЭ» occurs throughout the gate as ordinary
    // prose, so a reference check would pass on a coincidence and a renamed heading would
    // orphan Ш2 silently. Found by mutating `priceList` to «ҮНЭ» and watching this pass.
    assert.ok(
      label.trim().split(/\s+/u).length >= 2,
      `SECTION_LABELS.${key} = «${label}» is one word: too ambiguous to be addressed by name in a Mongolian prompt`,
    );
    assert.ok(
      gateReferences(label, blocks),
      `no signed block references «${label}» (SECTION_LABELS.${key}) — renaming it orphaned a check`,
    );
  }

  // 2. Every name a block references is emitted here, or documented as rendered elsewhere.
  const referenced = new Set<string>();
  for (const m of blocks.matchAll(/«([А-ЯӨҮЁ][А-ЯӨҮЁ ]{2,})»/gu)) referenced.add(m[1] as string);
  for (const m of blocks.matchAll(/===\s*([А-ЯӨҮЁ][А-ЯӨҮЁ ]+?)\s*===/gu)) referenced.add(m[1] as string);
  assert.ok(referenced.size >= 3, 'the extractor found nothing — it has stopped reading the blocks');

  const emitted = new Set<string>(Object.values(SECTION_LABELS));
  const orphans = [...referenced].filter((r) => !emitted.has(r) && RENDERED_ELSEWHERE[r] === undefined);
  assert.deepEqual(orphans, [], `the gate names sections nothing renders: ${orphans.join(', ')}`);
});

test('DONE-TEST: the data marker is byte-identical to the one 01_data_marker declares', () => {
  // The declaration quotes the marker verbatim. One character apart and the model is told
  // to look for a divider that is not there.
  const declared = readFileSync('prompt/platform/01_data_marker.mn.txt', 'utf8');
  const marker = `=== ${SECTION_LABELS.dataMarker} ===`;
  assert.ok(declared.includes(marker), `01_data_marker does not contain ${marker}`);
  assert.ok(bodyOf(renderTenantSections(MATRIX, APPROVED), 'tenant_data_marker').includes(marker));
});

// ---------------------------------------------------------------------------
// Prices, and the guard that has to agree with them
// ---------------------------------------------------------------------------

// D-075 PART 1, 2026-09-20: the price section carries NO FIGURE. Measured with the real
// compiler, three priced rows used to contribute five tokens to `allowed_numbers`, and
// Matrix's 43 confirmed entries would contribute thirty-eight — while the outbound guard
// checks only that a numeral is ON the list, never that it belongs to the service under
// discussion. A real price against the wrong service is more plausible than an invented one.
//
// The range-fusion concern this test was written for did not retire, it RELOCATED: the only
// place a price becomes text now is `reception/price.ts`, and `price.test.ts` asserts it
// there against the same trap.
test('DONE-TEST: the price list names services and quotes no figure', () => {
  const prices = bodyOf(renderTenantSections(MATRIX, APPROVED), 'price_list');
  assert.deepEqual(extractNumerals(prices).map((n) => n.digits), []);
  // The services are still NAMED — the model must be able to say one exists and spell it
  // correctly; what it cannot do is put a number next to it.
  assert.match(prices, /Үс будалт/);
});

// The inverse of what this file asserted until 2026-09-20. `allowed_numbers` no longer
// widens with the price list, so a reply quoting a price is refused like any other numeral —
// and that is the point: the model never holds the figure, `reception/price.ts` serves it
// from the row, and a served line is not model text and is not guarded.
test('DONE-TEST: a price quoted by the MODEL is refused, because it is no longer approved', () => {
  const sections = renderTenantSections(MATRIX, APPROVED);
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'Ш2.', reviewedAt: APPROVED, origin: 'platform' },
    ...sections,
  ]);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;
  const allowed = rendered.rendered.allowedNumbers;
  assert.deepEqual(numeralsNotAllowed('Үс будалт 80,000₮-150,000₮.', allowed), ['80,000', '150,000']);
  assert.deepEqual(numeralsNotAllowed('Үс будалт 99,000₮.', allowed), ['99,000']);
});

test('DONE-TEST: allowed_numbers stops being empty, and holds exactly the tenant facts', () => {
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'Ш2. БУРУУ ЖИШЭЭ: 20,000₮', reviewedAt: APPROVED, origin: 'platform' },
    ...renderTenantSections(MATRIX, APPROVED),
  ]);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;
  // The deposit and the phone number — the tenant's non-price facts. NOT the prices, which
  // part 1 removed, and NOT the gate's counter-example, which D-024 removed. Both exclusions
  // are the same rule: only a fact the tenant stated may be quoted, and a price is now
  // served from its row rather than permitted to the model.
  assert.deepEqual(rendered.rendered.allowedNumbers, ['20,000', '7741-7777']);
});

// The unreadable-price concern also relocated to `reception/price.ts`, where a value
// `formatMoney` cannot read refuses the whole quote. Here it simply renders as the name,
// which is what every priced row now does — so a malformed row is indistinguishable from a
// good one IN THE PROMPT, and that is safe precisely because neither carries a figure.
test('a price the compiler cannot read still prints no digit', () => {
  const broken: TenantKb = {
    ...EMPTY,
    services: [{ name: 'Х', variants: [{ variantKey: '', priceKind: 'exact', priceMin: 'not-a-number', priceMax: null, refusalTopic: null }] }],
  };
  const body = bodyOf(renderTenantSections(broken, APPROVED), 'price_list');
  assert.ok(!body.includes('0'), body);
  assert.match(body, /- Х$/m);
});

// The two kinds that KEEP their annotation, because neither is a figure and `none` is how
// the prompt says "this exists and its price is withheld, see this refusal".
test('on_inspection and none still annotate, so a refusal is not deleted with the numbers', () => {
  const kb: TenantKb = {
    ...EMPTY,
    services: [{ name: 'Х', variants: [
      { variantKey: 'a', priceKind: 'on_inspection', priceMin: null, priceMax: null, refusalTopic: null },
      { variantKey: 'b', priceKind: 'none', priceMin: null, priceMax: null, refusalTopic: 'children_services' },
    ] }],
  };
  const body = bodyOf(renderTenantSections(kb, APPROVED), 'price_list');
  assert.match(body, /үзлэгээр тодорхойлно/);
  assert.match(body, /children_services/);
});

test('formatMoney drops zero cents, groups thousands, and honours symbol placement', () => {
  assert.equal(formatMoney('33000.00', '₮', false), '33,000₮');
  assert.equal(formatMoney('1234567.00', '₮', false), '1,234,567₮');
  assert.equal(formatMoney('999.50', '₮', false), '999.50₮');
  assert.equal(formatMoney('100.00', '$', true), '$100');
  assert.equal(formatMoney(null, '₮', false), null);
  assert.equal(formatMoney('', '₮', false), null);
  assert.equal(formatMoney('nonsense', '₮', false), null);
});

test('DONE-TEST: the refusal list carries the Mongolian decision question, not just a key', () => {
  // Ш1 asks whether the customer's message «ХОРИОТОЙ СЭДВҮҮД» хэсэгт жагсаасан сэдвийн аль
  // нэгэнд хамаарч байна уу. Until now the list was English snake_case, so the model's own
  // check compared Mongolian customer text against `children_services` — a check whose
  // two sides were not in the same language.
  //
  // The authoritative detection is `gate/match.ts`, which runs on `matcher` stems before
  // the model ever sees the message, so this was defence in depth doing less than it
  // looked. `decision_question` is NOT NULL on both refusal tables and is exactly the
  // Mongolian first-line gate §8 designed it to be; it was simply never read.
  const body = bodyOf(renderTenantSections(MATRIX, APPROVED), 'refusal_topics');
  assert.ok(body.includes('- children_services: Сүүлийн мессеж хүүхдийн үйлчилгээ, үнийн тухай юу?'), body);
  assert.ok(body.includes('- medical_advice: '), body);
});

test('the key is KEPT alongside the question', () => {
  // The key is what an operator greps, what `quality_flags` records and what the price
  // list names when it withholds a price («үнэ мэдээлэхгүй: children_services»). Replacing
  // it with the question would break the one thread that ties those together.
  const sections = renderTenantSections(MATRIX, APPROVED);
  assert.ok(bodyOf(sections, 'refusal_topics').includes('children_services'));
  assert.ok(bodyOf(sections, 'price_list').includes('children_services'));
});

test('a topic with no question still appears, by key alone', () => {
  // `decision_question` is NOT NULL in the schema, so this is the shape of a bad read
  // rather than a bad row. A topic that vanishes from «ХОРИОТОЙ СЭДВҮҮД» is a refusal Ш1
  // stops asking about; one that appears in English reads worse and refuses correctly.
  const kb = { ...MATRIX, refusalTopics: [{ key: 'children_services', question: '' }] };
  const body = bodyOf(renderTenantSections(kb, APPROVED), 'refusal_topics');
  assert.ok(body.includes('- children_services'), body);
  assert.equal(body.includes('- children_services:'), false, 'no dangling colon');
});

test('a withheld price names its refusal topic, so Ш1 and the price list agree', () => {
  // The Ш1 case: «Хүүхдийн тайралт» is IN the list but its price is deliberately withheld.
  // Naming the topic is what connects the row to «ХОРИОТОЙ СЭДВҮҮД».
  const body = bodyOf(renderTenantSections(MATRIX, APPROVED), 'price_list');
  assert.ok(body.includes('Хүүхдийн тайралт: (үнэ мэдээлэхгүй: children_services)'), body);
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('DONE-TEST: a tenant with no rows renders NOTHING, not a marker over emptiness', () => {
  // A marker introducing nothing is worse than no marker: 01_data_marker tells the model
  // everything below it is reference data, and there is nothing below it.
  assert.deepEqual(renderTenantSections(EMPTY, APPROVED), []);
});

test('the marker precedes every tenant section, whichever ones are empty', () => {
  for (const kb of [MATRIX, { ...EMPTY, faqs: MATRIX.faqs }, { ...EMPTY, contacts: MATRIX.contacts }]) {
    const sections = renderTenantSections(kb, APPROVED);
    assert.equal(sections[0]?.key, 'tenant_data_marker');
    const sorted = [...sections].sort((a, b) =>
      a.layer === b.layer ? a.ordinal - b.ordinal : a.layer < b.layer ? -1 : 1);
    assert.equal(sorted[0]?.key, 'tenant_data_marker', 'the marker must sort first too');
  }
});

test('DONE-TEST: every tenant section is origin=tenant and L2/L3, so it cannot outrank the gate', () => {
  // renderStablePrefix refuses a tenant row claiming a platform layer. This is the other
  // half: nothing here may CLAIM one. "A tenant may only tighten, never loosen" is
  // enforced by the renderer, and the renderer can only enforce what it is handed.
  for (const s of renderTenantSections(MATRIX, APPROVED)) {
    assert.equal(s.origin, 'tenant', s.key);
    assert.ok(s.layer === 'L2' || s.layer === 'L3', `${s.key} claims ${s.layer}`);
    assert.equal(s.reviewedAt, APPROVED, s.key);
  }
});

test('empty sections are omitted rather than rendered as an empty heading', () => {
  const sections = renderTenantSections({ ...EMPTY, faqs: MATRIX.faqs }, APPROVED);
  assert.deepEqual(sections.map((s) => s.key), ['tenant_data_marker', 'faqs']);
});

test('the rendered body is NFC, because the schema will reject anything else', () => {
  const kb: TenantKb = { ...EMPTY, documents: [{ title: 'Ёлка'.normalize('NFD'), body: 'Ө'.normalize('NFD') }] };
  for (const s of renderTenantSections(kb, APPROVED)) {
    assert.equal(s.body.normalize('NFC'), s.body, s.key);
  }
});

// ---------------------------------------------------------------------------
// hasTenantData — the predicate that decides whether the model is asked at all
// ---------------------------------------------------------------------------

/** The compiled prefix for a tenant, as `renderStablePrefix` would produce it. */
function prefixFor(kb: TenantKb): string {
  const platform: PromptSection = {
    layer: 'L0', key: '01_data_marker', ordinal: 1, origin: 'platform', reviewedAt: APPROVED,
    // The signed block NAMES the marker inside a sentence. That is the whole reason the
    // test below is about a line and not a substring.
    body: readFileSync('prompt/platform/01_data_marker.mn.txt', 'utf8'),
  };
  const r = renderStablePrefix([platform, ...renderTenantSections(kb, APPROVED)]);
  assert.equal(r.ok, true);
  return r.ok ? r.rendered.promptStable : '';
}

test('DONE-TEST: A GATE-ONLY PREFIX HAS NO TENANT DATA, even though it names the marker', async () => {
  // Measured against the live snapshot that produced the beauty-salon reply (D-033):
  // «ТУХАЙН БАЙГУУЛЛАГЫН МЭДЭЭЛЭЛ» appears ONCE and on NO line of its own. A substring
  // test answers `true` there — for every tenant on the platform, since `01_data_marker`
  // is a platform block — and the check would be a check in name only.
  const prefix = prefixFor(EMPTY);
  assert.equal(prefix.includes(SECTION_LABELS.dataMarker), true, 'the signed block names it');
  assert.equal(hasTenantData(prefix), false);
});

test('one row is enough: the marker becomes a line of its own', () => {
  assert.equal(hasTenantData(prefixFor({ ...EMPTY, faqs: [{ question: 'Зогсоол?', answer: 'Ард нь.' }] })), true);
  assert.equal(hasTenantData(prefixFor(MATRIX)), true);
});

test('THE DERIVATION IS GUARDED: no signed block may put the marker on its own line', () => {
  // `hasTenantData` reads the prefix rather than a stored flag, which is what lets it
  // answer correctly for snapshots compiled before it existed — including the live one
  // that has the defect. The cost of that is a coupling: a platform block that ever wrote
  // the marker as a standalone line would make every tenant look provisioned, silently.
  // This is the tripwire, and it fails the build rather than the customer.
  const lines = readdirSync('prompt/platform')
    .filter((f) => f.endsWith('.mn.txt'))
    .flatMap((f) => readFileSync(`prompt/platform/${f}`, 'utf8').split('\n').map((l) => ({ f, l: l.trim() })));
  const offenders = lines.filter((x) => x.l === `=== ${SECTION_LABELS.dataMarker} ===`).map((x) => x.f);
  assert.deepEqual(offenders, [], 'a platform block emits the tenant data marker as its own line');
});

test('an empty prompt has no tenant data, and neither does whitespace', () => {
  assert.equal(hasTenantData(''), false);
  assert.equal(hasTenantData('   \n\n   '), false);
});

// ---------------------------------------------------------------------------
// The short name is an attribute of the person, not a resolver (0019)
// ---------------------------------------------------------------------------

const staffKb = (staff: TenantKb['staff']): TenantKb => ({ ...EMPTY, staff });
const staffLines = (staff: TenantKb['staff']) =>
  bodyOf(renderTenantSections(staffKb(staff), APPROVED), 'staff_list')
    .split('\n')
    .filter((l) => l.startsWith('- '));

test('a staff member with no short name renders exactly as before', () => {
  // The column is nullable and almost every row will leave it null — Matrix has nine
  // staff and one short form between them. An empty parenthesis after every other name
  // would be scaffolding the model has to interpret, in the section Ш4 reads for tiers.
  assert.deepEqual(staffLines([{ name: 'Сараа', shortName: null, groupName: 'Үсчин', tier: 'ахлах' }]),
    ['- Сараа · Үсчин · ахлах']);
});

test('BOTH SPELLINGS ARE IN THE ROSTER, on one line, for the person who has two', () => {
  // This is the whole point of the column: a customer writing the short form must find a
  // match without the model having to guess, and a customer writing the full name must
  // find the same person. One line per person keeps Ш4's tier lookup unambiguous.
  assert.deepEqual(staffLines([{ name: 'Оюунсүрэн', shortName: 'Оюунаа', groupName: 'Үсчин', tier: 'Мастер' }]),
    ['- Оюунсүрэн (Оюунаа) · Үсчин · Мастер']);
});

test('an empty short name is absence, not a name', () => {
  // PostgREST hands back whatever is in the column, and a text column collects '' from
  // any form that posts a blank field. «Сараа ()» is worse than «Сараа».
  assert.deepEqual(staffLines([{ name: 'Сараа', shortName: '', groupName: null, tier: null }]),
    ['- Сараа']);
});

test('TWO PEOPLE MAY SHARE A SHORT NAME, and the roster shows both in full', () => {
  // 0019 deliberately puts no unique constraint on the column. Under Ш10 a duplicate
  // short form is not an ambiguity the database must prevent — it is one the reply
  // resolves by asking, the same path as a name that matches nothing at all. What this
  // asserts is that the roster still carries the information the ask needs: both full
  // names, visible, rather than one row winning and the other disappearing.
  //
  // Оюунсүрэн is a real case. Matrix has six ACTIVE stylists and five of them have a short
  // name (D-047, 2026-09-07); the roster this comment first cited said one, and was stale.
  // «Оюунаа» is still the one
  // short form among them. THE SECOND ROW IS INVENTED for this test: there is no
  // Оюунгэрэл on that roster, and nothing here should be read as saying there is. It is
  // named because a session mis-transcribed exactly this name once, and a plausible
  // string sitting next to a true one is how this repository has been wrong before.
  assert.deepEqual(staffLines([
    { name: 'Оюунсүрэн', shortName: 'Оюунаа', groupName: null, tier: null },
    { name: 'Оюунгэрэл', shortName: 'Оюунаа', groupName: null, tier: null },
  ]), ['- Оюунсүрэн (Оюунаа)', '- Оюунгэрэл (Оюунаа)']);
});

// ---------------------------------------------------------------------------
// АЖЛЫН ЦАГ — the schedule the rows always held and nothing rendered.
// ---------------------------------------------------------------------------

/** Matrix's real week, as `business_hours` holds it on the project. */
const HOURS: TenantKb['hours'] = [
  { weekday: 0, opens: '11:00:00', closes: '19:00:00', closed: false },
  { weekday: 1, opens: '10:00:00', closes: '20:00:00', closed: false },
  { weekday: 2, opens: '10:00:00', closes: '20:00:00', closed: false },
  { weekday: 3, opens: '10:00:00', closes: '20:00:00', closed: false },
  { weekday: 4, opens: '10:00:00', closes: '20:00:00', closed: false },
  { weekday: 5, opens: '10:00:00', closes: '20:00:00', closed: false },
  { weekday: 6, opens: '10:00:00', closes: '20:00:00', closed: false },
];

// ---------------------------------------------------------------------------
// The canned lines, in the cached prefix (D-058).
// ---------------------------------------------------------------------------



test('DONE-TEST: THE PUBLISH SIDE AND THE REQUEST SIDE RENDER THE SAME BYTES', () => {
  // The section is now written twice — into the prefix at publish, and (for pre-D-058
  // snapshots) into the volatile tail at request. One trailing space between the two and
  // every reply on a republished tenant 503s with `canned_stale`, for no real reason, and
  // the fix would look like "the guard is broken" rather than "the renderers drifted".
  // They call the same function; this is the test that keeps it that way.
  const section = renderTenantSections({ ...EMPTY, canned: CANNED_ROWS }, APPROVED)
    .find((x) => x.key === 'canned_responses');
  assert.equal(section?.body, cannedSectionBody(SECTION_LABELS.canned, CANNED_ROWS));
  const live = renderCannedSection(SECTION_LABELS.canned,
    CANNED_ROWS.map((r) => ({ ...r, reviewedAt: '2026-09-04T00:00:00Z' })), []);
  assert.equal(live.ok && live.body, section?.body);
});

test('the canned section is sorted by kind, whatever order the rows arrive in', () => {
  // The database promises no order, and an L2 that moves between publishes moves the
  // cache key with it — the whole prefix re-paid at the write rate for nothing.
  const forward = renderTenantSections({ ...EMPTY, canned: CANNED_ROWS }, APPROVED);
  const reversed = renderTenantSections({ ...EMPTY, canned: [...CANNED_ROWS].reverse() }, APPROVED);
  assert.equal(bodyOf(forward, 'canned_responses'), bodyOf(reversed, 'canned_responses'));
  assert.equal(bodyOf(forward, 'canned_responses').split('\n')[1]?.startsWith('"handoff"'), true);
});

test('DONE-TEST: THE CANNED SECTION IS THE LAST L2 AND PRECEDES EVERY L3', () => {
  // The position is not cosmetic. Publishing splices this section into a prefix that
  // already exists, so "immediately before the first L3" has to be a property of the
  // compiler rather than an observation about one tenant's current sections. If the
  // ordinal ever moves, a spliced prefix stops matching what a full recompile would
  // produce — and the two would differ only in byte order, which nothing else checks.
  const full = renderTenantSections({
    ...EMPTY,
    canned: CANNED_ROWS,
    refusalTopics: [{ key: 'children_services', question: 'Хүүхэд үү?' }],
    deposits: ['захиалга: 50%'],
    documents: [{ title: 'Танилцуулга', body: 'Бид ажилладаг.' }],
    contacts: [{ kind: 'phone', value: '7741-7777' }],
  } as TenantKb, APPROVED);
  const keys = full.map((s) => s.key);
  const canned = keys.indexOf('canned_responses');
  assert.notEqual(canned, -1);
  for (const [i, s] of full.entries()) {
    if (s.key === 'canned_responses') continue;
    const before = s.layer === 'L2';
    assert.equal(i < canned, before, `${s.key} (${s.layer}) is on the wrong side of the canned section`);
  }
  assert.equal(full[canned + 1]?.layer, 'L3', 'the section after the canned one must be the first L3');
});

test('DONE-TEST: CANNED LINES ALONE DO NOT MAKE A TENANT "PROVISIONED"', () => {
  // D-033's guard is the marker, and moving the canned lines into the prefix nearly killed
  // it. Every tenant has canned responses from the day it is provisioned — the gate blocks
  // name «БЭЛЭН ХАРИУЛТ» in all ten of Ш0..Ш9 — so if they counted as data, the marker
  // would be unconditional and `hasTenantData` would be true for a tenant with no knowledge
  // base at all. Tenant #0 is exactly that tenant, and its next publish would have put it
  // back to answering as a beauty salon.
  const sections = renderTenantSections(DAY_ONE_KB, APPROVED);
  assert.deepEqual(sections.map((s) => s.key), ['canned_responses'], 'the marker must not be emitted');
  const r = renderStablePrefix([...sections]);
  assert.equal(r.ok && hasTenantData(r.rendered.promptStable), false);
});

test('one real row alongside them brings the marker back', () => {
  // The other half: the filter must not make the marker unreachable. A single document is
  // a knowledge base, and the marker is what tells the model the text below it is data.
  const sections = renderTenantSections(
    { ...EMPTY, canned: CANNED_ROWS, documents: [{ title: 'Танилцуулга', body: 'Бид ажилладаг.' }] },
    APPROVED,
  );
  assert.equal(sections[0]?.key, 'tenant_data_marker');
  const r = renderStablePrefix([...sections]);
  assert.equal(r.ok && hasTenantData(r.rendered.promptStable), true);
});

test('a tenant with no canned rows renders no canned section at all', () => {
  // `section()` drops an empty one, and that is why `cannedHashOf` hashes the ROWS rather
  // than the section as it landed: hashing the landed section would give '' at publish and
  // a real hash at request, and every reply would report as stale for ever.
  assert.equal(renderTenantSections(EMPTY, APPROVED).some((x) => x.key === 'canned_responses'), false);
});

const hoursBody = (kb: TenantKb): string | undefined =>
  renderTenantSections(kb, APPROVED).find((s) => s.key === 'business_hours')?.body;

test('the week renders Monday-first, with seconds dropped', () => {
  const body = hoursBody({ ...EMPTY, hours: HOURS });
  assert.equal(body?.split('\n')[0], `=== ${SECTION_LABELS.hours} ===`);
  assert.deepEqual(body?.split('\n').slice(1), [
    '- Даваа: 10:00 - 20:00',
    '- Мягмар: 10:00 - 20:00',
    '- Лхагва: 10:00 - 20:00',
    '- Пүрэв: 10:00 - 20:00',
    '- Баасан: 10:00 - 20:00',
    '- Бямба: 10:00 - 20:00',
    // Sunday is `dow` 0 and prints LAST. Sorting by weekday would put it first.
    '- Ням: 11:00 - 19:00',
  ]);
});

test('DONE-TEST: the hours reach allowed_numbers as TWO numerals, so the guard stops refusing them', () => {
  // This is the whole point of the section. Before it, `business_hours` fed only
  // `volatile.ts`'s open/closed flag, so «Хэдэн цагт ажилладаг вэ?» could not be answered:
  // the facts were absent from the model's context AND the digits were absent from
  // `allowed_numbers`, so a correct guess would have been refused as `outbound_price`.
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'Ш2.', reviewedAt: APPROVED, origin: 'platform' },
    ...renderTenantSections({ ...EMPTY, hours: HOURS }, APPROVED),
  ]);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;
  const allowed = rendered.rendered.allowedNumbers;
  assert.deepEqual(allowed, ['10:00', '11:00', '19:00', '20:00']);

  for (const reply of [
    'Бид Даваа - Бямба гарагт 10:00 - 20:00 цагт ажиллана.',
    'Ням гарагт 11:00 цагаас 19:00 цаг хүртэл.',
    // The model closing the gap must not change the answer.
    'Ажлын цаг: 10:00-20:00.',
  ]) {
    assert.deepEqual(numeralsNotAllowed(reply, allowed), [], reply);
  }

  // And an hour the salon never gave is still refused.
  assert.deepEqual(numeralsNotAllowed('Бид 22:00 цаг хүртэл ажиллана.', allowed), ['22:00']);
});

test('the widening the hours cause is exactly four digit strings, and no more', () => {
  // `allowed_numbers` compares DIGITS-ONLY reductions, so a clock time licenses anything
  // that reduces to the same digits — `10:00` licenses `1,000`. That is a real widening and
  // it is pinned here rather than discovered later: if a future format change adds a fifth
  // reduction, this test names it.
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'Ш2.', reviewedAt: APPROVED, origin: 'platform' },
    ...renderTenantSections({ ...EMPTY, hours: HOURS }, APPROVED),
  ]);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;
  const digits = rendered.rendered.allowedNumbers.map((n) => extractNumerals(n)[0]?.digits);
  assert.deepEqual(digits, ['1000', '1100', '1900', '2000']);

  // What that costs, stated: a four-figure price now passes. Salon prices are five figures,
  // so nothing Matrix charges is licensed — but «1,000₮» is, and that is the trade.
  const allowed = rendered.rendered.allowedNumbers;
  assert.deepEqual(numeralsNotAllowed('Үнэ 1,000₮.', allowed), []);
  assert.deepEqual(numeralsNotAllowed('Үнэ 20,000₮.', allowed), ['20,000']);
});

test('a closed day says so; a day we cannot state is omitted rather than guessed', () => {
  const body = hoursBody({
    ...EMPTY,
    hours: [
      { weekday: 1, opens: '10:00:00', closes: '20:00:00', closed: false },
      // Closed: a fact, and printed.
      { weekday: 2, opens: null, closes: null, closed: true },
      // Neither closed nor timed. `isOpenAt` treats this as "we do not know", and so does
      // this: printing it would have to invent either a time or a closure.
      { weekday: 3, opens: null, closes: null, closed: false },
      // Thursday has no row at all — the same "we do not know", one step earlier.
    ],
  });
  assert.deepEqual(body?.split('\n').slice(1), [
    '- Даваа: 10:00 - 20:00',
    '- Мягмар: амарна',
  ]);
  // «амарна» carries no digits, so a closed day cannot widen the guard.
  assert.deepEqual(extractNumerals('амарна'), []);
});

test('a tenant whose every day is unstatable renders no heading at all', () => {
  // An empty heading invites the model to read "the list is absent" as "the salon is never
  // open" — the same reasoning `section()` already applies to every other list.
  assert.equal(hoursBody({ ...EMPTY, hours: [{ weekday: 1, opens: null, closes: null, closed: false }] }), undefined);
  assert.equal(hoursBody(EMPTY), undefined);
});

test('clockTime drops seconds and refuses anything it cannot read', () => {
  assert.equal(clockTime('10:00:00'), '10:00');
  assert.equal(clockTime('09:30:00+08'), '09:30');
  assert.equal(clockTime(null), null);
  // Not a time. Returning a guess here would put an invented hour in front of a customer.
  assert.equal(clockTime(''), null);
  assert.equal(clockTime('morning'), null);
  assert.equal(clockTime('1:00'), null);
});

test('the hours heading cannot be read as Ш4\'s subject', () => {
  // Ш4 refuses a SPECIFIC EMPLOYEE's «ажлын цаг, ирц, сул цаг». The organisation's own
  // opening hours are a different question with a different answer, and the heading has to
  // say so — otherwise the model has a refusal rule and a fact list whose names overlap,
  // which is how D-042's four-replies-for-one-link was built.
  assert.equal(SECTION_LABELS.hours.startsWith('БАЙГУУЛЛАГЫН'), true, SECTION_LABELS.hours);
  // The same word the data marker uses for the tenant region, so the distinction is the
  // platform's existing vocabulary rather than one invented here.
  assert.equal(SECTION_LABELS.dataMarker.includes('БАЙГУУЛЛАГЫН'), true);
  // And it is not the bare phrase Ш4 owns.
  assert.notEqual(SECTION_LABELS.hours, 'АЖЛЫН ЦАГ');
});

// --- contact labels: the model had nothing but English keys to copy (D-069) ------------

test('DONE-TEST: THE CONTACT SECTION IS LABELLED IN MONGOLIAN, not with column keys', () => {
  // It rendered `- phone: 7741-7777`. The heading was Mongolian and every line beneath it
  // was an English identifier, so the one thing the model could not do was reuse the
  // platform's own word — it had to pick one, and on 2026-09-14 it picked the customer's:
  // «Хаяг, холбоо барих:» over a telephone number.
  const kb = { ...MATRIX, contacts: [
    { kind: 'phone', value: '7741-7777' },
    { kind: 'maps_url', value: 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9' },
  ] };
  const body = bodyOf(renderTenantSections(kb, APPROVED), 'contacts');
  assert.match(body, /- Утас: 7741-7777/);
  assert.match(body, /- Байршлын холбоос: https:\/\/maps\.app\.goo\.gl\//);
  assert.doesNotMatch(body, /phone|maps_url/);
});

test('DONE-TEST: «ХАЯГ» CANNOT APPEAR FOR A TENANT THAT HAS NO ADDRESS', () => {
  // The structural half. An instruction telling the model not to promise an address it
  // does not have is a request until something checks it (D-065); binding the word to the
  // `address` kind means a tenant without that row cannot have it in the prefix at all.
  const noAddress = { ...MATRIX, contacts: [{ kind: 'phone', value: '7741-7777' }] };
  const body = bodyOf(renderTenantSections(noAddress, APPROVED), 'contacts');
  assert.doesNotMatch(body, /Хаяг/);

  const withAddress = { ...MATRIX, contacts: [{ kind: 'address', value: 'Яармаг, 12-р хороо' }] };
  const withBody = bodyOf(renderTenantSections(withAddress, APPROVED), 'contacts');
  assert.match(withBody, /- Хаяг: Яармаг/);
});

test('an unknown contact kind falls back to the key, never disappears', () => {
  // A contact point the tenant entered must not vanish from the prompt because nobody
  // added a translation for it.
  const kb = { ...MATRIX, contacts: [{ kind: 'telegram', value: '@matrix' }] };
  const body = bodyOf(renderTenantSections(kb, APPROVED), 'contacts');
  assert.match(body, /- telegram: @matrix/);
});
