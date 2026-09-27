import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionOf, fillTemplate, holds, itemReferences, launchJson, lookupOf, parseItems, parseLaunchRecords,
  resolveDeterministicRows, resolveItemWords, sameLaunch, withOverrides, type LaunchRecord,
} from './launch.ts';
import { toDeterministic } from '../reception/load.ts';
import { matchDeterministic } from '../gate/deterministic.ts';

// Service ids only: the module never sees a tenant, and neither do these tests.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const rec = (a: 'live' | 'preregistration', b: 'live' | 'preregistration', c: 'live' | 'preregistration'): LaunchRecord[] => [
  { serviceId: A, name: 'Анар — зөвлөх', state: a },
  { serviceId: B, name: 'Бат — оператор', state: b },
  { serviceId: C, name: 'Цэцэг — туслах', state: c },
];

// A price overview whose "coming soon" line lists what is not live yet, and whose live
// services each get a line of their own.
const OVERVIEW = '💬 Суурь: сард 100,000₮\n{{live}}\n🌐 Вэбсайт: 750,000₮\n⏳ Удахгүй: {{soon}}';
const OVERVIEW_ITEMS = [
  { slot: 'live', body: '📣 Анар — зөвлөх: сард 350,000₮', service_id: A, state: 'live' },
  { slot: 'live', body: '📞 Бат — оператор: сард 150,000₮', service_id: B, state: 'live' },
  { slot: 'soon', body: 'Анар сард 350,000₮', service_id: A, state: 'preregistration' },
  { slot: 'soon', body: 'Бат сард 150,000₮', service_id: B, state: 'preregistration' },
  { slot: 'soon', body: 'Цэцэг — урьдчилан бүртгэл авч байна', service_id: C, state: 'preregistration' },
];

test('conditions: both columns or neither; a half-written one never holds', () => {
  assert.equal(conditionOf(null, null), null);
  assert.deepEqual(conditionOf(A.toUpperCase(), 'live'), { serviceId: A, state: 'live' });
  assert.equal(conditionOf(A, null), 'bad');
  assert.equal(conditionOf(null, 'live'), 'bad');
  assert.equal(conditionOf(A, 'soon'), 'bad');
  assert.equal(conditionOf('not-a-uuid', 'live'), 'bad');
  assert.equal(holds('bad', lookupOf(rec('live', 'live', 'live'))), false);
});

