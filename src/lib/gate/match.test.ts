import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindsReferencedBy, matchRules, matcherFires, MIN_STEM_CHARS,
  parseMatcher, renderCannedSection, type GateRule,
} from './match.ts';

const CHILDREN: GateRule = {
  gate: 'Ш1', topicKey: 'children_services',
  matcher: { mode: 'contains_stem', stems: ['хүүхэд', 'хүүхд'] },
  quotePrice: false, deterministicShortcircuit: false, responseKind: 'refusal_topic',
  provenance: 'tenant_confirmed',
};
const HEALTH: GateRule = {
  gate: 'Ш5', topicKey: 'health',
  matcher: { mode: 'contains_stem', stems: ['жирэмс', 'харшил'] },
  quotePrice: true, deterministicShortcircuit: false, responseKind: 'refusal_health',
  provenance: 'tenant_confirmed',
};

// ---------------------------------------------------------------------------
// Matching.
// ---------------------------------------------------------------------------

test('a refusal topic fires on an inflected form, which is the whole point', () => {
  const r = matchRules('Хүүхдэд зориулсан үйлчилгээ байна уу?', [CHILDREN]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1']);
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services']);
});

test('quote_price=false sets the flag that check 2b reads', () => {
  const r = matchRules('Хүүхдийн чёлк тайралт хэд вэ?', [CHILDREN, HEALTH]);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, true);
});

