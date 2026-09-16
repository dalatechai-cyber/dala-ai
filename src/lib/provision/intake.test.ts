import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIntake } from './intake.ts';

const VALID = {
  slug: 'x-y',
  business: {
    displayName: 'X', vertical: 'auto_service', timezone: 'Asia/Ulaanbaatar',
    locale: 'mn-MN', currencySymbol: '₮', currencySymbolBefore: false,
  },
  confirmedBy: null,
  hours: [], services: [], contacts: [], booking: { url: null },
  sentences: {}, neverSay: [], faqs: [], staff: [],
};

test('DONE-TEST: A MISSPELLED FIELD IS REPORTED, NEVER IGNORED', () => {
  // The dangerous case, and the reason this check exists: a questionnaire exported with
  // `never_say` parses perfectly, yields an EMPTY rule list, and the bot then discusses the
  // one topic the business said it must never discuss. Silence here is a live hazard.
  const r = readIntake({ ...VALID, never_say: [{ key: 'warranty' }] });
  assert.equal(r.ok, false);
  const problems = r.ok === false ? r.problems : [];
  assert.ok(problems.some((x) => x.path === 'never_say'));
  assert.match(problems[0]!.detail, /neverSay/, 'it names the field that was meant');
});

test('an underscore-prefixed key is a deliberate annotation and is allowed', () => {
  const r = readIntake({ ...VALID, _comment: 'why this document looks like this' });
  assert.equal(r.ok, true);
});

test('DONE-TEST: THE DOCUMENT IS BUILT, NOT CAST', () => {
  // `raw as IntakeDocument` is "answer with what you managed" wearing a type annotation —
  // it hands the writer whatever else was in the file, unexamined, under a name claiming it
  // was checked. An annotation must not survive into the thing that writes rows.
  const r = readIntake({ ...VALID, _note: 'scratch' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!Object.prototype.hasOwnProperty.call(r.doc, '_note'));
    assert.deepEqual(Object.keys(r.doc).sort(), [
      'booking', 'business', 'confirmedBy', 'contacts', 'faqs', 'hours',
      'neverSay', 'sentences', 'services', 'slug', 'staff',
    ]);
  }
});

test('a closed day carries no hours, whatever the document said', () => {
  // The database's `open_days_have_hours` would refuse the row; building rather than casting
  // is what makes the document and the constraint agree before the insert is attempted.
  const r = readIntake({ ...VALID, hours: [{ weekday: 0, opens: '09:00', closes: '18:00', closed: true }] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.doc.hours[0], { weekday: 0, opens: null, closes: null, closed: true });
});
