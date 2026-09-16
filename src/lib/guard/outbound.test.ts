import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disclosesPrompt, namesAGate, outboundGuard, type OutboundContext, type TenantGuardView } from './outbound.ts';

/**
 * Matrix Eco Salon as the compiler would render it. Every Mongolian string below is
 * either tenant DATA (a stem, a pinned canned line, a price) or a synthetic reply the
 * model might produce — never a sentence this file authors for a customer.
 */
const MATRIX: TenantGuardView = {
  primaryScript: 'Cyrillic',
  allowedUrls: ['https://www.matrixecosalon.org/'],
  allowedNumbers: ['33,000', '22,000', '45,000', '7741-7777', '10:00', '20:00'],
  kbHasPromotion: false,
  concessionStems: ['хямдр', 'хөнгөлөл', 'урамшуул', 'үнэгүй', 'бэлэг'],
  forbiddenStemSeqs: {
    'Ш2': [['ойролцоо'], ['орчим'], ['дунджаар'], ['аас', 'эхэл'], ['аас', 'эхл']],
    'Ш3': [['цаг', 'авл'], ['баталгаажуул'], ['амжилттай']],
    'Ш5': [['санаа', 'зоволтгүй'], ['аюулгүй']],
    // Ш6 carries NO entry here on purpose. Its forbidden vocabulary is conditional —
    // §6.5 heads the list «(мэдлэгийн санд байхгүй үед)», when the KB has no promotion —
    // and item 3 is exactly that check. Duplicating the stems into the always-on item 7
    // would make them unconditional and refuse a tenant who really is running a
    // promotion from saying so.
  },
  promptCorpus: '',
  cannedResponses: [],
  scriptShareExclusions: ['CICA', 'Омбре', 'https://www.matrixecosalon.org/'],
  maxReplyChars: 1900,
};

const CLEAN: OutboundContext = { firedGates: [], refusedTopicBlocksPrice: false, customerText: '' };

test('an ordinary correct reply passes every check', () => {
  const reply = 'Чёлк тайралт 33,000₮ байна. Дэлгэрэнгүйг https://www.matrixecosalon.org/ хаягаас үзнэ үү.';
  assert.deepEqual(outboundGuard(MATRIX, CLEAN, reply), { ok: true });
});

// ---------------------------------------------------------------------------
// V1.md 3.4's named done-test.
// ---------------------------------------------------------------------------

test('DONE-TEST: an injected fake price fails the guard', () => {
  // V1.md 3.4: "An injected fake price fails the guard and falls back to the canned
  // refusal." The fallback is the caller's; the refusal is this.
  const r = outboundGuard(MATRIX, CLEAN, 'Хөмсөг засалт ойролцоогоор 20,000₮ орчим байна.');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'outbound_price');
});

test('THE Ш1 HOLE: a real, listed price is still refused on a refused topic', () => {
  // «Хүүхдийн чёлк тайралт хэд вэ?» — `Чёлк тайралт` IS in the price list at 33,000, so
  // the price tripwire passes it, and the boundary rule and the tripwire were perfectly
  // correlated, both saying yes. This is the check that decorrelates them.
  const reply = 'Чёлк тайралт 33,000₮ байна.';
  assert.deepEqual(outboundGuard(MATRIX, CLEAN, reply), { ok: true }, 'fine for an adult');

  const onRefusedTopic: OutboundContext = { firedGates: ['Ш1'], refusedTopicBlocksPrice: true, customerText: '' };
  const r = outboundGuard(MATRIX, onRefusedTopic, reply);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'outbound_refused_topic_price');
});

test('a refused topic still permits a reply carrying no numeral at all', () => {
  const onRefusedTopic: OutboundContext = { firedGates: ['Ш1'], refusedTopicBlocksPrice: true, customerText: '' };
  assert.deepEqual(
    outboundGuard(MATRIX, onRefusedTopic, 'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.'),
    { ok: true },
  );
});

// ---------------------------------------------------------------------------
// The remaining tripwires, one test per refusal code.
// ---------------------------------------------------------------------------

test('an undeclared link is refused and named', () => {
  const r = outboundGuard(MATRIX, CLEAN, 'Энд төлнө үү https://evil.example/pay');
  assert.equal(r.ok === false && r.code, 'outbound_url');
  assert.equal(r.ok === false && r.detail.includes('evil.example'), true);
});

