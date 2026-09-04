import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { formatMoney, renderTenantSections, SECTION_LABELS, type TenantKb } from './tenant.ts';
import { renderStablePrefix, type PromptSection } from './render.ts';
import { extractNumerals, numeralsNotAllowed } from '../mn/extract.ts';

const APPROVED = '2026-09-04T00:00:00Z';

const EMPTY: TenantKb = {
  currencySymbol: '₮', currencySymbolBefore: false,
  refusalTopics: [], clarify: [], deposits: [], documents: [],
  staff: [], services: [], faqs: [], contacts: [], bookingUrl: null,
};

/** A Matrix-shaped knowledge base, small enough to read in a failure message. */
const MATRIX: TenantKb = {
  ...EMPTY,
  refusalTopics: ['children_services', 'medical_advice'],
  clarify: [{ term: 'тайралт', question: 'Эмэгтэй эсвэл эрэгтэй тайралт уу?' }],
  deposits: ['үс будалт: 20,000₮ урьдчилгаа'],
  documents: [{ title: 'Танилцуулга', body: 'Матрикс эко салон.' }],
  staff: [{ name: 'Сараа', groupName: 'Үсчин', tier: 'ахлах' }],
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

test('DONE-TEST: no two prices can fuse into one numeral, so a range survives the guard', () => {
  // extractNumerals joins digit runs across `-` and `–` unconditionally, so a range
  // written «80,000–150,000» is ONE numeral whose digits are 80000150000. allowed_numbers
  // would then hold the fused token and refuse a reply quoting either endpoint. The
  // currency symbol after every number breaks the join from both sides. Verified here
  // rather than assumed, because the failure is silent and looks like a model problem.
  const prices = bodyOf(renderTenantSections(MATRIX, APPROVED), 'price_list');
  const tokens = extractNumerals(prices).map((n) => n.digits);
  assert.deepEqual(tokens, ['33000', '80000', '150000']);
  assert.ok(!tokens.some((t) => t.length > 6), `a fused token: ${tokens.join(', ')}`);
});

test('DONE-TEST: a reply quoting a range either way passes the guard', () => {
  const sections = renderTenantSections(MATRIX, APPROVED);
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'Ш2.', reviewedAt: APPROVED, origin: 'platform' },
    ...sections,
  ]);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;
  const allowed = rendered.rendered.allowedNumbers;

  // Split, joined, and reformatted without the comma — all the same number to the guard.
  for (const reply of [
    'Үс будалт 80,000₮-өөс 150,000₮ хооронд.',
    'Үс будалт 80,000₮-150,000₮.',
    'Үс будалт 80000₮ - 150000₮.',
  ]) {
    assert.deepEqual(numeralsNotAllowed(reply, allowed), [], reply);
  }
  // And an invented price is still refused.
  assert.deepEqual(numeralsNotAllowed('Үс будалт 99,000₮.', allowed), ['99,000']);
});

test('DONE-TEST: allowed_numbers stops being empty, and holds exactly the tenant facts', () => {
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'Ш2. БУРУУ ЖИШЭЭ: 20,000₮', reviewedAt: APPROVED, origin: 'platform' },
    ...renderTenantSections(MATRIX, APPROVED),
  ]);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;
  // The prices, the deposit and the phone number. NOT the gate's counter-example (D-024).
  assert.deepEqual(rendered.rendered.allowedNumbers, ['150,000', '20,000', '33,000', '7741-7777', '80,000']);
});

test('a price the compiler cannot read is named, never printed as 0', () => {
  const broken: TenantKb = {
    ...EMPTY,
    services: [{ name: 'Х', variants: [{ variantKey: '', priceKind: 'exact', priceMin: 'not-a-number', priceMax: null, refusalTopic: null }] }],
  };
  const body = bodyOf(renderTenantSections(broken, APPROVED), 'price_list');
  assert.ok(!body.includes('0'), body);
  assert.ok(body.includes('үнэ мэдээлэхгүй'));
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
