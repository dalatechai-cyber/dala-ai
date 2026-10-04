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

test('a shared line in allow_phones may be held and said by every branch; every other phone stays the branch\'s own', () => {
  // East's second number is the brand's shared line; west holds it too and says it.
  const t = {
    ...west,
    contacts: [...west.contacts.filter((c) => c.kind !== 'phone'), { kind: 'phone', value: '7711-2233, +976 8811 4455' }],
    texts: [{ source: 'canned handoff', text: handoff('7711-2233 эсвэл 8811-4455') }],
  };
  assert.deepEqual(foreignDetails(t, east).map((f) => f.source), ['contact_points phone'], 'without the allowance the shared line is a leak');
  assert.deepEqual(foreignDetails(t, east, [], ['88114455']), [], 'held and said by both: allowed');
  assert.deepEqual(foreignDetails(t, east, [], ['8811 4455']), [], 'written with spaces: the same number');
  const said = { ...west, texts: [{ source: 'canned handoff', text: handoff('7711-2233 эсвэл 88114455 эсвэл 99112233') }] };
  assert.deepEqual(foreignDetails(said, east, [], ['88114455']).map((f) => `${f.source}: ${f.detail}`),
    ["canned handoff: carries demo-east's phone 99112233"], 'east\'s own line is still a leak');
});

