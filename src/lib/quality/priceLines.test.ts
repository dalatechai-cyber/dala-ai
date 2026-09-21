import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceLineReport } from './priceLines.ts';

// Every string below is a REAL reply from the 2026-09-21 measured runs, not an invented
// one. An imagined reply measures the imagination.

test('DONE-TEST: THREE OPTIONS CRAMMED ONTO ONE LINE IS THE VIOLATION', () => {
  // Turn 2 of the founder's session, verbatim.
  const r = priceLineReport(
    'Будалтын үнэ үсний уртаас хамаарна: далнаас доош 200,000₮, далны дээгүүр 176,000₮, хүзүүний урт 135,000₮.');
  assert.equal(r.total, 3);
  assert.equal(r.maxPerLine, 3);
  assert.equal(r.violation, true);
});

test('DONE-TEST: the same three ONE PER LINE is compliant', () => {
  // Turn 9, verbatim — same question, same revision, correct shape.
  const r = priceLineReport(
    'Будалтын хэдэн сонголт байна — үсний уртаас хамаарна:\n\n'
    + 'Хүзүүний урт: 135,000₮\nДалны дээгүүр: 176,000₮\nДалнаас доош: 200,000₮\n\n'
    + 'Таны үсний урт ямар байна вэ?');
  assert.equal(r.total, 3);
  assert.equal(r.maxPerLine, 1);
  assert.equal(r.violation, false);
});

test('DONE-TEST: A RANGE IS ONE OPTION, NOT TWO', () => {
  // The first version counted figures and reported this — a single correct reply — as a
  // violation. «Сор: 120,000₮–190,000₮» is one price on one line.
  const r = priceLineReport('Сор: 120,000₮–190,000₮');
  assert.equal(r.total, 1);
  assert.equal(r.violation, false, 'a range on its own line is compliant');
});

test('a range written with an ASCII hyphen counts the same', () => {
  assert.equal(priceLineReport('Сор: 120,000₮-190,000₮').total, 1);
});

test('two ranges on one line IS a violation', () => {
  // Turn 10, verbatim: three options on one line, two of them ranges.
  const r = priceLineReport(
    'Мастер үсчний хэлбэржүүлэлт 33,000₮–50,000₮, эмэгтэй тайралт 66,000₮–88,000₮, эрэгтэй тайралт 66,000₮ байна.');
  assert.equal(r.total, 3);
  assert.equal(r.violation, true);
});

test('FOUR or more is outside rule (4) first branch and is not reported here', () => {
  // Conflating "crammed three onto a line" with "listed five where it should have asked"
  // would make the counter unable to answer either question.
  const r = priceLineReport('А 10,000₮, Б 20,000₮, В 30,000₮, Г 40,000₮');
  assert.equal(r.total, 4);
  assert.equal(r.violation, false);
});

test('a single price is never a violation', () => {
  assert.equal(priceLineReport('Шулуун хими: 430,000₮–510,000₮ байна.').violation, false);
});

test('a phone number is not a price option', () => {
  // 76001888 is 8 digits with no separator. It matches FIGURE's 4+ branch, so this asserts
  // the KNOWN limit rather than a capability: two phone numbers on one line read as two
  // options. It is recorded because a counter whose false-positive is undocumented gets
  // read as a rate it is not.
  const r = priceLineReport('Утасны дугаар: 76001888 эсвэл 80905498.');
  assert.equal(r.total, 2, 'KNOWN: bare long digit runs count. See the note in this test.');
  assert.equal(r.violation, true, 'and therefore this reports a false positive');
});