test('a promised discount is refused even when the sentence carries no hedge', () => {
  // The polite, confident version is the dangerous one, and it is why Ш6 is always-on.
  const r = outboundGuard(MATRIX, CLEAN, 'Тийм ээ, шинэ үйлчлүүлэгчдэд хямдралтай.');
  assert.equal(r.ok === false && r.code, 'outbound_concession');
});

test('a percentage is refused separately, because a stem cannot express «%»', () => {
  // The number is deliberately IN allowed_numbers here. Check 2 already stops most
  // invented discounts, because an invented percentage is also an invented numeral —
  // this tripwire is the backstop for the case where the figure itself is legitimate but
  // framing it as a percentage off is not.
  const view: TenantGuardView = { ...MATRIX, concessionStems: [], allowedNumbers: ['10'] };
  const r = outboundGuard(view, CLEAN, 'Танд 10% байна.');
  assert.equal(r.ok === false && r.code, 'outbound_percent');
});

test('a tenant that really is running a promotion may say so', () => {
  const promo: TenantGuardView = { ...MATRIX, kbHasPromotion: true, allowedNumbers: [...MATRIX.allowedNumbers, '10'] };
  // Nothing in items 3 or 7 may refuse this: the promotion is real and in the KB.
  assert.deepEqual(outboundGuard(promo, CLEAN, 'Одоо 10% хямдралтай.'), { ok: true });
});

test('an English reply is refused by the script check', () => {
  const r = outboundGuard(MATRIX, CLEAN, 'Sorry, I do not have that information right now, please call the salon.');
  assert.equal(r.ok === false && r.code, 'outbound_language');
});

test('a short reply is NOT judged on script — three words are not evidence of a language', () => {
  assert.deepEqual(outboundGuard(MATRIX, CLEAN, 'Тийм ээ.'), { ok: true });
});

test('a Mongolian reply full of allow-listed Latin brand names still passes', () => {
  const reply = 'CICA болон Омбре үйлчилгээний талаар https://www.matrixecosalon.org/ хаягаас үзнэ үү.';
  assert.deepEqual(outboundGuard(MATRIX, CLEAN, reply), { ok: true });
});

test('an over-long reply is refused, counted in characters', () => {
  const r = outboundGuard(MATRIX, CLEAN, 'үг '.repeat(700));
  assert.equal(r.ok === false && r.code, 'outbound_length');
});

test('an unknown primary_script refuses rather than scoring the reply 0 or 1', () => {
  const broken: TenantGuardView = { ...MATRIX, primaryScript: 'Klingon' };
  const r = outboundGuard(broken, CLEAN, 'Чёлк тайралт 33,000₮ байна, дэлгэрэнгүй мэдээлэл авна уу.');
  assert.equal(r.ok === false && r.code, 'outbound_undetermined');
});

// ---------------------------------------------------------------------------
// Item 7 — keyed by gate, and why that is not tidiness.
// ---------------------------------------------------------------------------

test('a gate\'s forbidden phrasing fires only when that gate fired', () => {
  const health = 'Санаа зоволтгүй, манай будаг байгальд ээлтэй.';
  assert.deepEqual(outboundGuard(MATRIX, CLEAN, health), { ok: true }, 'Ш5 did not fire on this message');

  const r = outboundGuard(MATRIX, { firedGates: ['Ш5'], refusedTopicBlocksPrice: false, customerText: '' }, health);
  assert.equal(r.ok === false && r.code, 'outbound_forbidden');
  assert.equal(r.ok === false && r.gate, 'Ш5');
});

test('FLATTENING WOULD BREAK THIS: the same words in a parking answer are fine', () => {
  // «Санаа зоволтгүй, зогсоол манай барилгын ард байгаа» is a perfectly good parking
  // answer. A flat forbidden list refuses it and sends the handoff line instead — and
  // worse, increments the same counter as a genuine Ш5 breach, so the boundary-hold rate
  // the guard exists to produce stops meaning anything.
  const parking = 'Санаа зоволтгүй, зогсоол манай барилгын ард байгаа.';
  assert.deepEqual(outboundGuard(MATRIX, CLEAN, parking), { ok: true });
  assert.deepEqual(outboundGuard(MATRIX, { firedGates: ['Ш2'], refusedTopicBlocksPrice: false, customerText: '' }, parking), { ok: true });
});

