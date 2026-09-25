import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextLocalDate, renderTomorrowSlots } from './daySlots.ts';
import { withDaySlots } from './load.ts';
import { matchDeterministic, withAppended, type DeterministicRule } from '../gate/deterministic.ts';
import { parseMatcher, type MatcherSpec } from '../gate/match.ts';
import type { BusinessHours } from './volatile.ts';

// Matrix's week as `business_hours` holds it: Monday–Saturday 10–20, Sunday 11–19.
const WEEK: BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => (weekday === 0
  ? { weekday, opens: '11:00:00', closes: '19:00:00', closed: false }
  : { weekday, opens: '10:00:00', closes: '20:00:00', closed: false }));

const TOMORROW_BODY = 'Маргааш ({tomorrow.day}) {tomorrow.hours} ажиллана.';
const HOLIDAY_BODY = 'Баярын өдрийн цагийг 76001888 дугаараас лавлана уу.';
// 2026-09-25 is a Friday on the Ulaanbaatar clock; tomorrow is Saturday.
const FRIDAY = '2026-09-25';

test('tomorrow is the next calendar day, across a month and a year', () => {
  assert.deepEqual(nextLocalDate('2026-09-25'), { date: '2026-09-26', weekday: 6 });
  assert.deepEqual(nextLocalDate('2026-09-30'), { date: '2026-10-01', weekday: 4 });
  assert.deepEqual(nextLocalDate('2026-12-31'), { date: '2027-01-01', weekday: 5 });
  assert.equal(nextLocalDate('25/09/2026'), null);
});

test("the founder's sentence, filled from the rows", () => {
  const base = { hours: WEEK, closures: [], branchCount: 0 };
  assert.equal(renderTomorrowSlots(TOMORROW_BODY, { ...base, localDate: FRIDAY }), 'Маргааш (Бямба) 10:00–20:00 ажиллана.');
  // Saturday: tomorrow is Sunday, which keeps different hours.
  assert.equal(renderTomorrowSlots(TOMORROW_BODY, { ...base, localDate: '2026-09-26' }), 'Маргааш (Ням) 11:00–19:00 ажиллана.');
  assert.equal(renderTomorrowSlots('Сайн байна уу!', { ...base, localDate: FRIDAY }), 'Сайн байна уу!', 'a body with no slot is untouched');
});

test('DONE-TEST: THE ROW DOES NOT ANSWER WHEN "TOMORROW WE OPEN" COULD BE FALSE', () => {
  const base = { hours: WEEK, closures: [], branchCount: 0, localDate: FRIDAY };
  const closure = { startsOn: '2026-09-26', endsOn: '2026-09-26', title: 'Баяр', message: 'Амарна.' };
  assert.equal(renderTomorrowSlots(TOMORROW_BODY, { ...base, closures: [closure] }), null, 'a closure covers tomorrow');
  assert.equal(renderTomorrowSlots(TOMORROW_BODY, {
    ...base, hours: WEEK.map((h) => (h.weekday === 6 ? { ...h, closed: true } : h)),
  }), null, 'closed tomorrow');
  assert.equal(renderTomorrowSlots(TOMORROW_BODY, { ...base, hours: WEEK.filter((h) => h.weekday !== 6) }), null, 'no row for tomorrow');
  assert.equal(renderTomorrowSlots(TOMORROW_BODY, { ...base, branchCount: 2 }), null, 'two branches keep two weeks');
  assert.equal(renderTomorrowSlots('Маргааш {tomorrow.date}', base), null, 'an unknown slot is never sent raw');
});

type TemplateRow = { intent: string; placement: 'replace' | 'append'; matcher: unknown };
const TEMPLATE = JSON.parse(readFileSync(new URL('../../../scripts/provision/templates/day_hours.salon.json', import.meta.url), 'utf8')) as { rows: TemplateRow[] };

