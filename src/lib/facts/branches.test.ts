import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchLabel, foreignDetails, linkKey, phonesOf, renderBranchFindings, sharedDrift, staffKey, type BranchSide } from './branches.ts';

// Fictional branches: every number, name, address and link is invented.
const handoff = (phones: string) => `Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Та ${phones} дугаараар холбогдоно уу.`;

const person = (name: string, shortName: string | null = null) => ({ name, shortName });
function side(over: Partial<BranchSide> & { slug: string }): BranchSide {
  return { contacts: [], staff: [], branchName: null, texts: [], prices: [], bookingUrl: null, ...over };
}
const east = side({
  slug: 'demo-east',
  contacts: [
    { kind: 'phone', value: '99112233, 88114455' },
    { kind: 'maps_url', value: 'https://maps.app.goo.gl/EastDemoAbc12' },
    { kind: 'address', value: 'Баянзүрх дүүрэг, Нарны хорооллын 3-р байр' },
  ],
  staff: [person('Сарнай'), person('Г. Мөнхзаяа')],
  texts: [{ source: 'canned handoff', text: handoff('99112233 эсвэл 88114455') }],
  prices: [{ service: 'Үс засалт', variant: '', kind: 'exact', min: 25000, max: null }],
  bookingUrl: 'https://demo-brand.mn/',
});
const west = side({
  slug: 'demo-west',
  contacts: [
    { kind: 'phone', value: '7711-2233' },
    { kind: 'maps_url', value: 'https://maps.app.goo.gl/WestDemoXyz98' },
    { kind: 'address', value: 'Сонгинохайрхан дүүрэг, 3-р хороолол' },
  ],
  staff: [person('Уянга')],
  texts: [{ source: 'canned handoff', text: handoff('7711-2233') }],
  prices: [{ service: 'Үс засалт', variant: '', kind: 'exact', min: 25000, max: null }],
  bookingUrl: 'https://demo-brand.mn',
});

test('a branch built from its own form gives no other branch\'s details, and the shared facts agree', () => {
  assert.deepEqual(foreignDetails(west, east), []);
  assert.deepEqual(foreignDetails(east, west), []);
  assert.deepEqual(sharedDrift(west, east), [], 'a trailing slash is not a different booking link');
});

test('a row copied from the other branch is named, row by row, for its phone numbers', () => {
  const copied = { ...west, texts: [...west.texts, { source: 'canned refusal_topic', text: `Та ${'99112233'} эсвэл 88114455 дугаараар лавлана уу.` }] };
  const got = foreignDetails(copied, east);
  assert.deepEqual(got.map((f) => `${f.source}: ${f.detail}`), [
    "canned refusal_topic: carries demo-east's phone 99112233",
    "canned refusal_topic: carries demo-east's phone 88114455",
  ]);
  assert.ok(got.every((f) => f.kind === 'leak'));
});

test('a phone is digits only: spacing, hyphens and the country code are one number', () => {
  for (const text of ['9911 2233', '9911-2233', '+976 99112233', '(976) 9911-2233']) {
    const t = { ...west, texts: [{ source: 'faq «Утас»', text: `Утас: ${text}` }] };
    assert.equal(foreignDetails(t, east).length, 1, text);
  }
  assert.deepEqual(phonesOf('+976 9911-2233'), ['97699112233', '99112233']);
  // A price is not a phone.
  const priced = { ...west, texts: [{ source: 'faq «Үнэ»', text: 'Үс засалт 25,000₮, будалт 99,000₮' }] };
  assert.deepEqual(foreignDetails(priced, east), []);
});

test('the other branch\'s map link, address and staff are named', () => {
  const t = {
    ...west,
    texts: [
      { source: 'KB «Хаяг»', text: 'Байршил: maps.app.goo.gl/EastDemoAbc12.' },
      { source: 'faq «Хаана байдаг вэ?»', text: 'Бид баянзүрх дүүрэг,  нарны хорооллын 3-р байр-т байрладаг.' },
      { source: 'faq «Үсчин»', text: 'Мөнхзаяагаас асуугаарай.' },
    ],
  };
  assert.deepEqual(foreignDetails(t, east).map((f) => f.source), ['KB «Хаяг»', 'faq «Хаана байдаг вэ?»', 'faq «Үсчин»']);
  // A map link id is case-sensitive: another link is not a leak.
  const other = { ...west, texts: [{ source: 'KB', text: 'https://maps.app.goo.gl/eastdemoabc12' }] };
  assert.deepEqual(foreignDetails(other, east), []);
});