test('a topic that DOES allow prices leaves the flag alone', () => {
  const r = matchRules('Жирэмсэн үедээ будуулж болох уу?', [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш5']);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, false);
});

test('EVERY rule is evaluated — the composition rule forbids stopping at the first', () => {
  // Mongolian customer messages bundle constantly. First-match-wins answers the price and
  // leaves the health question unconstrained.
  const r = matchRules('Хүүхдийн үс, жирэмсэн үед аюулгүй юу, үнэ нь хэд вэ?', [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1', 'Ш5']);
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services', 'health']);
});

test('a message matching nothing fires nothing, and that is not an error', () => {
  const r = matchRules('Хэдэн цагт ажилладаг вэ?', [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.firedGates, []);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, false);
});

test('two rules on one gate report that gate once', () => {
  const second: GateRule = { ...CHILDREN, topicKey: 'infant_services', matcher: { mode: 'contains_stem', stems: ['нярай'] } };
  const r = matchRules('Хүүхдийн болон нярайн үйлчилгээ', [CHILDREN, second]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1']);
  assert.equal(r.ok && r.matchedTopics.length, 2);
});

// ---------------------------------------------------------------------------
// The short-circuit is opt-in, and off by default.
// ---------------------------------------------------------------------------

test('a match does NOT silence the model by default', () => {
  // §10: matchers run inbound only to select which gate text is rendered. A
  // short-circuit that fires wrongly refuses a paying customer with no model in the loop
  // to recover, so it is off per topic per tenant until a precision run says otherwise.
  const r = matchRules('Хүүхдийн үс', [CHILDREN]);
  assert.equal(r.ok && r.shortCircuitKind, null);
});

test('an explicitly enabled short-circuit names the canned kind to send', () => {
  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true };
  const r = matchRules('Хүүхдийн үс', [opted]);
  assert.equal(r.ok && r.shortCircuitKind, 'refusal_topic');
});

// ---------------------------------------------------------------------------
// A malformed matcher REFUSES. It is never skipped.
// ---------------------------------------------------------------------------

test('AN UNPARSEABLE MATCHER FAILS THE WHOLE MATCH', () => {
  // Skipping it would mean the topic the tenant explicitly asked never to be discussed
  // becomes discussable, with nothing anywhere going red.
  const broken: GateRule = { ...CHILDREN, matcher: { mode: 'regex', pattern: '.*' } };
  const r = matchRules('юу ч', [broken, HEALTH]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.detail.includes('children_services'), true, 'the refusal names the rule');
});

test('a stem shorter than the floor is refused, not quietly accepted', () => {
  // `үс` (hair, two characters) also fires on «үсэрсэн» (jumped), «үсрэх», «үснээс».
  const r = parseMatcher({ mode: 'contains_stem', stems: ['үс'] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.detail.includes(String(MIN_STEM_CHARS)), true);
});

test('the stem floor counts CHARACTERS, not UTF-16 units', () => {
  assert.equal(parseMatcher({ mode: 'contains_stem', stems: ['хүүх'] }).ok, true, 'four characters');
  assert.equal(parseMatcher({ mode: 'contains_stem', stems: ['😊😊'] }).ok, false, 'two characters, four units');
});

test('every malformed shape is refused with a reason', () => {
  for (const [raw, why] of [
    [null, 'null'], ['stems', 'a string'], [[], 'an array'],
    [{}, 'no mode'], [{ mode: 'contains_stem' }, 'no stems'],
    [{ mode: 'contains_stem', stems: [] }, 'empty stems'],
    [{ mode: 'contains_stem', stems: [123] }, 'a non-string stem'],
    [{ mode: 'whole_message', phrases: [] }, 'empty phrases'],
  ] as const) {
    assert.equal(parseMatcher(raw).ok, false, why);
  }
});

test('whole_message mode matches the reduced form, not a prefix', () => {
  const spec = { mode: 'whole_message', phrases: ['сайн байна уу'] } as const;
  assert.equal(matcherFires('Сайн байна уу!', spec), true);
  assert.equal(matcherFires('Уучлаарай асуумаар байна', spec), false);
});

// ---------------------------------------------------------------------------
// The «БЭЛЭН ХАРИУЛТ» section.
// ---------------------------------------------------------------------------

const REVIEWED = '2026-09-04T00:00:00Z';
const ROWS = [
  { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: REVIEWED },
  { kind: 'booking_line', body: 'Та манай вэбсайтаар онлайнаар цаг захиалаарай.', reviewedAt: REVIEWED },
];

test('the section is keyed, so the blocks can name a sentence without carrying it', () => {
  const s = renderCannedSection('БЭЛЭН ХАРИУЛТ', ROWS, ['booking_line', 'handoff']);
  assert.equal(s.ok, true);
  assert.equal(s.ok && s.body.startsWith('=== БЭЛЭН ХАРИУЛТ ==='), true);
  assert.equal(s.ok && s.body.includes('"handoff": Уучлаарай'), true);
});

test('rows are ordered by kind, because the database promises no order', () => {
  // An unstable L2 moves the prompt-cache key on every deploy, silently, with no error
  // and a bill that roughly triples.
  const a = renderCannedSection('X', ROWS, []);
  const b = renderCannedSection('X', [...ROWS].reverse(), []);
  assert.equal(a.ok && a.body, b.ok && b.body);
  assert.deepEqual(a.ok && a.kinds, ['booking_line', 'handoff']);
});

test('ONE unreviewed line refuses the whole section', () => {
  // A gate pointing at a missing sentence is a check with no answer, and the customer
  // then gets whatever the model improvises in the gap.
  const s = renderCannedSection('X', [...ROWS, { kind: 'refusal_health', body: 'x', reviewedAt: null }], []);
  assert.equal(s.ok, false);
  assert.equal(!s.ok && s.code, 'canned_response_unreviewed');
  assert.deepEqual(!s.ok && s.kinds, ['refusal_health']);
});

test('every unreviewed kind is named at once, so provisioning is one round trip', () => {
  const s = renderCannedSection('X', [
    { kind: 'handoff', body: 'x', reviewedAt: null },
    { kind: 'booking_line', body: 'y', reviewedAt: null },
  ], []);
  assert.deepEqual(!s.ok && s.kinds, ['booking_line', 'handoff']);
});

test('a kind the prefix names with no row REFUSES — it does not render an empty heading', () => {
  // The bug this replaces: tenant #0 had zero canned_responses, so the section rendered as
  // a bare `=== БЭЛЭН ХАРИУЛТ ===` and all nine gate checks still said "write the X line
  // from that section". Nine instructions pointing into nothing, and the model free to
  // improvise — the exact degradation the function's own comment forbids.
  const s = renderCannedSection('X', [], ['handoff', 'refusal_health']);
  assert.equal(s.ok, false);
  assert.equal(!s.ok && s.code, 'canned_response_missing');
  assert.deepEqual(!s.ok && s.kinds, ['handoff', 'refusal_health']);
});

test('every missing kind is named at once, so provisioning is one round trip', () => {
  const s = renderCannedSection('X', [{ kind: 'handoff', body: 'x', reviewedAt: '2026-09-05' }],
    ['refusal_health', 'booking_line', 'handoff']);
  assert.deepEqual(!s.ok && s.kinds, ['booking_line', 'refusal_health']);
});

test('absence is reported before unreviewed: "provision these" beats "review that one"', () => {
  const s = renderCannedSection('X', [{ kind: 'handoff', body: 'x', reviewedAt: null }],
    ['handoff', 'booking_line']);
  assert.equal(!s.ok && s.code, 'canned_response_missing');
  assert.deepEqual(!s.ok && s.kinds, ['booking_line']);
});

test('a complete, reviewed set still renders', () => {
  const s = renderCannedSection('X', ROWS, ['handoff', 'booking_line']);
  assert.equal(s.ok, true);
  assert.deepEqual(s.ok && s.kinds, ['booking_line', 'handoff']);
});

test('DONE-TEST: the real gate blocks name nine kinds, and an empty tenant refuses all nine', async () => {
  // Reads the signed blocks rather than a fixture, so a block added to L0 that names a new
  // kind changes this expectation instead of silently widening the gap.
  const { readSignedBlocks } = await import('../../../scripts/prompt/generate-seed.ts');
  const bodies = readSignedBlocks().filter((b) => b.layer !== null).map((b) => b.body);
  const kinds = kindsReferencedBy(bodies);
  assert.equal(kinds.length, 9, `expected nine kinds, got ${kinds.join(', ')}`);
  const s = renderCannedSection('БЭЛЭН ХАРИУЛТ', [], kinds);
  assert.equal(!s.ok && s.code, 'canned_response_missing');
  assert.deepEqual(!s.ok && s.kinds, kinds);
});

test('kindsReferencedBy reads the keys out of the rendered blocks', () => {
  const keys = kindsReferencedBy([
    'ЗӨВ ҮЙЛДЭЛ: «БЭЛЭН ХАРИУЛТ» хэсгийн "handoff" мөрийг яг хэвээр нь бич.',
    'ЗӨВ ҮЙЛДЭЛ: "booking_line" мөрийг бич. Дахин: "handoff".',
  ]);
  assert.deepEqual(keys, ['booking_line', 'handoff']);
});

test('Mongolian quotation marks are not mistaken for keys', () => {
  assert.deepEqual(kindsReferencedBy(['«БЭЛЭН ХАРИУЛТ» хэсгээс ол.']), []);
});

// ---------------------------------------------------------------------------
// D-020 — provenance
// ---------------------------------------------------------------------------

test('DONE-TEST: an unconfirmed refusal rule STILL FIRES, and is counted', () => {
  // The direction matters and it is the opposite of the FAQ rule one layer up. A refusal
  // is an instruction not to answer: withholding it because nobody has confirmed the row
  // yet turns a topic the tenant asked never to be discussed into a discussable one, with
  // nothing anywhere going red. That is the same outcome `parseMatcher` refuses to produce
  // when a matcher will not parse.
  const seeded: GateRule = { ...CHILDREN, provenance: 'seeded' };
  const r = matchRules('Хүүхдийн үс', [seeded]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1'], 'it fired');
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services']);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, true, 'and it still blocks the price');
  assert.deepEqual(r.ok && r.unconfirmedTopics, ['children_services'], 'and it was counted');
});

test('a rule with no provenance at all counts as unconfirmed, and still fires', () => {
  const unlabelled: GateRule = { ...CHILDREN, provenance: undefined };
  const r = matchRules('Хүүхдийн үс', [unlabelled]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1']);
  assert.deepEqual(r.ok && r.unconfirmedTopics, ['children_services']);
});

test('the count is of rules that FIRED, not of rules that exist', () => {
  // Otherwise every reply from a tenant with one seeded row anywhere carries the flag, the
  // flag stops meaning anything, and the signal is lost to noise.
  const seededHealth: GateRule = { ...HEALTH, provenance: 'seeded' };
  const r = matchRules('Хүүхдийн үс', [CHILDREN, seededHealth]);
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services']);
  assert.deepEqual(r.ok && r.unconfirmedTopics, [], 'the seeded rule did not fire, so it is not counted');
});

test('a confirmed rule that fires is not counted', () => {
  const r = matchRules('Хүүхдийн үс', [CHILDREN]);
  assert.deepEqual(r.ok && r.unconfirmedTopics, []);
});
