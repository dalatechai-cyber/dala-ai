import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFragment, MAX_FRAGMENT_CP, MIN_FRAGMENT_CP } from './fragment.ts';

const m = (customerKey: string, text: string) => ({ customerKey, text });

/** Stopwords are DATA, supplied as a caller would supply them — never imported from src. */
const STOP = ['байна', 'сайн', 'уу', 'вэ', 'бэ'];

// ---------------------------------------------------------------------------
// The privacy property, which is structural rather than a filter
// ---------------------------------------------------------------------------

test('DONE-TEST: A NAME ONLY ONE CUSTOMER TYPED CAN NEVER BE THE FRAGMENT', () => {
  // The whole safety argument in one assertion. «Болормаа» is a person's name and appears
  // in exactly one message; «үнэ» is what both customers were actually asking about. There
  // is no name list anywhere in this module — the name is excluded because it is not shared.
  const r = safeFragment([
    m('psid-A', 'Болормаа гэж хүн байна уу, үнэ хэд вэ'),
    m('psid-B', 'үнэ хэд вэ'),
  ], { stopwords: STOP });
  assert.equal(r.ok, true);
  // The assertion is the EXCLUSION, not which of the shared terms wins. «үнэ» and «хэд»
  // are both shared and both three code points, so the code-point tie-break decides
  // between them — and that is arbitrary but deterministic, which is all it needs to be.
  // What matters is that the name cannot be the answer under any tie-break.
  assert.notEqual(r.ok && r.fragment, 'болормаа');
  assert.ok(['үнэ', 'хэд'].includes(r.ok ? r.fragment : ''), 'a term both customers used');
});

test('the name is not merely outranked — it is not a candidate at all', () => {
  // Stronger than the above: with the shared terms removed, there is still no fragment,
  // rather than the name being promoted once its competition is gone.
  const r = safeFragment([
    m('psid-A', 'Болормаа'),
    m('psid-B', 'Оюунсүрэн'),
  ], { stopwords: STOP });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'no_shared_term');
});

test('DONE-TEST: A PHONE NUMBER IS NOT QUOTABLE EVEN WHEN TWO CUSTOMERS TYPE IT', () => {
  // The backstop for the case the sharing rule alone would pass: two people quoting the
  // salon's own number. Digits are dropped by the splitter AND by the digit-run guard.
  const r = safeFragment([
    m('psid-A', '77417777 руу залгасан'),
    m('psid-B', '77417777 дугаар'),
  ], { stopwords: STOP });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'no_shared_term');
});

test('a PSID is never a fragment, even shared', () => {
  const r = safeFragment([
    m('psid-A', '25031102309902091'),
    m('psid-B', '25031102309902091'),
  ]);
  assert.equal(r.ok, false);
});

test('one customer repeating a word does not make it shared', () => {
  // Otherwise a single persistent person manufactures a cluster, and the report ranks a
  // gap that one человек had. Distinct customers, never message counts.
  const r = safeFragment([
    m('psid-A', 'цаг цаг цаг цаг'),
    m('psid-A', 'цаг авмаар байна'),
  ], { stopwords: STOP });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'too_few_customers');
});

test('DONE-TEST: A TERM IS COUNTED PER CUSTOMER, NOT PER MESSAGE', () => {
  // Found by mutation testing: replacing the per-term customer SET with a per-occurrence
  // count passed all fifteen other tests. The nearby "one customer repeating a word" case
  // is caught by the earlier whole-cluster guard, so nothing exercised the per-term
  // counting at all — and that counting IS the privacy property.
  //
  // Here the cluster has two distinct customers, so the early guard passes. But «хумс» was
  // typed by only ONE of them, three times. If occurrences counted, one talkative person
  // would get their own words quoted into Telegram as though they were a shared pattern —
  // which is the exact failure the shared-term rule exists to prevent.
  // Two SEPARATE messages from the same person: within-message repetition is already
  // collapsed by `new Set(terms(...))`, so it is the across-message case that the
  // per-customer set is actually load-bearing for.
  const r = safeFragment([
    m('psid-A', 'хумс'),
    m('psid-A', 'хумс яаж захиалах вэ'),
    m('psid-B', 'үсчин'),
  ], { stopwords: STOP });
  assert.equal(r.ok, false, '«хумс» was typed twice, but by one person');
  assert.equal(r.ok === false && r.reason, 'no_shared_term');
});