test('D-170: an address in allow_addresses may be given by another branch; the branch name needs allow_names', () => {
  const says = { ...west, texts: [{ source: 'fixed reply branch', text: 'Нарны салбарын хаяг: Баянзүрх дүүрэг, Нарны хорооллын 3-р байр. Утас: 7711-2233' }] };
  const e = { ...east, branchName: 'Нарны' };
  assert.deepEqual(foreignDetails(says, e).map((f) => f.detail).sort(), [
    "carries demo-east's address «баянзүрх дүүрэг, нарны хорооллын 3-р байр»",
    "names demo-east's branch name «Нарны»",
  ]);
  assert.deepEqual(foreignDetails(says, e, ['Нарны'], [], ['Баянзүрх дүүрэг, Нарны хорооллын 3-р байр']), []);
  // Any other detail of that branch is still a leak.
  const more = { ...says, texts: [...says.texts, { source: 'KB', text: 'Утас 99112233' }] };
  assert.deepEqual(foreignDetails(more, e, ['Нарны'], [], ['Баянзүрх дүүрэг, Нарны хорооллын 3-р байр']).map((f) => f.source), ['KB']);
  // Saying it is allowed; holding it as this branch's own address is not.
  const held = { ...west, contacts: [...west.contacts.filter((c) => c.kind !== 'address'), { kind: 'address', value: 'Баянзүрх дүүрэг, Нарны хорооллын 3-р байр' }] };
  assert.deepEqual(foreignDetails(held, e, ['Нарны'], [], ['Баянзүрх дүүрэг, Нарны хорооллын 3-р байр']).map((f) => f.source), ['contact_points address']);
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

test('a branch may leave out a variant it does not offer, and only that one', () => {
  const lvl = (variant: string, min: number) => ({ service: 'Эмэгтэй тайралт', variant, kind: 'exact', min, max: null });
  const full = { ...east, prices: [lvl('Мастер', 99000), lvl('1-р зэрэг', 66000)] };
  const lean = { ...west, bookingUrl: east.bookingUrl, prices: [lvl('Мастер', 99000)] };
  const omit = { 'demo-west': [{ service: null, variant: '1-р зэрэг' }] };
  // Without the configuration the missing row is drift, both ways round.
  assert.equal(sharedDrift(lean, full).length, 1);
  // With it, nothing differs, from either side.
  assert.deepEqual(sharedDrift(lean, full, omit), []);
  assert.deepEqual(sharedDrift(full, lean, omit), []);
  // Every price it does carry still has to agree: a changed Мастер price is drift.
  const cheaper = { ...lean, prices: [lvl('Мастер', 88000)] };
  assert.deepEqual(sharedDrift(cheaper, full, omit).map((f) => f.source), ['price «Эмэгтэй тайралт» (Мастер)']);
  // A row for the variant it says it does not offer is drift, even at the sibling's price.
  const said = sharedDrift(full, { ...full, slug: 'demo-west' }, omit);
  assert.equal(said.length, 1);
  assert.match(said[0]!.detail, /demo-west carries 66,000₮ for «1-р зэрэг», which it does not offer/u);
  // The OTHER branch is not excused: east missing the row west has is still drift.
  assert.equal(sharedDrift({ ...east, prices: [] }, { ...west, bookingUrl: east.bookingUrl, prices: [lvl('Мастер', 99000)] }, omit).length, 1);
});

test('a service-scoped omission leaves the same variant of every other service compared', () => {
  const row = (service: string, variant: string, min: number) => ({ service, variant, kind: 'exact', min, max: null });
  const full = { ...east, prices: [row('Эрэгтэй тайралт', 'SPECIAL', 89000), row('Эмэгтэй тайралт', 'SPECIAL', 120000)] };
  const lean = { ...west, bookingUrl: east.bookingUrl, prices: [row('Эмэгтэй тайралт', 'SPECIAL', 120000)] };
  const omit = { 'demo-west': [{ service: 'Эрэгтэй тайралт', variant: 'SPECIAL' }] };
  assert.deepEqual(sharedDrift(lean, full, omit), []);
  // The women's SPECIAL row is NOT excused: missing it is still drift.
  assert.equal(sharedDrift({ ...lean, prices: [] }, full, omit).length, 1);
});

test('the other branch\'s name and address are exempt only in the rows named for it', () => {
  const sayer = {
    ...west, branchName: 'Баруун',
    texts: [
      { source: 'KB «Салбарууд»', text: 'Зүүн салбарын хаяг: Баянзүрх дүүрэг, Нарны хорооллын 3-р байр.' },
      { source: 'faq «Хаяг?»', text: 'Энэ хуудас бол Зүүн салбарын хуудас. Баянзүрх дүүрэг, Нарны хорооллын 3-р байр.' },
    ],
  };
  const named = { ...east, branchName: 'Зүүн' };
  const allowAddr = ['Баянзүрх дүүрэг, Нарны хорооллын 3-р байр'];
  // Allowed everywhere (no scope): nothing.
  assert.deepEqual(foreignDetails(sayer, named, ['Зүүн'], [], allowAddr), []);
  // Scoped to «Салбарууд»: the FAQ's name and address are leaks, the document's are not.
  const got = foreignDetails(sayer, named, ['Зүүн'], [], allowAddr, ['KB «Салбарууд»']);
  assert.deepEqual(got.map((f) => f.source), ['faq «Хаяг?»', 'faq «Хаяг?»']);
  assert.ok(got.some((f) => /address/u.test(f.detail)) && got.some((f) => /other_branch_in/u.test(f.detail)));
});

test('say_phones: the other branch\'s own number may be said only in the rows named for it, never held', () => {
  // No shared line: west's «Салбарууд» gives east's own numbers; an FAQ that does is a leak.
  const sayer = {
    ...west,
    texts: [
      { source: 'KB «Салбарууд»', text: 'Зүүн салбарын утас: 99112233, 88114455.' },
      { source: 'faq «Утас?»', text: 'Та 99112233 дугаараар холбогдоно уу.' },
    ],
  };
  const say = ['99112233', '88114455'];
  assert.deepEqual(foreignDetails(sayer, east, [], [], [], ['KB «Салбарууд»'], say).map((f) => `${f.source}: ${f.detail}`),
    ["faq «Утас?»: carries demo-east's phone 99112233"], 'said in the named row: allowed; anywhere else: a leak');
  assert.equal(foreignDetails(sayer, east, [], [], [], null, say).length, 3, 'unscoped, say_phones excuses nothing (two numbers in «Салбарууд», one in the FAQ)');
  assert.equal(foreignDetails(sayer, east, [], [], [], ['KB «Салбарууд»']).length, 3, 'without say_phones every number is a leak');
  const holder = { ...west, contacts: [...west.contacts.filter((c) => c.kind !== 'phone'), { kind: 'phone', value: '7711-2233, 99112233' }], texts: [] };
  assert.deepEqual(foreignDetails(holder, east, [], [], [], ['KB «Салбарууд»'], say).map((f) => f.source), ['contact_points phone'], 'never held');
});

test('link keys drop the scheme, www and a trailing slash, and keep the path exactly', () => {
  assert.equal(linkKey('https://www.Demo-Brand.mn/Book/'), 'demo-brand.mn/Book');
  assert.equal(linkKey('maps.app.goo.gl/AbC'), 'maps.app.goo.gl/AbC');
  assert.equal(linkKey('not a link'), null);
});
