import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cannedSectionBody, kindsReferencedBy, kindsRequiredByRules, matchRules, matcherFires,
  MIN_STEM_CHARS, MODEL_INVISIBLE_KINDS, matcherTerms, parseMatcher, renderCannedSection, type GateRule,
} from './match.ts';
import { IMAGE_REPLY_KIND } from '../inbound/imageReply.ts';

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
  const r = matchRules({ text: 'Хүүхдэд зориулсан үйлчилгээ байна уу?', attachments: [] }, [CHILDREN]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1']);
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services']);
});

test('quote_price=false sets the flag that check 2b reads', () => {
  const r = matchRules({ text: 'Хүүхдийн чёлк тайралт хэд вэ?', attachments: [] }, [CHILDREN, HEALTH]);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, true);
});

test('a topic that DOES allow prices leaves the flag alone', () => {
  const r = matchRules({ text: 'Жирэмсэн үедээ будуулж болох уу?', attachments: [] }, [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш5']);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, false);
});

test('EVERY rule is evaluated — the composition rule forbids stopping at the first', () => {
  // Mongolian customer messages bundle constantly. First-match-wins answers the price and
  // leaves the health question unconstrained.
  const r = matchRules({ text: 'Хүүхдийн үс, жирэмсэн үед аюулгүй юу, үнэ нь хэд вэ?', attachments: [] }, [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1', 'Ш5']);
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services', 'health']);
});

test('a message matching nothing fires nothing, and that is not an error', () => {
  const r = matchRules({ text: 'Хэдэн цагт ажилладаг вэ?', attachments: [] }, [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.firedGates, []);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, false);
});

test('two rules on one gate report that gate once', () => {
  const second: GateRule = { ...CHILDREN, topicKey: 'infant_services', matcher: { mode: 'contains_stem', stems: ['нярай'] } };
  const r = matchRules({ text: 'Хүүхдийн болон нярайн үйлчилгээ', attachments: [] }, [CHILDREN, second]);
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
  const r = matchRules({ text: 'Хүүхдийн үс', attachments: [] }, [CHILDREN]);
  assert.equal(r.ok && r.shortCircuitKind, null);
});

test('an explicitly enabled short-circuit names the canned kind to send', () => {
  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true };
  const r = matchRules({ text: 'Хүүхдийн үс', attachments: [] }, [opted]);
  assert.equal(r.ok && r.shortCircuitKind, 'refusal_topic');
});

// ---------------------------------------------------------------------------
// A malformed matcher REFUSES. It is never skipped.
// ---------------------------------------------------------------------------

test('AN UNPARSEABLE MATCHER FAILS THE WHOLE MATCH', () => {
  // Skipping it would mean the topic the tenant explicitly asked never to be discussed
  // becomes discussable, with nothing anywhere going red.
  const broken: GateRule = { ...CHILDREN, matcher: { mode: 'regex', pattern: '.*' } };
  const r = matchRules({ text: 'юу ч', attachments: [] }, [broken, HEALTH]);
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
  assert.equal(matcherFires({ text: 'Сайн байна уу!', attachments: [] }, spec), true);
  assert.equal(matcherFires({ text: 'Уучлаарай асуумаар байна', attachments: [] }, spec), false);
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

// ---------------------------------------------------------------------------
// Kinds the model never sees. D-082.
// ---------------------------------------------------------------------------

const IMAGE_ROW = {
  kind: 'image_received',
  body: 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.',
  reviewedAt: REVIEWED,
};

test('THE IMAGE LINE IS NOT IN THE PROMPT', () => {
  // On 2026-09-17 at 02:07:23 a customer asked, with no photograph anywhere in the
  // conversation, whether the salon would pick a colour for them. The reply opened
  // «зурган дээр үндэслэн … боломж надад байхгүй байна» — *based on a picture*. The line
  // is served whole by `inbound/imageReply.ts`, which never calls the model, so the only
  // thing its presence in the prefix could ever do is exactly what it did.
  const s = renderCannedSection('X', [...ROWS, IMAGE_ROW], []);
  assert.equal(s.ok, true);
  assert.equal(s.ok && s.body.includes('image_received'), false, 'not by key');
  assert.equal(s.ok && s.body.includes('зураг'), false, 'and not by body');
  assert.equal(s.ok && s.body.includes('"handoff"'), true, 'the others are untouched');
});

test('canned_hash is UNCHANGED by the presence of an image row', () => {
  // The property stated as the publish path sees it: adding the row must not move the
  // prompt-cache key, because the row is not in the prompt.
  assert.equal(
    cannedSectionBody('X', ROWS),
    cannedSectionBody('X', [...ROWS, IMAGE_ROW]),
  );
});

test('an UNREVIEWED image row still refuses the whole section', () => {
  // Filtering is about the prompt, never about the review gate. A row nobody signed off is
  // a provisioning fault whether or not the model is shown it — and `imageReply.ts` would
  // serve those bytes to a customer.
  const s = renderCannedSection('X', [...ROWS, { ...IMAGE_ROW, reviewedAt: null }], []);
  assert.equal(s.ok, false);
  assert.equal(s.ok === false && s.code, 'canned_response_unreviewed');
  assert.deepEqual(s.ok === false && s.kinds, ['image_received']);
});

test('the filter is keyed to the kind imageReply actually serves', () => {
  // Two literals for one fact drift. `check-gate-keys` holds a third copy and verifies it
  // against the source; this holds the runtime end.
  assert.equal(MODEL_INVISIBLE_KINDS.includes(IMAGE_REPLY_KIND), true);
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
  const r = matchRules({ text: 'Хүүхдийн үс', attachments: [] }, [seeded]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1'], 'it fired');
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services']);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, true, 'and it still blocks the price');
  assert.deepEqual(r.ok && r.unconfirmedTopics, ['children_services'], 'and it was counted');
});

test('a rule with no provenance at all counts as unconfirmed, and still fires', () => {
  const unlabelled: GateRule = { ...CHILDREN, provenance: undefined };
  const r = matchRules({ text: 'Хүүхдийн үс', attachments: [] }, [unlabelled]);
  assert.deepEqual(r.ok && r.firedGates, ['Ш1']);
  assert.deepEqual(r.ok && r.unconfirmedTopics, ['children_services']);
});

test('the count is of rules that FIRED, not of rules that exist', () => {
  // Otherwise every reply from a tenant with one seeded row anywhere carries the flag, the
  // flag stops meaning anything, and the signal is lost to noise.
  const seededHealth: GateRule = { ...HEALTH, provenance: 'seeded' };
  const r = matchRules({ text: 'Хүүхдийн үс', attachments: [] }, [CHILDREN, seededHealth]);
  assert.deepEqual(r.ok && r.matchedTopics, ['children_services']);
  assert.deepEqual(r.ok && r.unconfirmedTopics, [], 'the seeded rule did not fire, so it is not counted');
});

test('a confirmed rule that fires is not counted', () => {
  const r = matchRules({ text: 'Хүүхдийн үс', attachments: [] }, [CHILDREN]);
  assert.deepEqual(r.ok && r.unconfirmedTopics, []);
});

test('kindsRequiredByRules collects the kinds a tenant\'s own rules point at', () => {
  const rule = (topicKey: string, responseKind: string): GateRule => ({
    gate: 'Ш1', topicKey, matcher: { mode: 'contains_stem', stems: ['хүүхэд'] },
    quotePrice: false, deterministicShortcircuit: false, responseKind,
    provenance: 'tenant_confirmed',
  });

  // Deduped and sorted, so the required list is stable whatever order the rows arrive in.
  assert.deepEqual(
    kindsRequiredByRules([
      rule('photo_consultation', 'refusal_out_of_scope'),
      rule('children_services', 'refusal_topic'),
      rule('children_prices', 'refusal_topic'),
    ]),
    ['refusal_out_of_scope', 'refusal_topic'],
  );

  // An UNCONFIRMED rule still fires (D-020), so it still needs a sentence to fire into.
  assert.deepEqual(
    kindsRequiredByRules([{ ...rule('x', 'refusal_topic'), provenance: 'inferred' }]),
    ['refusal_topic'],
  );

  // A row with no response_kind cannot require one — that is a malformed row, and turning
  // it into a required kind named '' would refuse every reply with an empty kind list.
  assert.deepEqual(kindsRequiredByRules([rule('x', '')]), []);
  assert.deepEqual(kindsRequiredByRules([]), []);
});

// ---------------------------------------------------------------------------
// Keying on what the message CARRIES. D-083.
// ---------------------------------------------------------------------------

const PHOTO_RULE: GateRule = {
  gate: 'Ш1', topicKey: 'photo_consultation',
  matcher: { mode: 'has_attachment', kinds: ['image'] },
  quotePrice: false, deterministicShortcircuit: false, responseKind: 'refusal_out_of_scope',
  provenance: 'tenant_confirmed',
};

/** What the stem-based rule looked like before, kept to show what it could not see. */
const PHOTO_RULE_BY_WORD: GateRule = {
  ...PHOTO_RULE,
  matcher: { mode: 'contains_stem', stems: ['зураг', 'зурган', 'фото'] },
};

test('has_attachment parses, and refuses an empty kinds list', () => {
  assert.equal(parseMatcher({ mode: 'has_attachment', kinds: ['image'] }).ok, true);
  assert.equal(parseMatcher({ mode: 'has_attachment', kinds: [] }).ok, false);
  assert.equal(parseMatcher({ mode: 'has_attachment', kinds: ['image', ''] }).ok, false);
});

test('an attachment kind is NOT held to MIN_STEM_CHARS', () => {
  // `image` is five characters and would pass anyway, but the rule is the point: these are
  // Meta's identifiers out of the payload, never customer text, so the over-matching that
  // MIN_STEM_CHARS exists to prevent does not apply to them.
  assert.equal(parseMatcher({ mode: 'has_attachment', kinds: ['gif'] }).ok, true);
});

test('THE CAPTION NEED NOT MENTION A PICTURE — that is the whole point', () => {
  // The case that worried the founder most. A photograph captioned «Ийм болгож болох уу?»
  // — *can you do it like this?* — contains no picture word in any script, so the stem
  // rule cannot fire and the model answers about an image it cannot see.
  const subject = { text: 'Ийм болгож болох уу?', attachments: ['image'] };

  const byWord = matchRules(subject, [PHOTO_RULE_BY_WORD]);
  assert.equal(byWord.ok && byWord.matchedTopics.length, 0, 'the stem rule is blind to it');

  const byAttachment = matchRules(subject, [PHOTO_RULE]);
  assert.deepEqual(byAttachment.ok && byAttachment.matchedTopics, ['photo_consultation']);
});

test('«may I send a picture?» fires the WORD rule and not the attachment rule', () => {
  // The over-firing direction, and the reason the word matcher was wrong rather than
  // merely incomplete: the honest answer to this question is *yes, send it*.
  const subject = { text: 'зураг явуулж болох уу?', attachments: [] };
  const byWord = matchRules(subject, [PHOTO_RULE_BY_WORD]);
  const byAttachment = matchRules(subject, [PHOTO_RULE]);
  assert.deepEqual(byWord.ok && byWord.matchedTopics, ['photo_consultation']);
  assert.deepEqual(byAttachment.ok && byAttachment.matchedTopics, []);
});

test('a kind the rule does not name does not fire it', () => {
  assert.equal(matcherFires({ text: '', attachments: ['audio'] }, { mode: 'has_attachment', kinds: ['image'] }), false);
  assert.equal(matcherFires({ text: '', attachments: [] }, { mode: 'has_attachment', kinds: ['image'] }), false);
  assert.equal(matcherFires({ text: '', attachments: ['audio', 'image'] }, { mode: 'has_attachment', kinds: ['image'] }), true);
});

test('a text matcher is unaffected by attachments being present', () => {
  // The modes must not leak into each other: a stem rule answers about the words, whatever
  // came attached.
  assert.equal(matcherFires({ text: 'хүүхдийн үс', attachments: ['image'] }, { mode: 'contains_stem', stems: ['хүүхд'] }), true);
  assert.equal(matcherFires({ text: 'үс засуулна', attachments: ['image'] }, { mode: 'contains_stem', stems: ['хүүхд'] }), false);
});

test('DONE-TEST: comment_public_reply is invisible to the model and does not move canned_hash', () => {
  // The outage this prevents, stated as the test: `worker/comments.ts` posts this row's
  // bytes with no model call, so it is a fact about the platform rather than an
  // instruction — and unfiltered it would enter the cached prefix, move `canned_hash`,
  // and 503 every DM reply with `canned_stale` until a republish (D-058).
  //
  // Asserted as an EQUALITY against the section without the row, not merely as an
  // absence: "the text does not appear" would also pass if the renderer had started
  // dropping something else too.
  const base = [
    { kind: 'handoff', body: 'Түр хүлээнэ үү' },
    { kind: 'booking_line', body: 'Онлайнаар цаг авна уу' },
  ];
  const withComment = [...base, { kind: 'comment_public_reply', body: 'Сайн байна уу! Мессеж бичээрэй.' }];

  assert.equal(MODEL_INVISIBLE_KINDS.includes('comment_public_reply'), true);
  assert.equal(
    cannedSectionBody('БЭЛЭН ХАРИУЛТ', withComment),
    cannedSectionBody('БЭЛЭН ХАРИУЛТ', base),
    'adding the comment line changed the section — canned_hash would move and every reply would 503',
  );
});

test('a kind NOT on the invisible list still reaches the section, so the filter can be wrong in both directions', () => {
  const base = [{ kind: 'handoff', body: 'Түр хүлээнэ үү' }];
  const extra = [...base, { kind: 'refusal_price_unlisted', body: 'Үнийг хэлж чадахгүй' }];
  assert.notEqual(cannedSectionBody('БЭЛЭН ХАРИУЛТ', extra), cannedSectionBody('БЭЛЭН ХАРИУЛТ', base));
});

test('DONE-TEST: THE BLOCKING RULE IS NAMED, NOT JUST COUNTED', () => {
  // 2026-09-21, turn 14. The guard refused a correct, row-backed price and the
  // `quality_flags` row said only "a topic whose rule forbids quoting a price". Finding
  // WHICH of ten rules had done it meant reading `out_of_scope_topics` by hand.
  //
  // The guard knew. It just did not say.
  const r = matchRules({ text: 'Хүүхдийн чёлк тайралт хэд вэ?', attachments: [] }, [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.priceBlockingTopics, ['children_services']);
  assert.equal(r.ok && r.refusedTopicBlocksPrice, true);
});

test('DONE-TEST: the boolean is DERIVED from the list, so the two cannot disagree', () => {
  // Kept as one fact with two readings rather than two fields set on the same line. A
  // boolean that can outlive its reason is how a flag comes to describe a cause that
  // never happened — which is the class of bug this whole file keeps finding.
  for (const text of [
    'Хүүхдийн чёлк тайралт хэд вэ?',   // blocks
    'Жирэмсэн үедээ будуулж болох уу?', // fires, does not block
    'Хэдэн цагт ажилладаг вэ?',         // fires nothing
  ]) {
    const r = matchRules({ text, attachments: [] }, [CHILDREN, HEALTH]);
    assert.equal(r.ok, true);
    assert.equal(
      r.ok && r.refusedTopicBlocksPrice,
      r.ok && r.priceBlockingTopics.length > 0,
      `the flag and the reason disagree for: ${text}`,
    );
  }
});

test('DONE-TEST: a rule with quote_price=true never reaches the blocking list', () => {
  // The whole point of 0037. HEALTH allows prices; a matched HEALTH rule must leave the
  // allow-list intact, or a tenant flipping `quote_price` would change nothing.
  const r = matchRules({ text: 'Жирэмсэн үедээ будуулж болох уу?', attachments: [] }, [CHILDREN, HEALTH]);
  assert.deepEqual(r.ok && r.matchedTopics, ['health'], 'it did fire');
  assert.deepEqual(r.ok && r.priceBlockingTopics, [], 'and it did not block');
});

// ---------------------------------------------------------------------------
// D-122: has_word, ends_with, all_of, not
// ---------------------------------------------------------------------------

const fires = (matcher: unknown, text: string): boolean => {
  const p = parseMatcher(matcher);
  assert.ok(p.ok, JSON.stringify(matcher));
  return p.ok && matcherFires({ text, attachments: [] }, p.spec);
};

test('D-122 has_word: whole words only — short words are safe because they must be a whole word', () => {
  const m = { mode: 'has_word', words: ['ib', 'pm', 'хэд', 'үнэ нь'] };
  assert.equal(fires(m, 'ib'), true);
  assert.equal(fires(m, 'IB ээ'), true, 'folded');
  assert.equal(fires(m, 'Pm!!'), true, 'punctuation is not part of a word');
  assert.equal(fires(m, 'ibiza'), false);
  assert.equal(fires(m, 'хэдийнээ ирсэн'), false, 'not a prefix match');
  assert.equal(fires(m, 'Хэд вэ?'), true);
  assert.equal(fires(m, 'Үнэ нь хэдээр вэ'), true, 'a listed run of words');
  assert.equal(fires(m, 'үнэтэй юу'), false);
  assert.equal(fires({ mode: 'has_word', words: ['?'] }, 'энэ юу вэ?'), true, '? is tested against the text');
  assert.equal(fires({ mode: 'has_word', words: ['?'] }, 'энэ юу вэ？'), true, 'full-width too');
  assert.equal(fires({ mode: 'has_word', words: ['?'] }, 'гоё'), false);
});

test('D-122 ends_with: the LAST word only — a fused question particle', () => {
  const m = { mode: 'ends_with', endings: ['уу', 'үү', 'вэ'] };
  assert.equal(fires(m, 'Зэсэн улаан туяа арилдагуу'), true);
  assert.equal(fires(m, 'Хийдэг үү?'), true);
  assert.equal(fires(m, 'Хийдэг үү 😊'), true, 'emoji are not words');
  assert.equal(fires(m, 'Сайн байна уу гоё'), false, 'only the last word');
  assert.equal(parseMatcher({ mode: 'ends_with', endings: ['у'] }).ok, false, 'one letter ends half the language');
});

test('D-122 all_of / not: a conjunction, and a negation only inside one', () => {
  const q = {
    mode: 'all_of',
    matchers: [
      { mode: 'has_word', words: ['?', 'уу', 'вэ'] },
      { mode: 'contains_stem', stems: ['будаг', 'хими'] },
      { mode: 'not', matcher: { mode: 'has_word', words: ['гоё', 'хөөрхөн'] } },
    ],
  };
  assert.equal(fires(q, 'Энэ ямар будаг вэ?'), true);
  assert.equal(fires(q, 'Ямар гоё будаг вэ'), false, 'praise excluded');
  assert.equal(fires(q, 'Будаг хийлгэсэн'), false, 'not a question');
  assert.equal(parseMatcher({ mode: 'not', matcher: { mode: 'has_word', words: ['гоё'] } }).ok, false, 'bare not');
  assert.equal(parseMatcher({ mode: 'all_of', matchers: [{ mode: 'has_word', words: ['a'] }] }).ok, false, 'one member');
  assert.equal(parseMatcher({ mode: 'all_of', matchers: [
    { mode: 'not', matcher: { mode: 'has_word', words: ['a'] } },
    { mode: 'not', matcher: { mode: 'has_word', words: ['b'] } },
  ] }).ok, false, 'only negatives');
  // Three composite levels are reviewable; a fourth is not.
  let deep: unknown = { mode: 'has_word', words: ['z'] };
  for (let i = 0; i < 3; i += 1) deep = { mode: 'all_of', matchers: [{ mode: 'has_word', words: ['a'] }, deep] };
  assert.equal(parseMatcher(deep).ok, true, 'three levels');
  deep = { mode: 'all_of', matchers: [{ mode: 'has_word', words: ['a'] }, deep] };
  assert.equal(parseMatcher(deep).ok, false, 'nests too deep');
  // A malformed member refuses the whole matcher — never a silently shorter rule.
  assert.equal(parseMatcher({ mode: 'all_of', matchers: [{ mode: 'contains_stem', stems: ['үс'] }, { mode: 'has_word', words: ['a'] }] }).ok, false);
});

test('D-122 matcherTerms walks every mode, so the Latin-spelling review sees nested words', () => {
  const p = parseMatcher({ mode: 'all_of', matchers: [
    { mode: 'has_word', words: ['?', 'uu'] },
    { mode: 'not', matcher: { mode: 'contains_stem', stems: ['goyo'] } },
  ] });
  assert.ok(p.ok);
  assert.deepEqual(p.ok && matcherTerms(p.spec), ['uu', 'goyo']);
});

test('D-122: comment_private_reply is invisible to the model, so its row cannot move canned_hash', () => {
  assert.ok(MODEL_INVISIBLE_KINDS.includes('comment_private_reply'));
  const without = cannedSectionBody('X', [{ kind: 'handoff', body: 'a' }]);
  const withRow = cannedSectionBody('X', [{ kind: 'handoff', body: 'a' }, { kind: 'comment_private_reply', body: 'b' }]);
  assert.equal(withRow, without);
});

test('in_reply reads the reply about to be sent, and never fires where there is none (2026-09-26, s04)', () => {
  const parsed = parseMatcher({ mode: 'in_reply', matcher: { mode: 'has_word', words: ['эхо'] } });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(matcherFires({ text: 'Утсаар ярьдаг AI байгаа юу?', attachments: [] }, parsed.spec), false, 'no reply yet');
  assert.equal(matcherFires({ text: 'Утсаар ярьдаг AI байгаа юу?', attachments: [], reply: 'Эхо — Утасны оператор' }, parsed.spec), true);
  assert.equal(matcherFires({ text: 'эхо', attachments: [], reply: 'Дали' }, parsed.spec), false, 'the customer\'s words are not the reply');
  assert.equal(parseMatcher({ mode: 'in_reply' }).ok, false, 'a member is required');
});