// ---------------------------------------------------------------------------
// Refusing is a supported answer, not a failure
// ---------------------------------------------------------------------------

test('DONE-TEST: NO SAFE FRAGMENT REFUSES rather than quoting a best effort', () => {
  // The founder's clause: if a cluster cannot be understood from a fragment, the report
  // says so and points at kb_change_proposals. A redactor that always produces something
  // will one day produce something unsafe.
  const r = safeFragment([
    m('psid-A', 'Сайн байна уу'),
    m('psid-B', 'Өө тийм үү'),
  ], { stopwords: STOP });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'no_shared_term');
});

test('an empty cluster refuses with its own reason', () => {
  assert.deepEqual(safeFragment([]), { ok: false, reason: 'no_messages' });
});

// ---------------------------------------------------------------------------
// "Shortest distinguishing"
// ---------------------------------------------------------------------------

test('the fragment is the SHORTEST term shared by the most customers', () => {
  const r = safeFragment([
    m('psid-A', 'үсчин захиалга'),
    m('psid-B', 'үсчин захиалга'),
    m('psid-C', 'үсчин'),
  ], { stopwords: STOP });
  // «үсчин» has 3 customers, «захиалга» has 2 — customers first, and only then length.
  assert.equal(r.ok && r.fragment, 'үсчин');
});

test('ties on customer count are broken by length, then by code point', () => {
  const r = safeFragment([
    m('psid-A', 'будаг тайралт'),
    m('psid-B', 'будаг тайралт'),
  ], { stopwords: STOP });
  assert.equal(r.ok && r.fragment, 'будаг', 'five code points beats eight');
});

test('a whole sentence is never returned — the cap is a code-point count', () => {
  assert.ok(MAX_FRAGMENT_CP < 80, 'the cap has to be shorter than a sentence to mean anything');
  const long = 'а'.repeat(MAX_FRAGMENT_CP + 1);
  const r = safeFragment([m('psid-A', long), m('psid-B', long)]);
  assert.equal(r.ok, false, 'an over-long shared token is not a fragment');
});

test('a term shorter than the floor is not a fragment', () => {
  assert.ok(MIN_FRAGMENT_CP >= 3);
  const short = 'аб';
  const r = safeFragment([m('psid-A', short), m('psid-B', short)]);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Mongolian handling, and determinism
// ---------------------------------------------------------------------------

test('Cyrillic case folds, and Ө/Ү survive it', () => {
  // `unaccent` is forbidden here for mapping Ё→Е while leaving Ө and Ү alone. Lowercasing
  // must fold Ө→ө without touching anything else.
  const r = safeFragment([m('psid-A', 'ӨНГӨ'), m('psid-B', 'өнгө')]);
  assert.equal(r.ok && r.fragment, 'өнгө');
});

test('the same cluster produces the same fragment whatever order it arrives in', () => {
  // This string reaches a report a founder compares fortnight to fortnight, and the
  // ordering must be a property of the rows rather than of the machine (D-026).
  const msgs = [m('psid-A', 'сор түрхэц'), m('psid-B', 'сор түрхэц')];
  const a = safeFragment(msgs);
  const b = safeFragment([...msgs].reverse());
  assert.deepEqual(a, b);
});

test('minCustomers is raisable for a stronger claim', () => {
  const msgs = [m('psid-A', 'хумс'), m('psid-B', 'хумс')];
  assert.equal(safeFragment(msgs, { minCustomers: 2 }).ok, true);
  assert.equal(safeFragment(msgs, { minCustomers: 3 }).ok, false);
});

test('stopwords are honoured and are a parameter, not a constant', () => {
  const msgs = [m('psid-A', 'сайн байна уу'), m('psid-B', 'сайн байна уу')];
  assert.equal(safeFragment(msgs).ok, true, 'with no list, a greeting is quotable');
  assert.equal(safeFragment(msgs, { stopwords: STOP }).ok, false, 'with one, it is not');
});