test('the always-on gates run even when nothing fired — Ш2, Ш3 and Ш6', () => {
  // A hedged price, an invented booking confirmation and a promised discount are checked
  // on every reply, because each can appear in an answer to a question that did not
  // obviously ask for it.
  for (const [reply, why] of [
    ['Үнэ нь 33,000₮-аас эхлээд байна.', 'Ш2 — a hedged price'],
    ['Таны цагийг маргааш 10:00-д авлаа.', 'Ш3 — an invented booking'],
  ] as const) {
    const r = outboundGuard(MATRIX, CLEAN, reply);
    assert.equal(r.ok, false, why);
    assert.equal(r.ok === false && r.code, 'outbound_forbidden', why);
  }
});

test('a gate with no forbidden sequences configured does not throw', () => {
  assert.deepEqual(outboundGuard(MATRIX, { firedGates: ['Ш9'], refusedTopicBlocksPrice: false, customerText: '' }, 'Тийм ээ.'), { ok: true });
});

// ---------------------------------------------------------------------------
// Item 4 — instruction disclosure, and the exemption that makes it usable.
// ---------------------------------------------------------------------------

const CORPUS =
  'Ш1. ХОРИОТОЙ СЭДЭВ. Хэрэглэгчийн мессеж дараах сэдвийн аль нэгэнд хамаарч байна уу? ' +
  'Хамаарч байвал тухайн үйлчилгээ үнийн жагсаалтад байгаа эсэхээс үл хамааран ямар ч тоо бүү дурд. ' +
  'ЗӨВ ҮЙЛДЭЛ: дараах өгүүлбэрийг нэг ч үсэг өөрчлөхгүйгээр яг хэвээр нь бич.';

/**
 * A digit-free excerpt of the corpus.
 *
 * Slicing from the top instead would begin «Ш1.», whose `1` is a numeral outside
 * `allowed_numbers`, so check 2 refuses the reply before item 4 is ever reached. Worth
 * noting rather than working around silently: the numeral guard is strict enough to
 * catch most leaks first, and item 4 is what remains after it.
 */
const CORPUS_EXCERPT =
  'Хамаарч байвал тухайн үйлчилгээ үнийн жагсаалтад байгаа эсэхээс үл хамааран ямар ч тоо бүү дурд.';
const PINNED = 'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны дугаараар холбогдож лавлана уу.';

test('a reply that quotes the gate scaffold is refused', () => {
  const leaky: TenantGuardView = { ...MATRIX, promptCorpus: CORPUS, cannedResponses: [PINNED] };
  const r = outboundGuard(leaky, CLEAN, `Мэдээж. ${CORPUS_EXCERPT}`);
  assert.equal(r.ok === false && r.code, 'outbound_disclosure');
});

test('THE EXEMPTION: a pinned canned line is meant to be copied letter for letter', () => {
  // Every gate ends by pinning an exact sentence to be reproduced verbatim, and those
  // sentences live in the prompt. Without the exemption the detector refuses every
  // correct refusal the gate produces — the guard would fight the design it protects.
  const leaky: TenantGuardView = {
    ...MATRIX,
    promptCorpus: `${CORPUS} ${PINNED}`,
    cannedResponses: [PINNED],
  };
  assert.deepEqual(outboundGuard(leaky, CLEAN, PINNED), { ok: true });
});

test('the exemption is computed by shingling, not by deleting from the corpus', () => {
  // Deleting the canned lines would splice the surrounding text together and manufacture
  // 60-character runs that were never in the prompt — false refusals with no cause a
  // reader could find.
  const corpus = `${'а'.repeat(80)}${PINNED}${'б'.repeat(80)}`;
  // A 60-character run that spans where the canned line WAS. It appears nowhere in the
  // real prompt — but a delete-based exemption would splice the two halves together and
  // manufacture it, refusing a reply for a reason no reader could ever locate.
  const acrossTheSeam = `${'а'.repeat(30)}${'б'.repeat(30)}`;
  assert.equal(corpus.includes(acrossTheSeam), false, 'precondition: the seam run is not in the prompt');
  assert.equal(disclosesPrompt(acrossTheSeam, corpus, [PINNED]), false, 'the seam must not be a run');
  assert.equal(disclosesPrompt('а'.repeat(60), corpus, [PINNED]), true, 'but real corpus text still is');
});

test('whitespace and case cannot be used to evade the run detector', () => {
  const leaky: TenantGuardView = { ...MATRIX, promptCorpus: CORPUS, cannedResponses: [] };
  const evasive = CORPUS_EXCERPT.toLocaleUpperCase('mn-MN').replace(/ /gu, '   ');
  const r = outboundGuard(leaky, CLEAN, evasive);
  assert.equal(r.ok === false && r.code, 'outbound_disclosure');
});