test('a detail both branches hold is named at the contact row, once', () => {
  const t = { ...west, contacts: [...west.contacts.filter((c) => c.kind !== 'phone'), { kind: 'phone', value: '7711-2233, 99112233' }], staff: [person('Уянга'), person('Сарнай')] };
  assert.deepEqual(foreignDetails(t, east).map((f) => `${f.source}: ${f.detail}`), [
    "contact_points phone: is also demo-east's phone 99112233",
    "staff_members «Сарнай»: is also on demo-east's staff",
  ]);
  assert.deepEqual(foreignDetails(t, east, ['Сарнай']).map((f) => f.source), ['contact_points phone'], 'allow_names exempts a shared person');
});

test('a staff name is a whole word, with or without a case ending, never a piece of another word', () => {
  assert.equal(staffKey('Г. Мөнхзаяа'), 'Мөнхзаяа');
  const inside = { ...west, texts: [{ source: 'KB', text: 'Сарнайн цэцэг' }] };
  assert.equal(foreignDetails(inside, east).length, 1, 'a case ending of the name is the name');
  const unrelated = { ...west, texts: [{ source: 'KB', text: 'Сарнайцэцэгхэлхээ' }] };
  assert.equal(foreignDetails({ ...unrelated }, { ...east, staff: [person('Сарх')] }).length, 0, 'a short name is not a prefix');
});

test('the other branch\'s name is named, unless it is allowed', () => {
  const e = { ...east, branchName: branchLabel('Demo Brand — Нарны') };
  const w = { ...west, branchName: branchLabel('Demo Brand — Хороолол') };
  const copied = { ...w, texts: [{ source: 'KB «Салбарууд»', text: 'Энэ хуудас бол Нарны салбарын хуудас.' }] };
  assert.deepEqual(foreignDetails(copied, e).map((f) => `${f.source}: ${f.detail}`), ["KB «Салбарууд»: names demo-east's branch name «Нарны»"]);
  assert.deepEqual(foreignDetails(copied, e, ['Нарны']), []);
  assert.equal(branchLabel('Demo Brand'), null);
  // A short name customers use is a staff name too.
  const nick = { ...west, texts: [{ source: 'KB', text: 'Сараа манай салбарт ажилладаг.' }] };
  assert.equal(foreignDetails(nick, { ...east, staff: [...east.staff, person('Сарангэрэл', 'Сараа')] }).length, 1);
});

test('two people with one first name are two people; a short name is never searched for', () => {
  const e = { ...east, staff: [person('Б. Сараа'), person('Нарантуяа', 'Нар')] };
  const w = { ...west, staff: [person('Г. Сараа')], texts: [{ source: 'KB', text: 'Сараа ажилладаг. Та нар ирээрэй.' }] };
  assert.deepEqual(foreignDetails(w, e), [], 'Сараа is also this branch\'s; «Нар» is too short to search for');
});

test('a phone written with a dash, a no-break space or spaces between two numbers is still the number', () => {
  for (const text of ['9911–2233', '9911\u00a02233', '9911 - 2233', '9911 — 2233']) {
    assert.equal(foreignDetails({ ...west, texts: [{ source: 'KB', text }] }, east).length, 1, JSON.stringify(text));
  }
  assert.deepEqual(phonesOf('7711 2233 9911 4455').filter((p) => p.length === 8), ['77112233', '99114455']);
});

test('a map link shared with a query string is the same link', () => {
  const t = { ...west, texts: [{ source: 'KB', text: 'https://maps.app.goo.gl/EastDemoAbc12?g_st=ic' }] };
  assert.equal(foreignDetails(t, east).length, 1);
  assert.equal(linkKey('https://demo-brand.mn/book?b=2', { query: true }), 'demo-brand.mn/book?b=2');
});

test('prices and the booking link that differ are named service by service', () => {
  const b = {
    ...west,
    prices: [
      { service: 'Үс засалт', variant: '', kind: 'exact', min: 30000, max: null },
      { service: 'Будалт', variant: 'урт', kind: 'range', min: 80000, max: 120000 },
    ],
    bookingUrl: 'https://demo-brand.mn/west',
  };
  const got = sharedDrift(east, b);
  assert.deepEqual(got.map((f) => `${f.source}: ${f.detail}`), [
    'price «Будалт» (урт): demo-east has no such row, demo-west 80,000₮–120,000₮',
    'price «Үс засалт»: demo-east 25,000₮, demo-west 30,000₮',
    'booking link: demo-east https://demo-brand.mn/, demo-west https://demo-brand.mn/west',
  ]);
  assert.ok(got.every((f) => f.kind === 'drift'));
  assert.match(renderBranchFindings('demo-west', 'demo', got), /0 row\(s\) with another branch's details, 3 shared fact\(s\) that differ/u);
});

test('link keys drop the scheme, www and a trailing slash, and keep the path exactly', () => {
  assert.equal(linkKey('https://www.Demo-Brand.mn/Book/'), 'demo-brand.mn/Book');
  assert.equal(linkKey('maps.app.goo.gl/AbC'), 'maps.app.goo.gl/AbC');
  assert.equal(linkKey('not a link'), null);
});
