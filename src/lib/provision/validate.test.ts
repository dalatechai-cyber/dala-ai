import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIntake, type IntakeDocument } from './intake.ts';
import { assessReadiness, projectedAllowedNumbers, readinessDigestLine, validateIntake } from './validate.ts';
import { topicMatcher } from './matchers.ts';
import { parseMatcher } from '../gate/match.ts';

const MINIMAL: IntakeDocument = {
  slug: 'test-salon',
  business: {
    displayName: 'Test', vertical: 'salon', timezone: 'Asia/Ulaanbaatar',
    locale: 'mn-MN', currencySymbol: '₮', currencySymbolBefore: false,
  },
  confirmedBy: { name: 'the client', at: '2026-09-16' },
  hours: [{ weekday: 1, opens: '10:00', closes: '20:00', closed: false }],
  services: [],
  contacts: [{ kind: 'phone', value: '7741-7777' }],
  booking: { url: null },
  sentences: { handoff: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.' },
  neverSay: [],
  faqs: [],
  staff: [],
  commentRules: [],
};
const svc = (name: string, aliases: string[] = [], min = '10000', max: string | null = null) => ({
  name, category: null, durationMinutes: null, aliases,
  variants: [{
    variantKey: '', priceKind: (max === null ? 'exact' : 'range') as 'exact' | 'range',
    priceMin: min, priceMax: max, refusalTopic: null,
  }],
});
const codes = (d: IntakeDocument) => validateIntake(d).map((f) => f.code);

test('DONE-TEST: «СОР» IS CAUGHT AT INTAKE, NOT BY A CUSTOMER', () => {
  // The whole point. Matrix's «Сор» (120,000–190,000) and «Оффис колор /Сор/»
  // (380,000–460,000) are 3.2× apart and the first name is a subword of the second, so a
  // customer naming only «сор» is unresolvable — and one did, on 2026-09-14 (D-075). The
  // client renames one; no alias and no code can settle it.
  const doc: IntakeDocument = {
    ...MINIMAL,
    services: [svc('Сор', [], '120000', '190000'), svc('Оффис колор /Сор/', [], '380000', '460000')],
  };
  const f = validateIntake(doc).find((x) => x.code === 'service_name_collision');
  assert.ok(f, 'the collision must be reported');
  assert.equal(f.severity, 'ask_client', 'it is the client’s to resolve, never ours');
  assert.match(f.detail, /Сор/);
});

test('DONE-TEST: THE PROJECTED ALLOW-LIST IS SHOWN BEFORE IT IS LIVE', () => {
  // D-055 and D-074 are both "a numeral nobody meant to approve". The failure is not that
  // the list is wrong — it is that nobody looks at it. So it is always reported, never
  // blocks, and is computed with the REAL renderer rather than a second one.
  //
  // A CONFIRMED PRICE IS ON IT AGAIN since D-112, and showing that is the entire job of
  // this preview. Between D-075 and D-112 prices were kept out of the compiled prefix, so
  // this asserted their ABSENCE; the founder reversed that on 2026-09-21 after a live
  // thread in which the bot could not quote prices it held.
  //
  // The property under test never changed and is the one that matters: the projection runs
  // `renderTenantSections`, the REAL renderer, so what the operator reviews before
  // publishing is exactly what the compiler will emit. A second copy of the rule would be
  // free to disagree, and the direction it would disagree in is a permission nobody saw.
  const doc: IntakeDocument = { ...MINIMAL, services: [svc('Угаалт', [], '22000')] };
  const numbers = projectedAllowedNumbers(doc);
  assert.ok(numbers.includes('22,000'),
    `a confirmed price is a permission the operator must see before it is live: ${numbers.join(', ')}`);
  const f = validateIntake(doc).find((x) => x.code === 'allowed_numbers');
  assert.ok(f && f.severity === 'advisory');
});

test('a rule answering with a sentence that does not exist is a blocker', () => {
  // A rule pointing at a missing canned kind is a 503 at the first customer who trips it.
  const doc: IntakeDocument = {
    ...MINIMAL,
    neverSay: [{ key: 'children', question: 'Хүүхдийн үйлчилгээ үү?', responseKind: 'refusal_topic', stems: ['хүүхд', 'huuhd'] }],
  };
  assert.ok(codes(doc).includes('missing_sentence'));
});

test('DONE-TEST: A RULE WITH NO LATIN STEM CANNOT FIRE FOR HALF THE CUSTOMERS', () => {
  // D-067, measured: `containsStem('huuhdiin us zasuulna','хүүхд')` is false, so the
  // children's rule the founder approved by hand never fired for a Latin-script customer —
  // and four of the corpus's first eleven turns were Latin.
  const cyrillicOnly: IntakeDocument = {
    ...MINIMAL,
    sentences: { ...MINIMAL.sentences, refusal_topic: 'Уучлаарай, хүүхдийн мэдээлэл өгөх боломжгүй.' },
    neverSay: [{ key: 'children', question: 'Хүүхдийн үйлчилгээ үү?', responseKind: 'refusal_topic', stems: ['хүүхд'] }],
  };
  const f = validateIntake(cyrillicOnly).find((x) => x.code === 'no_latin_stems');
  assert.ok(f, 'a Cyrillic-only rule must be queried');
  assert.equal(f.severity, 'ask_client', 'only the corpus says which spellings occur');

  // Adding the Latin form clears it — the fix is rows, not code.
  const withLatin: IntakeDocument = {
    ...cyrillicOnly,
    neverSay: [{ ...cyrillicOnly.neverSay[0]!, stems: ['хүүхд', 'huuhd'] }],
  };
  assert.ok(!codes(withLatin).includes('no_latin_stems'));
});

test('DONE-TEST: THE PIPELINE CANNOT CONFIRM THE FACTS FOR THE CLIENT', () => {
  // The price guarantee rests on the tenant having SAID the number.
  const unconfirmed: IntakeDocument = { ...MINIMAL, confirmedBy: null };
  const f = validateIntake(unconfirmed).find((x) => x.code === 'facts_unconfirmed');
  assert.ok(f && f.severity === 'blocker');
});

test('a service priced `none` must be bound to a refusal that exists', () => {
  const doc: IntakeDocument = {
    ...MINIMAL,
    services: [{
      name: 'Хүүхдийн тайралт', category: null, durationMinutes: null, aliases: [],
      variants: [{ variantKey: '', priceKind: 'none', priceMin: null, priceMax: null, refusalTopic: 'children' }],
    }],
  };
  assert.ok(codes(doc).includes('missing_refusal_topic'));
});

test('findings are ordered deterministically', () => {
  const doc: IntakeDocument = { ...MINIMAL, confirmedBy: null, services: [svc('A'), svc('A')] };
  const first = validateIntake(doc);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(validateIntake(doc), first);
  assert.equal(first[0]?.severity, 'blocker', 'blockers first');
});

// --- readiness --------------------------------------------------------------------------

test('DONE-TEST: ABSENCE IS A NAMED STATE, NOT A GAP', () => {
  // Refusing to provision until every field is present would have provisioned nothing —
  // Matrix's chemistry answers were in flight for days. So the tenant sits at the last
  // stage it satisfies and what is missing is said out loud.
  const bare: IntakeDocument = { ...MINIMAL, sentences: {}, services: [], hours: [], contacts: [] };
  const r = assessReadiness(bare);
  assert.equal(r.stage, 'routing');
  assert.ok(r.waitingOn.some((w) => w.includes('handoff')), 'the missing sentence is named');
  assert.ok(r.waitingOn.some((w) => w.includes('services')), 'the missing services are named');
});

test('a complete document reaches ready, and says nothing in the digest', () => {
  const doc: IntakeDocument = { ...MINIMAL, services: [svc('Угаалт', ['ugaalt'])] };
  const r = assessReadiness(doc);
  assert.equal(r.stage, 'ready');
  assert.equal(readinessDigestLine('test-salon', r), null, 'a finished tenant is not news');
});

test('the digest line names what the client owes, and caps its own length', () => {
  const bare: IntakeDocument = { ...MINIMAL, sentences: {}, services: [], hours: [], contacts: [], confirmedBy: null };
  const line = readinessDigestLine('test-salon', assessReadiness(bare));
  assert.ok(line !== null);
  assert.match(line, /^test-salon: routing — waiting on /);
  assert.match(line, /\+\d+ more\)$/, 'a long list is truncated rather than filling the digest');
});