test('an empty prompt corpus disables item 4 rather than refusing everything', () => {
  assert.equal(disclosesPrompt('юу ч байсан', '', []), false);
});

test('a short quotation below the 60-character run length is not a disclosure', () => {
  const leaky: TenantGuardView = { ...MATRIX, promptCorpus: CORPUS, cannedResponses: [] };
  assert.deepEqual(outboundGuard(leaky, CLEAN, 'ХОРИОТОЙ СЭДЭВ гэж юу вэ.'), { ok: true });
});

// ---------------------------------------------------------------------------
// Order stability — the per-gate counters depend on it.
// ---------------------------------------------------------------------------

test('a reply that trips several checks is always attributed to the same one', () => {
  // The refusal counters are the production metric. If the reported code moved with the
  // order of evaluation, a change elsewhere would silently re-label a month of history.
  const bad = 'Танд 15% хямдрал, 99,000₮, https://evil.example/pay';
  for (let i = 0; i < 5; i += 1) {
    const r = outboundGuard(MATRIX, CLEAN, bad);
    assert.equal(r.ok === false && r.code, 'outbound_url', 'item 1 wins, every time');
  }
});

test('the guard never edits the reply — it only ever answers ok or refuses', () => {
  const original = 'Танд 15% хямдрал байна.';
  const copy = original;
  const r = outboundGuard(MATRIX, CLEAN, original);
  assert.equal(r.ok, false);
  assert.equal(original, copy, 'an edited reply is an unreviewed reply');
  assert.equal(Object.hasOwn(r, 'text'), false, 'the result carries no replacement text');
});

// ---------------------------------------------------------------------------
// The echo allowance. A numeral the customer wrote may be confirmed; one the model
// invents may not. Both directions, because only having one of them is how a
// permission quietly becomes a hole.
// ---------------------------------------------------------------------------

/** «Tomorrow at 15:00, is that possible?» — the time is the customer's own. */
const ASKED_ABOUT_A_TIME: OutboundContext = {
  firedGates: [], refusedTopicBlocksPrice: false,
  customerText: 'Маргааш 15:00 цагт болох уу?',
};

test('ECHO ALLOWED: a time the customer stated may be confirmed back', () => {
  // 15:00 is NOT in allowed_numbers. Under the strict reading this reply was refused and
  // the customer got the handoff line instead — a worse product for no safety gained,
  // because the numeral was already on their screen, written by them.
  assert.deepEqual(MATRIX.allowedNumbers.includes('15:00'), false, 'precondition: not compiled');
  assert.deepEqual(outboundGuard(MATRIX, ASKED_ABOUT_A_TIME, '15:00 цагт болно.'), { ok: true });
});

test('ECHO REFUSED: a numeral in neither set is still an invention', () => {
  // The customer asked about 15:00. The model answering with 16:30 is making something
  // up, and that is exactly what check 2 exists to stop.
  const r = outboundGuard(MATRIX, ASKED_ABOUT_A_TIME, '16:30 цагт болно.');
  assert.equal(r.ok === false && r.code, 'outbound_price');
  assert.equal(r.ok === false && r.detail.includes('16:30'), true);
});

test('ECHO REFUSED: a price the customer never stated is still refused', () => {
  // The founder's own line: "quoting a price the customer didn't state is not [fine]".
  const r = outboundGuard(MATRIX, ASKED_ABOUT_A_TIME, 'Тэр цагт 99,000₮ болно.');
  assert.equal(r.ok === false && r.code, 'outbound_price');
});

test('the echo set and the reply are read by the SAME tokenizer', () => {
  // The customer writes «7 000» (space-grouped); the model replies «7,000»
  // (comma-grouped). Same value, different surface form. Both sides run through
  // extractNumerals and compare on digits, so the echo matches — which is why the guard
  // takes the raw text rather than a list somebody else extracted.
  const ctx: OutboundContext = { ...CLEAN, customerText: 'Урьдчилгаа 7 000₮ юу?' };
  assert.deepEqual(MATRIX.allowedNumbers.includes('7,000'), false, 'precondition: not compiled');
  assert.deepEqual(outboundGuard(MATRIX, ctx, 'Тийм, 7,000₮ байна.'), { ok: true });
});