function rules(localDate = FRIDAY, closures = []): DeterministicRule[] {
  const rows = TEMPLATE.rows.map((r): DeterministicRule => {
    const parsed = parseMatcher(r.matcher);
    assert.ok(parsed.ok, `${r.intent}: the template's matcher must parse`);
    return {
      intent: r.intent, body: r.intent === 'tomorrow_hours' ? TOMORROW_BODY : HOLIDAY_BODY,
      enabled: true, matchMode: 'matcher', stems: [], coverWords: [], placement: r.placement,
      quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
      matcher: (parsed as { spec: MatcherSpec }).spec,
    };
  });
  return withDaySlots(rows, { localDate, hours: WEEK, closures, branchCount: 0 });
}

/** What the customer is sent for this message, when a row answers it; null when the model does. */
function answer(text: string, rs = rules()): string | null {
  const out = matchDeterministic(text, rs, { known: true, empty: false }, { hasAttachment: false });
  return out.hit === null ? null : withAppended(out.hit.body, out.appends);
}

test('DONE-TEST (live, 2026-09-25): «Hi margaash tanaih ajilahu» gets tomorrow, not the week', () => {
  assert.equal(answer('Hi margaash tanaih ajilahu'), 'Маргааш (Бямба) 10:00–20:00 ажиллана.');
});

test('DONE-TEST (live, 2026-09-25): the public-holiday question gets tomorrow AND the holiday line, never the price refusal', () => {
  assert.equal(answer('Margaash automashingvi bvh niitiin amraltiin udur ym bn'),
    'Маргааш (Бямба) 10:00–20:00 ажиллана.\n\nБаярын өдрийн цагийг 76001888 дугаараас лавлана уу.');
});

test('the same question in Cyrillic, and asked as "are you closed"', () => {
  assert.equal(answer('Маргааш ажиллах уу?'), 'Маргааш (Бямба) 10:00–20:00 ажиллана.');
  assert.equal(answer('Маргааш та нар амрах уу'), 'Маргааш (Бямба) 10:00–20:00 ажиллана.');
  assert.equal(answer('Маргааш хэдэн цагт ажиллах вэ?'), 'Маргааш (Бямба) 10:00–20:00 ажиллана.');
});

test('a message about something else as well is left to the model — a row must not swallow it', () => {
  for (const text of [
    'Маргааш цаг авч болох уу?',              // booking
    'Маргааш ажиллах уу? Үнэ нь хэд вэ',      // price as well
    'margaash ajillah uu hayag haana ve',     // address as well
    'Маргааш',                                 // tomorrow alone
    'Ажиллах уу?',                             // no day: the week is right
  ]) assert.equal(answer(text), null, text);
});

test('«баярлалаа» (thank you) never carries the holiday line', () => {
  const out = matchDeterministic('Za bayrlalaa', rules(), { known: true, empty: false }, { hasAttachment: false });
  assert.deepEqual(out.appends, []);
  const out2 = matchDeterministic('Баярлалаа', rules(), { known: true, empty: false }, { hasAttachment: false });
  assert.deepEqual(out2.appends, []);
});

test('a holiday question with no day still gets the holiday line, appended to whatever answers', () => {
  const out = matchDeterministic('Цагаан сараар ажиллах уу?', rules(), { known: true, empty: false }, { hasAttachment: false });
  assert.equal(out.hit, null);
  assert.deepEqual(out.appends.map((a) => a.body), [HOLIDAY_BODY]);
});

test('a closure tomorrow withholds the row: the model answers, with the closure notice in front of it', () => {
  const closed = rules(FRIDAY, [{ startsOn: '2026-09-26', endsOn: '2026-09-27', title: 'x', message: 'y' }] as never);
  assert.equal(answer('Hi margaash tanaih ajilahu', closed), null);
});

test('a matcher row whose jsonb did not parse never fires', () => {
  const broken: DeterministicRule = { ...rules()[0]!, matcher: null };
  const out = matchDeterministic('Маргааш ажиллах уу?', [broken], { known: true, empty: false }, { hasAttachment: false });
  assert.equal(out.hit, null);
  assert.deepEqual(out.skipped, [{ intent: 'tomorrow_hours', reason: 'bad_matcher' }]);
});