// --- shape ------------------------------------------------------------------------------

test('DONE-TEST: THE READER REFUSES RATHER THAN RETURNING WHAT IT MANAGED', () => {
  // D-057: a validator that answers with the part it parsed reports a tenant as checked
  // when most of it was never examined. And every problem comes back at once, so the
  // operator has one conversation with the client rather than one per round trip.
  const r = readIntake({ slug: 'Bad Slug', business: {}, services: [{ name: '' }] });
  assert.equal(r.ok, false);
  const paths = r.ok === false ? r.problems.map((p) => p.path) : [];
  assert.ok(paths.includes('slug'));
  assert.ok(paths.some((p) => p.startsWith('business.')));
  assert.ok(paths.includes('hours'), 'a missing array is named, not defaulted to empty');
});

test('price shape mirrors the database CHECK constraints', () => {
  const base = { slug: 'x-y', business: MINIMAL.business, confirmedBy: null, hours: [], contacts: [], booking: { url: null }, sentences: {}, neverSay: [], faqs: [], staff: [], commentRules: [] };
  const withVariant = (v: Record<string, unknown>) => readIntake({
    ...base, services: [{ name: 'S', category: null, durationMinutes: null, aliases: [], variants: [v] }],
  });
  assert.equal(withVariant({ priceKind: 'exact', priceMin: '1', priceMax: '2', refusalTopic: null }).ok, false);
  assert.equal(withVariant({ priceKind: 'range', priceMin: '1', priceMax: null, refusalTopic: null }).ok, false);
  assert.equal(withVariant({ priceKind: 'none', priceMin: '1', priceMax: null, refusalTopic: 'x' }).ok, false);
  assert.equal(withVariant({ priceKind: 'exact', priceMin: '33,000', priceMax: null, refusalTopic: null }).ok, false);
  assert.equal(withVariant({ priceKind: 'exact', priceMin: '33000', priceMax: null, refusalTopic: null }).ok, true);
});