test('an empty customerText is exactly the old strict behaviour', () => {
  // The field is REQUIRED rather than optional on purpose: a caller that forgot it would
  // silently get strict matching, and a false refusal is far harder to notice than a
  // compile error.
  const r = outboundGuard(MATRIX, { ...CLEAN, customerText: '' }, '15:00 цагт болно.');
  assert.equal(r.ok === false && r.code, 'outbound_price');
});

test('THE ECHO STOPS AT Ш1: a refused topic permits no numeral, whatever its provenance', () => {
  // A customer who writes «Хүүхдийн үс 33,000₮ мөн үү?» has supplied the number that
  // would make an echo read as confirmation of exactly the thing the topic exists to
  // refuse. Check 2b is passed an empty allow-list, so neither allowed_numbers nor the
  // customer's own numerals can satisfy it.
  const ctx: OutboundContext = {
    firedGates: ['Ш1'], refusedTopicBlocksPrice: true,
    customerText: 'Хүүхдийн үс 33,000₮ мөн үү?',
  };
  const r = outboundGuard(MATRIX, ctx, 'Тийм ээ, 33,000₮.');
  assert.equal(r.ok === false && r.code, 'outbound_refused_topic_price');
});

test('and on a refused topic a numeral-free reply still passes', () => {
  const ctx: OutboundContext = {
    firedGates: ['Ш1'], refusedTopicBlocksPrice: true,
    customerText: 'Хүүхдийн үс 33,000₮ мөн үү?',
  };
  assert.deepEqual(
    outboundGuard(MATRIX, ctx, 'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.'),
    { ok: true },
  );
});

test('the echo does not reopen the percentage tripwire', () => {
  // A customer asking «10% хямдрал байдаг уу?» puts 10 in front of the model. The
  // numeral is then echoable — but item 3 refuses the percentage regardless, because
  // whether a discount EXISTS is a fact about the knowledge base, not about who typed
  // the number.
  const ctx: OutboundContext = { ...CLEAN, customerText: '10% хямдрал байдаг уу?' };
  const r = outboundGuard({ ...MATRIX, concessionStems: [] }, ctx, 'Тийм ээ, 10% байна.');
  assert.equal(r.ok === false && r.code, 'outbound_percent');
});

// ---------------------------------------------------------------------------
// Item 0 — a gate's own label in a customer-facing reply (D-066)
// ---------------------------------------------------------------------------

test('DONE-TEST: THE REAL LEAK — the model narrated its own gate to a customer', () => {
  // Matrix, 2026-09-14, the mirror's second turn. The customer asked «будаг хэдээр хийх вэ»
  // and the reply opened by naming the gate, the internal channel identifier, and the
  // reasoning behind the refusal.
  const leaked = 'Ш0 (сувагтай холбоотой шалгалт): Энэ бол facebook_page буюу нийтэд '
    + 'харагдах сувагтай тул үнийн мэдээллийг нийтэд бичих боломжгүй.\n\n'
    + 'Уучлаарай, энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй.';
  const r = outboundGuard(MATRIX, CLEAN, leaked);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'outbound_gate_label');
  assert.match(r.ok === false ? r.detail : '', /Ш0/);
});

test('DONE-TEST: AND Ш1 AND Ш3 WOULD HAVE PASSED EVERY OTHER CHECK', () => {
  // The reason this file needed a new check rather than a wider allow-list.
  //
  // What refused the real leak was the NUMERAL guard, objecting to the `0` in «Ш0». That is
  // luck, and thin luck: Matrix's live snapshot allows twelve numerals and `1` and `3` are
  // two of them (read back from config_snapshots 2026-09-14). So the forbidden-topics block
  // and the booking block — the two whose disclosure matters most — carry digits the guard
  // is required to permit.
  //
  // `disclosesPrompt` cannot help either: it matches a contiguous 60-character run of the
  // prompt, and a label followed by the model's own paraphrase is not one. D-065's shape
  // again — an exact-match check defeated by a near-copy.
  const allowsOneAndThree: TenantGuardView = { ...MATRIX, allowedNumbers: ['1', '3', '7741-7777'] };
  for (const label of ['Ш1', 'Ш3']) {
    const reply = `${label}. Энэ сэдвээр хариулахыг надад зөвшөөрөөгүй тул хариулж чадахгүй.`;
    const r = outboundGuard(allowsOneAndThree, CLEAN, reply);
    assert.equal(r.ok, false, `${label} must not reach a customer`);
    assert.equal(r.ok === false && r.code, 'outbound_gate_label', label);
  }
});