test('DONE-TEST: A CONDITION NEVER HOLDS WITHOUT A RECORD — a snapshot before 0063 cannot claim anything is live', () => {
  // Founder: «Дали must never claim a staff member works before its switch is on.» A snapshot
  // that recorded no states cannot show that anything is on, so nothing conditioned holds.
  assert.equal(holds({ serviceId: A, state: 'live' }, null), false);
  assert.equal(holds({ serviceId: A, state: 'preregistration' }, null), false);
  assert.equal(holds(null, null), true, 'a row with no condition answers exactly as before');
  // A service the record does not know is not in any state.
  assert.equal(holds({ serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', state: 'live' }, lookupOf(rec('live', 'live', 'live'))), false);
});

test('the template: all coming soon reproduces the one-line wording, all live drops the coming-soon line', () => {
  const items = parseItems(OVERVIEW_ITEMS);
  assert.ok(items !== null);
  assert.equal(fillTemplate(OVERVIEW, items, lookupOf(rec('preregistration', 'preregistration', 'preregistration'))),
    '💬 Суурь: сард 100,000₮\n🌐 Вэбсайт: 750,000₮\n⏳ Удахгүй: Анар сард 350,000₮, Бат сард 150,000₮, Цэцэг — урьдчилан бүртгэл авч байна');
  assert.equal(fillTemplate(OVERVIEW, items, lookupOf(rec('live', 'preregistration', 'preregistration'))),
    '💬 Суурь: сард 100,000₮\n📣 Анар — зөвлөх: сард 350,000₮\n🌐 Вэбсайт: 750,000₮\n⏳ Удахгүй: Бат сард 150,000₮, Цэцэг — урьдчилан бүртгэл авч байна');
  // Nothing coming soon: the line that was ABOUT that list goes, not just its contents.
  const allLive = fillTemplate(OVERVIEW, items, lookupOf(rec('live', 'live', 'live')));
  assert.equal(allLive, '💬 Суурь: сард 100,000₮\n📣 Анар — зөвлөх: сард 350,000₮\n📞 Бат — оператор: сард 150,000₮\n🌐 Вэбсайт: 750,000₮');
  assert.equal(allLive?.includes('Удахгүй'), false);
});

test('a template with nothing to say, an undeclared slot or a stray brace does not answer', () => {
  const items = parseItems([{ slot: 'soon', body: 'Анар', service_id: A, state: 'preregistration' }]);
  assert.ok(items !== null);
  assert.equal(fillTemplate('{{soon}} хараахан ажиллаж эхлээгүй.', items, lookupOf(rec('live', 'live', 'live'))), null);
  assert.equal(fillTemplate('{{other}} хараахан.', items, lookupOf(rec('preregistration', 'live', 'live'))), null);
  assert.equal(fillTemplate('{{Soon}} хараахан.', items, lookupOf(rec('preregistration', 'live', 'live'))), null);
  assert.equal(fillTemplate('Сайн {{ байна', [], null), null);
  assert.equal(fillTemplate('Сайн байна уу.', [], null), 'Сайн байна уу.', 'no slots: the body as written');
});

test('pieces: a malformed list is refused whole, never read in part', () => {
  assert.deepEqual(parseItems(null), []);
  assert.equal(parseItems({}), null);
  assert.equal(parseItems([{ slot: 'soon' }]), null, 'no body');
  assert.equal(parseItems([{ slot: 'soon', body: 'a\nb' }]), null, 'a piece is one line');
  assert.equal(parseItems([{ slot: 'soon', body: '{{x}}' }]), null, 'a piece is not a template');
  assert.equal(parseItems([{ slot: 'soon', body: 'Анар', service_id: A }]), null, 'half a condition');
  assert.equal(parseItems([{ slot: 'soon', body: 'Анар', words: ['анар', ''] }]), null, 'an empty word');
  assert.equal(parseItems([{ slot: 'soon', body: 'Анар' }, 'x']), null);
});

test('item_words: the row fires on the names of what is still coming soon, and not at all once nothing is', () => {
  const items = parseItems([
    { slot: 'soon', body: 'Анар', service_id: A, state: 'preregistration', words: ['анар', 'анарын'] },
    { slot: 'soon', body: 'Бат', service_id: B, state: 'preregistration', words: ['бат', 'батын'] },
  ]);
  assert.ok(items !== null);
  const matcher = { mode: 'all_of', matchers: [{ mode: 'in_reply', matcher: { mode: 'item_words' } }, { mode: 'not', matcher: { mode: 'has_word', words: ['урьдчилан бүртгэл'] } }] };
  assert.deepEqual(resolveItemWords(matcher, items, lookupOf(rec('live', 'preregistration', 'live'))),
    { mode: 'all_of', matchers: [{ mode: 'in_reply', matcher: { mode: 'has_word', words: ['бат', 'батын'] } }, { mode: 'not', matcher: { mode: 'has_word', words: ['урьдчилан бүртгэл'] } }] });
  assert.equal(resolveItemWords(matcher, items, lookupOf(rec('live', 'live', 'live'))), null);
});

const row = (over: Record<string, unknown>) => ({
  intent: 'x', body: 'Сайн байна уу.', web_body: null, enabled: true, match_mode: 'whole_message', stems: ['сайн уу'],
  cover_words: [], placement: 'replace', quote_services: [], requires_empty_history: false, provenance: 'tenant_confirmed',
  matcher: null, when_service_id: null, when_launch_state: null, items: null, ...over,
});

test('DONE-TEST: ONE ROW PER STATE — the answer about a service changes with its switch and with nothing else', () => {
  const soon = row({ intent: 'a_about', body: 'Анар урьдчилан бүртгэл авч байна.', when_service_id: A, when_launch_state: 'preregistration' });
  const live = row({ intent: 'a_about_live', body: 'Анар ажиллаж байна.', when_service_id: A, when_launch_state: 'live' });
  const plain = row({ intent: 'hello' });
  const off = resolveDeterministicRows([soon, live, plain], lookupOf(rec('preregistration', 'live', 'live')));
  assert.deepEqual(off.rows.map((r) => r['intent']), ['a_about', 'hello']);
  assert.deepEqual(off.withheld, [{ intent: 'a_about_live', reason: 'condition' }]);
  const on = resolveDeterministicRows([soon, live, plain], lookupOf(rec('live', 'live', 'live')));
  assert.deepEqual(on.rows.map((r) => r['intent']), ['a_about_live', 'hello']);
  // No record: neither state can be shown, so neither answers; the plain row is untouched.
  assert.deepEqual(resolveDeterministicRows([soon, live, plain], null).rows.map((r) => r['intent']), ['hello']);
  // The launch columns do not reach the gate's row shape.
  assert.equal('items' in (on.rows[0] ?? {}), false);
});

test('a templated append row, through the real gate: it names only what is still coming soon', () => {
  const coming = row({
    intent: 'coming_soon_in_reply', placement: 'append', match_mode: 'matcher', stems: [],
    body: '{{soon}} хараахан ажиллаж эхлээгүй.',
    matcher: { mode: 'all_of', matchers: [{ mode: 'in_reply', matcher: { mode: 'item_words' } }, { mode: 'not', matcher: { mode: 'in_reply', matcher: { mode: 'has_word', words: ['урьдчилан бүртгэл'] } } }] },
    items: [
      { slot: 'soon', body: 'Анар', service_id: A, state: 'preregistration', words: ['анар'] },
      { slot: 'soon', body: 'Бат', service_id: B, state: 'preregistration', words: ['бат'] },
    ],
  });
  const fire = (states: LaunchRecord[], reply: string) => {
    const rules = toDeterministic(resolveDeterministicRows([coming], lookupOf(states)).rows);
    return matchDeterministic('юу хийдэг вэ', rules, { known: true, empty: true }, { hasAttachment: false, reply }).appends.map((a) => a.body);
  };
  assert.deepEqual(fire(rec('preregistration', 'preregistration', 'live'), 'Бат дуудлагад хариулна.'), ['Анар, Бат хараахан ажиллаж эхлээгүй.']);
  // Бат is live: a reply about Бат gets nothing appended, a reply about Анар still does.
  assert.deepEqual(fire(rec('preregistration', 'live', 'live'), 'Бат дуудлагад хариулна.'), []);
  assert.deepEqual(fire(rec('preregistration', 'live', 'live'), 'Анар зөвлөгөө өгнө.'), ['Анар хараахан ажиллаж эхлээгүй.']);
  // Everything live: the row is gone.
  assert.deepEqual(fire(rec('live', 'live', 'live'), 'Анар зөвлөгөө өгнө.'), []);
});

test('web_body is filled from the same pieces, and a row whose pieces do not parse never answers', () => {
  const r = resolveDeterministicRows([row({ body: 'Удахгүй: {{soon}}', web_body: 'Вэб: {{soon}}', items: OVERVIEW_ITEMS })],
    lookupOf(rec('preregistration', 'live', 'live')));
  assert.equal(r.rows[0]?.['body'], 'Удахгүй: Анар сард 350,000₮');
  assert.equal(r.rows[0]?.['web_body'], 'Вэб: Анар сард 350,000₮');
  assert.deepEqual(resolveDeterministicRows([row({ items: [{ slot: 'x' }] })], null).withheld, [{ intent: 'x', reason: 'bad_items' }]);
});

test('records round-trip in id order, compare by content, and a malformed entry is dropped', () => {
  const r = rec('live', 'preregistration', 'live');
  const stored = launchJson([...r].reverse());
  assert.deepEqual(stored.map((x) => x.service_id), [A, B, C]);
  assert.ok(sameLaunch(parseLaunchRecords(stored), r));
  assert.equal(sameLaunch(r, rec('live', 'live', 'live')), false);
  assert.equal(sameLaunch(null, r), false);
  assert.equal(parseLaunchRecords(null), null);
  assert.deepEqual(parseLaunchRecords([{ service_id: A, name: 'a', state: 'on' }]), []);
});

test('overrides are by service name, and a name that matches nothing is reported, not ignored', () => {
  const out = withOverrides(rec('preregistration', 'preregistration', 'preregistration'), new Map([['Анар — зөвлөх', 'live'], ['Хэн ч биш', 'live']]));
  assert.deepEqual(out.records.map((r) => r.state), ['live', 'preregistration', 'preregistration']);
  assert.deepEqual(out.unknown, ['Хэн ч биш']);
});

test('item references name every conditioned piece, for the publish check', () => {
  assert.deepEqual(itemReferences([{ intent: 'price_overview', items: OVERVIEW_ITEMS }, { intent: 'y', items: null }]).map((r) => r.serviceId),
    [A, B, A, B, C]);
});