test('DONE-TEST: AN OPEN «СОР» COLLISION KEEPS THE TENANT OUT OF READY', () => {
  // The founder's stop condition, stated as a stage rather than as a warning nobody reads:
  // the collision must be settled BEFORE a customer can hit it. Everything else about this
  // document is complete, so `ready` is what it would otherwise reach.
  const doc: IntakeDocument = {
    ...MINIMAL,
    services: [svc('Сор', [], '120000', '190000'), svc('Оффис колор /Сор/', [], '380000', '460000')],
  };
  const r = assessReadiness(doc);
  assert.equal(r.stage, 'knowledge', 'an ambiguous price list is not a ready tenant');
  assert.ok(r.waitingOn.some((w) => w.includes('Сор')));

  // Renaming one — the only repair, per D-075 — releases it. A row, not a code change.
  const renamed: IntakeDocument = {
    ...doc,
    services: [svc('Сор будаг', [], '120000', '190000'), svc('Оффис колор /Сор/', [], '380000', '460000')],
  };
  assert.equal(assessReadiness(renamed).stage, 'ready');
});

test('a question that cannot produce a wrong answer does not hold the tenant', () => {
  // `no_latin_stems` is a real ask_client — and a rule that fails to fire leaves the model
  // answering unrefused, which the outbound guard still bounds. It travels in the digest
  // without holding provisioning.
  const doc: IntakeDocument = {
    ...MINIMAL,
    services: [svc('Угаалт')],
    sentences: { ...MINIMAL.sentences, refusal_topic: 'Уучлаарай, боломжгүй.' },
    neverSay: [{ key: 'children', question: 'Хүүхэд үү?', responseKind: 'refusal_topic', stems: ['хүүхд'] }],
  };
  const r = assessReadiness(doc);
  assert.ok(r.findings.some((f) => f.code === 'no_latin_stems'));
  assert.equal(r.stage, 'ready');
  assert.ok(r.waitingOn.some((w) => w.startsWith('client:')), 'still said out loud');
});

// ---------------------------------------------------------------------------
// Comment rules (D-085) — the surface where a mistake is public and permanent
// ---------------------------------------------------------------------------

const withRules = (rules: IntakeDocument['commentRules'], over: Partial<IntakeDocument> = {}): IntakeDocument =>
  ({ ...MINIMAL, ...over, commentRules: rules });

const stemRule = (key: string, verdict: string, stems: string[]) =>
  ({ key, verdict, matcher: { mode: 'contains_stem', stems } });

