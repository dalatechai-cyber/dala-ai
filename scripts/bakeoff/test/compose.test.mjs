// Unit tests for the prefix-composition measurement.
//
// Synthetic fixture, same reasoning as gate.test.mjs: Matrix-Chatbot is private,
// so an ancestor-dependent test is a test that silently never runs in CI. What is
// under test is the accounting, not the salon's content.
//
// compose() is imported from compose.mjs, which imports prefix.mjs — that module
// touches the filesystem only inside buildMatrixPrefix(), so importing it here
// needs no checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../compose.mjs';

const FIXTURE = `Чи бол ресепшн.
=== ХЭЛНИЙ ДҮРЭМ ===
Зөвхөн монголоор.
=== ҮНИЙН ЖАГСААЛТ ===
Эмэгтэй тайралт: 55,000₮
=== УРЬДЧИЛГАА ТӨЛБӨРИЙН ДҮРЭМ (цаг авах үед) ===
Мастер үсчин: 20,000₮ урьдчилгаа
=== ЖИШЭЭ ЯРИ ===
Х: Сайн уу? Х: Сайн байна уу.
`;

test('every character of the prefix lands in exactly one section', () => {
  // The bug this pins: the first measurement counted section BODIES and dropped
  // the "=== TITLE ===" delimiter lines, so the published table summed to 10,937
  // against a stated total of 11,321 — 384 characters we really pay for, missing.
  const { total, sections } = compose(FIXTURE);
  assert.equal(total, FIXTURE.length);
  assert.equal(sections.reduce((n, s) => n + s.chars, 0), total);
});

test('the preamble before the first delimiter is counted', () => {
  const { sections } = compose(FIXTURE);
  const preamble = sections.find((s) => s.title === '(preamble)');
  assert.ok(preamble, 'text before the first === marker was dropped');
  assert.equal(preamble.chars, FIXTURE.indexOf('==='));
});

test('the deposit rule counts as tenant knowledge, not platform instruction', () => {
  // The specific misclassification that made tenant knowledge look ~6 points
  // smaller than it is. A deposit policy is the salon's own commercial term: it
  // differs per tenant, so it is exactly the kind of thing a trim must not touch.
  const { sections } = compose(FIXTURE);
  const deposit = sections.find((s) => s.title.startsWith('УРЬДЧИЛГАА'));
  assert.equal(deposit.class, 'tenant');
});

test('an unrecognised section throws instead of being silently dropped', () => {
  // The failure mode that produced the wrong number in the first place. A section
  // nobody classified must stop the measurement, not quietly vanish from a total.
  const withNew = FIXTURE + '=== ШИНЭ ХЭСЭГ ===\nЯмар нэг зүйл.\n';
  assert.throws(() => compose(withNew), /unclassified section/);
});

test('a prefix with no delimiters is an error, not an empty measurement', () => {
  assert.throws(() => compose('ямар ч хэсэггүй текст'), /changed shape/);
});