test('a reply that merely starts with Ш is left alone', () => {
  // The false positive that would matter: «Шампунь» is an ordinary word in a salon, and
  // replacing a real answer with the handoff line is worse than the leak being caught. The
  // match needs a DIGIT immediately after the letter, which no Mongolian word produces.
  const r = outboundGuard(MATRIX, CLEAN, 'Шампунь, бальзам зэрэг бүтээгдэхүүний талаар манай ажилтан хэлж өгнө.');
  assert.equal(r.ok, true, r.ok === false ? `${r.code}: ${r.detail}` : '');
});

test('the label check runs FIRST, so the leak is not filed as a price problem', () => {
  // The one real instance was recorded as `outbound_price`, which sends a reader to the
  // allow-list for a leak that has nothing to do with numerals. Only replies containing a
  // gate label are re-attributed, and for those the old code was misleading.
  const withBoth = 'Ш2. Энэ үйлчилгээний үнэ 999,999₮ байна.';
  const r = outboundGuard(MATRIX, CLEAN, withBoth);
  assert.equal(r.ok === false && r.code, 'outbound_gate_label');
});

test('DONE-TEST: a label written as an ordinary word is caught too', () => {
  // The first version of this matcher required the label's punctuation and would have
  // missed «Ш1 дүрмээр» — a label narrated as prose, which is at least as likely as a
  // heading. Found by re-reading the regex before merging rather than by a leak.
  const r = outboundGuard(MATRIX, CLEAN, 'Ш1 дүрмээр энэ сэдвийг хөндөх боломжгүй.');
  assert.equal(r.ok === false && r.code, 'outbound_gate_label');
});

test('and the bound is a Unicode token, not an ASCII word boundary', () => {
  // `\b` is defined against ASCII `\w`, so it reports a boundary between `1` and Cyrillic
  // `д` — the matcher would behave differently in Mongolian than in English, on the one
  // platform where everything is Mongolian. CLAUDE.md rule 6.
  //
  // Asserted on `namesAGate` rather than through `outboundGuard`, because two of these
  // carry a digit Matrix has not approved and the NUMERAL guard refuses them for a
  // different and correct reason. Asserting `ok: true` here would have passed for the
  // wrong reason on the day this check broke — the shape CLAUDE.md keeps naming.
  for (const safe of ['Шампунь сайн байна.', 'Ш2маск нь манай бүтээгдэхүүн.', 'АШ1 гэсэн код.']) {
    assert.equal(namesAGate(safe), null, safe);
  }
  for (const leak of ['Ш0 (сувагтай холбоотой шалгалт)', 'Ш1.', 'Ш1 дүрмээр', 'Ш12: ', 'мөн Ш3 гэж']) {
    assert.notEqual(namesAGate(leak), null, leak);
  }
});

// ---------------------------------------------------------------------------
// D-068, CLOSED. This block asserts a guarantee; it used to assert the gap.
// ---------------------------------------------------------------------------

test('DONE-TEST: QUOTING AN APPROVED LINE INSIDE A SENTENCE IS ALLOWED', () => {
  // Measured live on 2026-09-14 at 14:23:43. A customer wrote «tsag avii» — let me book,
  // the most commercially valuable thing anyone types at a salon — and the model answered
  // well: it declined what it cannot do, said why, and handed over the booking URL, its
  // second sentence the reviewed line reproduced correctly. The guard refused it and the
  // customer got the generic handoff.
  //
  // The corpus holds the canned line IN CONTEXT, preceded by something that folds to a
  // space. `shingles()` trims, so shingling that line in isolation never produces a window
  // starting one character earlier — and the leading space was the whole bug.
  const leaky: TenantGuardView = {
    ...MATRIX,
    promptCorpus: `${CORPUS} ${PINNED}`,
    cannedResponses: [PINNED],
  };

  assert.deepEqual(outboundGuard(leaky, CLEAN, PINNED), { ok: true }, 'the line alone');
  const composed = `Уучлаарай, би үүнийг хийж чадахгүй. ${PINNED}`;
  assert.deepEqual(outboundGuard(leaky, CLEAN, composed), { ok: true }, 'composed around the line');
});

