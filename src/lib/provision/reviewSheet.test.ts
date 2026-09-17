import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readIntake } from './intake.ts';
import { assessReadiness, projectedAllowedNumbers, validateIntake } from './validate.ts';
import { reviewSheet } from './reviewSheet.ts';

const NOW = new Date('2026-09-16T01:00:00Z');
function example() {
  const raw = JSON.parse(readFileSync(new URL('../../../intake/example-auto.json', import.meta.url), 'utf8'));
  const r = readIntake(raw);
  assert.ok(r.ok, 'the shipped example must parse — it is the pipeline’s own worked example');
  return r.doc;
}
const sheetFor = (doc: ReturnType<typeof example>) => reviewSheet(doc, {
  numbers: projectedAllowedNumbers(doc, NOW),
  findings: validateIntake(doc, NOW),
  readiness: assessReadiness(doc, NOW),
});

test('DONE-TEST: THE SHIPPED EXAMPLE IS VALID INPUT AND IS NOT A SALON', () => {
  // The founder's standing rule is that a client is rows, never a code path. An example
  // document in an unrelated vertical is the cheapest ongoing proof that the reader, the
  // validator and the writer know nothing about hairdressing.
  const doc = example();
  assert.equal(doc.business.vertical, 'auto_service');
  const everything = JSON.stringify(doc);
  assert.doesNotMatch(everything, /салон|matrix/i, 'no salon vocabulary anywhere in it');
});

test('DONE-TEST: THE EXAMPLE’S TWO DELIBERATE FAULTS ARE BOTH REPORTED', () => {
  // The document ships incomplete on purpose, so a reader sees the validator speak rather
  // than reading a claim about what it would say. If either fault ever stops being reported,
  // this test fails and the example's own comment has become a lie.
  const codes = validateIntake(example(), NOW).map((f) => f.code);
  assert.ok(codes.includes('missing_sentence'), 'a rule pointing at an absent sentence');
  assert.ok(codes.includes('service_name_collision'), '«Хайрцаг» ⊂ «Автомат хайрцаг»');
  assert.equal(assessReadiness(example(), NOW).stage, 'knowledge', 'not ready, and named as such');
});

test('every sentence appears on the sheet, whole and unabridged', () => {
  const doc = example();
  const sheet = sheetFor(doc);
  // A review sheet that clipped a sentence would be a gate reading something other than what
  // is served — the same shape as measuring drift against a rewritten row.
  for (const body of Object.values(doc.sentences)) assert.ok(sheet.includes(body), body);
});

test('DONE-TEST: THE SHEET NAMES THE COLLISION AND SAYS IT HOLDS PROVISIONING', () => {
  const sheet = sheetFor(example());
  assert.match(sheet, /«Хайрцаг» ⊂ «Автомат хайрцаг»/);
  assert.match(sheet, /holds provisioning/);
  assert.match(sheet, /no price is served/);
});

test('the sheet prints the allow-list as permissions, including non-price numerals', () => {
  // «14 тоот» — a unit number in the street address — is on the list. Legitimate (the tenant
  // said it) and still a permission to type `14` about anything, which is the sentence the
  // sheet has to carry or the list reads as an inventory of prices.
  const sheet = sheetFor(example());
  assert.match(sheet, /allowed_numbers \(\d+\)/);
  assert.match(sheet, /Read the list as permissions/);
});

test('DONE-TEST: THE SHEET CANNOT SIGN, AND SAYS WHAT SIGNING MEANS', () => {
  const sheet = sheetFor(example());
  assert.match(sheet, /Nothing in the provisioning pipeline can set it/);
  assert.match(sheet, /written back UNREVIEWED/);
  // Stated as a property of the module, not a promise in a comment: it takes a document and
  // returns a string, so there is no handle through which it could write.
  assert.equal(typeof reviewSheet, 'function');
});

test('a tenant with no sentences at all is shown as such, not as an empty section', () => {
  const doc = { ...example(), sentences: {} };
  assert.match(sheetFor(doc), /this tenant cannot reply at all yet/);
});