test('DONE-TEST: a comment rule is validated by the SAME parser that will run it', () => {
  // A provisioning-only validator would be a second reader of one jsonb, free to disagree
  // with the first — and the direction it disagrees in is "accepted here, refuses the whole
  // job there", which is a tenant switched on and silently unable to answer a comment.
  // These are `parseMatcher`'s own rules, reaching the operator at intake instead of at
  // 3am in a worker log.
  const short = withRules([stemRule('price', 'reply', ['үнэ'])]);   // under MIN_STEM_CHARS
  assert.ok(codes(short).includes('comment_rule_matcher'));

  const oneStemSequence = withRules([
    { key: 'booking', verdict: 'reply', matcher: { mode: 'stem_sequence', stems: ['цаг'] } },
  ]);
  assert.ok(codes(oneStemSequence).includes('comment_rule_matcher'),
    'one stem in a sequence is contains_stem with the length floor removed');

  const unknownMode = withRules([{ key: 'x', verdict: 'reply', matcher: { mode: 'vibes' } }]);
  assert.ok(codes(unknownMode).includes('comment_rule_matcher'));
});

test('DONE-TEST: `unclassified` cannot be written as a rule', () => {
  // It is the ABSENCE of a matching rule, and it is the shadow phase's entire product: the
  // list of comments the tenant has no rule for. A row able to assert it would let somebody
  // edit that list into saying whatever they wanted.
  const f = validateIntake(withRules([{ key: 'x', verdict: 'unclassified', matcher: { mode: 'contains_stem', stems: ['хаяг'] } }]))
    .find((x) => x.code === 'comment_rule_verdict');
  assert.ok(f);
  assert.match(f?.detail ?? '', /escalate, reply or ignore/);
});

test('a rule set with no escalate is questioned, not accepted silently', () => {
  // Four of the 71 measured messages were complaints. With no escalate rule every one is
  // either answered "message us privately" under the business's own post, or ignored — and
  // both look exactly like the classifier working.
  const noEscalate = withRules(
    [stemRule('price', 'reply', ['хэдэ', 'hedee'])],
    { sentences: { ...MINIMAL.sentences, comment_public_reply: 'Сайн байна уу.' } },
  );
  assert.ok(codes(noEscalate).includes('comment_rules_no_escalate'));

  const withEscalate = withRules(
    [stemRule('price', 'reply', ['хэдэ', 'hedee']), stemRule('complaint', 'escalate', ['гомдол', 'gomdol'])],
    { sentences: { ...MINIMAL.sentences, comment_public_reply: 'Сайн байна уу.' } },
  );
  assert.ok(!codes(withEscalate).includes('comment_rules_no_escalate'));
});

test('rules that would reply, with no sentence to send, is a blocker', () => {
  const f = validateIntake(withRules([stemRule('price', 'reply', ['хэдэ', 'hedee'])]))
    .find((x) => x.code === 'comment_rules_without_line');
  assert.ok(f);
  assert.equal(f?.severity, 'blocker');
});

test('Cyrillic-only comment stems are questioned — D-067 on the public surface', () => {
  const f = validateIntake(withRules([stemRule('price', 'reply', ['хэдэ', 'төлбөр'])]))
    .find((x) => x.code === 'comment_rule_no_latin');
  assert.ok(f, '52% of the measured corpus carries no Cyrillic');
  assert.equal(f?.severity, 'ask_client');
});

test('two rules sharing a key is a blocker — the primary key would silently drop one', () => {
  const dupe = withRules([stemRule('price', 'reply', ['хэдэ', 'hedee']), stemRule('price', 'ignore', ['баярла', 'bayarla'])]);
  assert.ok(codes(dupe).includes('comment_rule_duplicate'));
});

test('no comment rules at all is silent — a tenant need not answer comments', () => {
  // The absence is a legitimate configuration, not an omission: `comment_policy` defaults
  // to `none` and `classifyComment` refuses `no_rules`, so the tenant simply stays quiet.
  const c = codes(MINIMAL);
  assert.ok(!c.some((x) => x.startsWith('comment_rule')));
});

test('DONE-TEST: A COLLISION THE CODE ANSWERS IS A QUESTION, NOT A HOLD', () => {
  // D-102 made a shadowed winner serve its whole family, and this finding went on holding
  // `ready` and advising a rename for four days. The founder caught it in a dry run, which
  // is the wrong place: a validator blocking on a relation the code handles is asking the
  // client to fix their catalogue to suit a refusal that no longer happens.
  //
  // «Хайрцаг» is seven code points and one token, so it clears the specificity floor and
  // reaches the family branch. Matrix is why this is not hypothetical — «Будаг» is hair
  // colouring and «Дип будаг» a manicure, two salons under one Page, and nothing should be
  // renamed.
  const doc: IntakeDocument = {
    ...MINIMAL,
    services: [svc('Хайрцаг', [], '40000'), svc('Автомат хайрцаг', [], '90000')],
  };
  const f = validateIntake(doc).find((x) => x.code === 'service_name_collision');
  assert.ok(f, 'still reported — the client should know what the reply looks like');
  assert.equal(f.severity, 'ask_client');
  assert.equal(f.holdsReady, undefined, 'answered, so it does not hold provisioning');
  assert.match(f.detail, /answered with BOTH/);
  assert.match(f.detail, /collides with/);
  assert.equal(assessReadiness(doc).stage, 'ready');
});