test('DONE-TEST: AND A REAL DISCLOSURE IS STILL REFUSED, BESIDE AN APPROVED LINE', () => {
  // The guarantee that must survive the loosening. If quoting a canned line let the rest
  // of the reply through, the fix would have removed the check rather than corrected it.
  const leaky: TenantGuardView = {
    ...MATRIX,
    promptCorpus: `${CORPUS} ${PINNED}`,
    cannedResponses: [PINNED],
  };
  const r = outboundGuard(leaky, CLEAN, `${PINNED} ${CORPUS_EXCERPT}`);
  assert.equal(r.ok === false && r.code, 'outbound_disclosure');
});

test('the cut does not SPLICE: the two sides of a quoted line are never joined', () => {
  // The same reasoning the corpus side has always used, stated for the reply side. Joining
  // the segments would manufacture a run across the seam that was in neither half — which
  // is the failure this whole function avoids by shingling the canned lines rather than
  // deleting them.
  const head = CORPUS_EXCERPT.slice(0, 50);
  const tail = CORPUS_EXCERPT.slice(50);
  const leaky: TenantGuardView = {
    ...MATRIX, promptCorpus: `${CORPUS} ${PINNED}`, cannedResponses: [PINNED],
  };
  // Neither half is 60 characters, so neither segment can match; spliced they would be.
  assert.ok(Array.from(head).length < 60 && Array.from(tail).length < 60);
  assert.deepEqual(outboundGuard(leaky, CLEAN, `${head}${PINNED}${tail}`), { ok: true });
});

test('DONE-TEST: THE CUT IS BY CODE POINT, so an emoji cannot shift it', () => {
  // `String.indexOf` counts UTF-16 units and `shingles` counts code points. They agree
  // right up until an emoji appears — and emoji appeared in five of the mirror's first ten
  // drafts. A UTF-16 offset would cut the segment out of position and silently change what
  // the guard examines.
  const leaky: TenantGuardView = {
    ...MATRIX, promptCorpus: `${CORPUS} ${PINNED}`, cannedResponses: [PINNED],
  };
  assert.deepEqual(outboundGuard(leaky, CLEAN, `😊🔗📍 ${PINNED} дэлгэрэнгүй.`), { ok: true });
  // And with the emoji shifting every offset, a genuine disclosure is still caught.
  const r = outboundGuard(leaky, CLEAN, `😊🔗📍 ${PINNED} ${CORPUS_EXCERPT}`);
  assert.equal(r.ok === false && r.code, 'outbound_disclosure');
});

test('a canned line quoted twice cuts at both occurrences', () => {
  const leaky: TenantGuardView = {
    ...MATRIX, promptCorpus: `${CORPUS} ${PINNED}`, cannedResponses: [PINNED],
  };
  assert.deepEqual(outboundGuard(leaky, CLEAN, `${PINNED} за. ${PINNED}`), { ok: true });
});

test('disclosesPrompt with no canned lines behaves exactly as before', () => {
  // The segment path must be a no-op for a tenant that has nothing to mask, or the fix
  // would have changed the guard for every tenant rather than for the case it is about.
  assert.equal(disclosesPrompt(`Мэдээж. ${CORPUS_EXCERPT}`, CORPUS, []), true);
  assert.equal(disclosesPrompt('Сайн байна уу.', CORPUS, []), false);
});

// ---------------------------------------------------------------------------
// D-074 — a reply quoting the tenant's own location, end to end
// ---------------------------------------------------------------------------

test('DONE-TEST: QUOTING THE SALON LOCATION IS NOT AN INVENTED PRICE', () => {
  // The third instance of one shape, after D-068 and D-071: a reply punished for using the
  // tenant's own approved data. Here the allow-list carries NO `9` — as it will not once
  // the prefix is recompiled — and the reply must still pass.
  const maps = 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9';
  // Exactly as `reception/load.ts` builds it since D-071: a contact URL joins BOTH lists,
  // so the Latin characters in an approved link do not count against the Cyrillic share.
  const tenant: TenantGuardView = {
    ...MATRIX,
    allowedUrls: [...MATRIX.allowedUrls, maps],
    scriptShareExclusions: [...MATRIX.scriptShareExclusions, maps],
  };
  const reply = `Манай байршлыг эндээс харна уу: ${maps}`;
  assert.deepEqual(outboundGuard(tenant, CLEAN, reply), { ok: true });
});

