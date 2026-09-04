import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbersFrom, renderStablePrefix, renderVolatileTail, type PromptSection } from './render.ts';

const REVIEWED = '2026-09-04T00:00:00Z';

function section(over: Partial<PromptSection> & Pick<PromptSection, 'key' | 'layer' | 'origin'>): PromptSection {
  return { ordinal: 0, body: `body of ${over.key}`, reviewedAt: REVIEWED, ...over };
}

const L0 = section({ key: 'gate_scaffold', layer: 'L0', origin: 'platform', ordinal: 0 });
const L1 = section({ key: 'reception_role', layer: 'L1', origin: 'platform', ordinal: 0 });
const L2 = section({ key: 'boundary_pack', layer: 'L2', origin: 'tenant', ordinal: 0 });
const L3 = section({ key: 'price_list', layer: 'L3', origin: 'tenant', ordinal: 0 });

test('the platform block is rendered FIRST, whatever order the rows arrive in', () => {
  // Ordering the platform block ahead of everything tenant-specific makes it ONE cache
  // entry for the whole platform instead of one per tenant — measured at 64% of the
  // prompt. Worth little at two tenants and a great deal at twenty, and it costs nothing
  // but ordering.
  const r = renderStablePrefix([L3, L2, L1, L0]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.rendered.order, ['gate_scaffold', 'reception_role', 'boundary_pack', 'price_list']);
});

test('the rendered prefix is identical for every permutation of the same rows', () => {
  const a = renderStablePrefix([L0, L1, L2, L3]);
  const b = renderStablePrefix([L3, L1, L0, L2]);
  assert.equal(a.ok && b.ok && a.rendered.contentHash, b.ok && b.rendered.contentHash);
});

test('a changed body changes the content hash — it IS the prompt-cache identity', () => {
  const a = renderStablePrefix([L0, L1, L2, L3]);
  const b = renderStablePrefix([L0, L1, L2, { ...L3, body: 'өөр үнийн жагсаалт' }]);
  assert.notEqual(a.ok && a.rendered.contentHash, b.ok && b.rendered.contentHash);
});

test('THE REVIEW GATE: one unreviewed section refuses the whole compile', () => {
  // A partially provisioned tenant is an operator-visible state, not a silent
  // degradation. The route 503s with canned_response_unreviewed rather than shipping a
  // prompt nobody who reads Mongolian has approved.
  const r = renderStablePrefix([L0, L1, L2, { ...L3, reviewedAt: null }]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.refusal.code, 'canned_response_unreviewed');
  assert.deepEqual(!r.ok && r.refusal.sections, ['price_list']);
});

test('the gate names EVERY unreviewed section, so provisioning is one round trip', () => {
  const r = renderStablePrefix([{ ...L0, reviewedAt: null }, { ...L3, reviewedAt: null }]);
  assert.deepEqual(!r.ok && r.refusal.sections, ['gate_scaffold', 'price_list']);
});

test('A TENANT ROW CANNOT BECOME A PLATFORM RULE', () => {
  // §6.4.1: "a tenant may only tighten, never loosen" is enforced by the renderer, not by
  // trust. There is no template path in which a row's text lands above a platform rule,
  // and no row shape whose value is "delete check N".
  const r = renderStablePrefix([L0, { ...L2, layer: 'L0' }]);
  assert.equal(!r.ok && r.refusal.code, 'layer_violation');
});

test('and a platform block cannot masquerade as tenant data either', () => {
  const r = renderStablePrefix([{ ...L0, layer: 'L3' }]);
  assert.equal(!r.ok && r.refusal.code, 'layer_violation');
});

test('two sections claiming one slot refuse rather than ordering by luck', () => {
  // Otherwise the prefix — and therefore the cache key — changes between deployments for
  // no visible reason, because the database returned the rows in a different order.
  const r = renderStablePrefix([L0, { ...L1, key: 'other_role', layer: 'L1', ordinal: 0 }, { ...L1, ordinal: 0 }]);
  assert.equal(!r.ok && r.refusal.code, 'ambiguous_order');
});

test('an empty section set is a refusal, not an empty prompt', () => {
  assert.equal(renderStablePrefix([]).ok, false);
  assert.equal(renderStablePrefix([{ ...L0, body: '   ' }]).ok === false, true);
});

test('bodies are NFC-normalised on the way in', () => {
  const nfd = renderStablePrefix([{ ...L0, body: 'Ёлка'.normalize('NFD') }]);
  const nfcRendered = renderStablePrefix([{ ...L0, body: 'Ёлка'.normalize('NFC') }]);
  assert.equal(nfd.ok && nfd.rendered.contentHash, nfcRendered.ok && nfcRendered.rendered.contentHash);
});

test('BYTE STABILITY: the renderer takes no message and no clock, so it cannot vary', () => {
  // This is the enforcement of §6.4.2, and it is structural rather than a rule. Selecting
  // gate checks per message would take the cache hit rate to ZERO; so would putting
  // "today is {{date}}" in the prefix. Both are silent — no error, no symptom, and the
  // bill roughly triples. A renderer with no access to either cannot make the mistake.
  const first = renderStablePrefix([L0, L1, L2, L3]);
  const second = renderStablePrefix([L0, L1, L2, L3]);
  assert.equal(first.ok && first.rendered.promptStable, second.ok && second.rendered.promptStable);
  assert.equal(renderStablePrefix.length, 1, 'exactly one parameter: the sections');
});

test('allowed_numbers is every numeral the compiled prompt contains', () => {
  const r = renderStablePrefix([
    { ...L0, body: 'Утас 7741-7777' },
    { ...L3, body: 'Чёлк тайралт 33,000₮ · Угаалт 22,000₮ · 10:00-20:00' },
  ]);
  assert.deepEqual(r.ok && r.rendered.allowedNumbers, ['10:00-20:00', '22,000', '33,000', '7741-7777']);
});

test('allowed_numbers is sorted and de-duplicated, so the snapshot is deterministic', () => {
  assert.deepEqual(allowedNumbersFrom('33,000 22,000 33,000'), ['22,000', '33,000']);
});

test('prompt_chars counts characters, not UTF-16 units', () => {
  const r = renderStablePrefix([{ ...L0, body: '😊😊' }]);
  assert.equal(r.ok && r.rendered.promptChars, 2);
});

test('the volatile tail is a separate string that never reaches the hash', () => {
  // Splitting L4 into its own block is what makes the ancestor's trap structurally
  // unavailable: it concatenates its closure section onto the cached base prompt, so
  // anything date-shaped added there invalidates every entry, silently.
  const tail = renderVolatileTail(['2026-09-04 15:00 (Улаанбаатар)', '', 'нээлттэй']);
  assert.equal(tail, '2026-09-04 15:00 (Улаанбаатар)\nнээлттэй');
  const withRows = renderStablePrefix([L0, L1, L2, L3]);
  assert.equal(withRows.ok && withRows.rendered.promptStable.includes(tail), false);
});