test('DONE-TEST: A SERVICE NO TERM CAN REACH IS NAMED, AND DOES NOT VANISH WITH ITS COLLISION', () => {
  // «Сор» used to be visible only as half of a collision. Matrix split «Оффис колор /Сор/»
  // into its own service, which removed the collision and left «Сор» exactly as unreachable
  // as before — three code points, one token, under the floor, so `matchService` answers
  // `too_vague` and no price can ever be served for it. Seven of Matrix's 164 corpus
  // messages reach it.
  //
  // Reported under its OWN code rather than the collision's, because the repair is different
  // and D-074's lesson is that the wrong reason sends the reader to the wrong screen. It does
  // not hold: nothing wrong is served, the turn falls through to the model, and that is the
  // same footing as `no_latin_stems`.
  const doc: IntakeDocument = { ...MINIMAL, services: [svc('Сор', ['сор', 'sor'], '120000', '190000')] };
  const f = validateIntake(doc).find((x) => x.code === 'service_name_unmatchable');
  assert.ok(f, 'an unreachable service must be named');
  assert.equal(f.holdsReady, undefined, 'a question that cannot produce a wrong answer');
  assert.match(f.detail, /Сор/);
  assert.ok(assessReadiness(doc).waitingOn.some((w) => w.includes('Сор')));

  // A two-token name clears it. The repair is a row the client supplies, not a code change.
  const longer: IntakeDocument = { ...MINIMAL, services: [svc('Сор будаг', ['сор будаг'], '120000', '190000')] };
  assert.equal(validateIntake(longer).find((x) => x.code === 'service_name_unmatchable'), undefined);
});

test('DONE-TEST: THE MATCHER THE WRITER BUILDS IS THE MATCHER THE VALIDATOR CHECKS', () => {
  // D-108, reproduced. `apply.ts` wrote `{ stems: [...] }` with no `mode`, `parseMatcher`
  // answered `unknown matcher mode undefined`, the gate failed closed, and every direct
  // message for Matrix 503'd from the cutover until the row was repaired by hand.
  //
  // The first assertion is the outage itself: the OLD shape is refused by the same
  // function that refused it in production. Without it this test would only prove the new
  // shape is fine, which was never in doubt — a test that cannot fail on the old code is
  // not a regression test.
  assert.equal(parseMatcher({ stems: ['зураг', 'зурган', 'фото'] }).ok, false);
  assert.equal(parseMatcher(topicMatcher(['зураг', 'зурган', 'фото'])).ok, true);

  // And the validator now refuses to let such a row be written at all. A short stem is
  // the same failure by a different route: MIN_STEM_CHARS is enforced by `parseMatcher`
  // and was applied to service aliases only, so a 3-character topic stem passed
  // validation, was written, and 503'd at request time exactly as the missing mode did.
  const shortStem: IntakeDocument = {
    ...MINIMAL,
    sentences: { ...MINIMAL.sentences, refusal_topic: 'Уучлаарай, энэ талаар мэдээлэл өгөх боломжгүй.' },
    neverSay: [{ key: 'photo', question: 'Зураг?', responseKind: 'refusal_topic', stems: ['зур'] }],
  };
  assert.ok(codes(shortStem).includes('topic_rule_matcher'));

  // An unusable rule is a BLOCKER, not an advisory: `apply.ts` dies on any blocker with
  // nothing written, which is the whole mechanism. Downgrading this severity re-opens the
  // outage while leaving the check in place and green.
  const f = validateIntake(shortStem).find((x) => x.code === 'topic_rule_matcher');
  assert.equal(f?.severity, 'blocker');

  // The usable case still passes, so the check cannot be satisfied by refusing everything.
  const fine: IntakeDocument = {
    ...shortStem,
    neverSay: [{ key: 'photo', question: 'Зураг?', responseKind: 'refusal_topic', stems: ['зураг'] }],
  };
  assert.ok(!codes(fine).includes('topic_rule_matcher'));
});