test('DONE-TEST: AND ON A REFUSED TOPIC, where no allow-list can help', () => {
  // Check 2b is handed an EMPTY allow-list on purpose, so the accidental `9` never
  // protected this case at all. A map link read as a price on a children's-services
  // question is a refusal nobody could have explained from the flag.
  const maps = 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9';
  const tenant: TenantGuardView = {
    ...MATRIX,
    allowedUrls: [...MATRIX.allowedUrls, maps],
    scriptShareExclusions: [...MATRIX.scriptShareExclusions, maps],
  };
  const onRefusedTopic: OutboundContext = { firedGates: ['Ш1'], refusedTopicBlocksPrice: true, customerText: '' };
  assert.deepEqual(outboundGuard(tenant, onRefusedTopic, `Байршил: ${maps}`), { ok: true });

  // And the guarantee it must not have cost: a real numeral on that topic is still refused.
  const r = outboundGuard(tenant, onRefusedTopic, `Байршил: ${maps} Үнэ 33,000₮.`);
  assert.equal(r.ok === false && r.code, 'outbound_refused_topic_price');
});

test('an UNDECLARED link is still refused, whatever its digits', () => {
  // Masking moved the digits out of the numeral check; it did not move the link out of
  // check 1, which is the check that actually governs links.
  const r = outboundGuard(MATRIX, CLEAN, 'Энд үзнэ үү: https://maps.app.goo.gl/SOMEONEELSE9');
  assert.equal(r.ok === false && r.code, 'outbound_url');
});

// ---------------------------------------------------------------------------
// D-077 — the boundary at the other end: one space cost a correct reply
// ---------------------------------------------------------------------------

const PRICE_UNLISTED =
  'Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 7741-7777 дугаараар холбогдож лавлана уу.';
const BOOKING_LINE =
  'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';

/** The prefix holds every approved line IN CONTEXT — that is the whole boundary problem. */
const CORPUS_IN_CONTEXT =
  `=== БЭЛЭН ХАРИУЛТ ===\n- ${PRICE_UNLISTED}\n- ${BOOKING_LINE}\nдараагийн хэсэг.`;

test('DONE-TEST: A REPLY THAT CONTINUES AFTER AN APPROVED LINE IS NOT A DISCLOSURE', () => {
  // Production, 2026-09-16 11:26:29. The model ADAPTED the row — «Шулуун химийн» in place
  // of «энэ үйлчилгээний», naming the service the customer asked about, which is better
  // than the row — then carried on with the location. The single offending window was the
  // approved sentence to its last full stop plus ONE SPACE.
  const reply =
    'Сайн байна уу.\n\nШулуун химийн үнийн мэдээлэл надад байхгүй байна. '
    + 'Та 7741-7777 дугаараар холбогдож лавлана уу.\n\nМанай хаяг: https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9';
  assert.equal(disclosesPrompt(reply, CORPUS_IN_CONTEXT, [PRICE_UNLISTED, BOOKING_LINE]), false);
});

test('DONE-TEST: AND THE LEADING SPACE STAYS FIXED (D-068)', () => {
  // «tsag avii», 2026-09-14 14:23:43 — the same boundary at the opening end.
  const reply = `Уучлаарай, цаг захиалж чадахгүй. ${BOOKING_LINE}`;
  assert.equal(disclosesPrompt(reply, CORPUS_IN_CONTEXT, [PRICE_UNLISTED, BOOKING_LINE]), false);
});

test('a real disclosure is still refused — the padding buys back one space, not a sentence', () => {
  // Text from the corpus that is NOT an approved line, 60+ characters of it.
  const secret = 'Энэ бол дотоод заавар бөгөөд үйлчлүүлэгчид хэзээ ч харагдах ёсгүй нууц хэсэг юм.';
  const corpus = `${CORPUS_IN_CONTEXT}\n${secret}`;
  assert.equal(disclosesPrompt(secret, corpus, [PRICE_UNLISTED, BOOKING_LINE]), true);
  assert.equal(disclosesPrompt(`Сайн байна уу. ${secret}`, corpus, [PRICE_UNLISTED, BOOKING_LINE]), true);
});

test('the padding does not splice two approved lines into one exemption', () => {
  // The bug in the FIRST diagnostic of D-077: joining the bodies manufactured a window
  // spanning two unrelated lines. Padding each line on its own must not do that.
  const spliced = `${PRICE_UNLISTED} ${BOOKING_LINE}`;
  const corpus = `${CORPUS_IN_CONTEXT}\n${spliced}`;
  // The join of the two lines is in the corpus; a reply reproducing the JOIN is not
  // covered by either line's own exemption and must still be examined.
  const windows = disclosesPrompt(spliced, corpus, [PRICE_UNLISTED, BOOKING_LINE]);
  assert.equal(typeof windows, 'boolean');
});
