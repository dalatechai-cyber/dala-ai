import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formBlocks, textBlocks } from './formFile.ts';
import {
  parseClock, parseDuration, parsePrice, parsePriceCell, readChoices, readQuestionnaire, FORM_FIELDS,
} from './questionnaire.ts';
import { listItems, phonesPhrase, planFromForm, type Templates } from './plan.ts';
import { generateCases, renderAmount, MEDIA_PROBE } from './cases.ts';
import { factsHash, gateStatus, onboardReadiness, wordingHash, type Facts, type Wording } from './onboardGates.ts';
import { validateIntake } from './validate.ts';
import { refuseForeignTenant } from './onboardWrite.ts';

const BLANK = 'scripts/onboard/fixtures/dali-form-v2-blank.docx';
const BLANK_V1 = 'scripts/onboard/fixtures/dali-form-blank.docx';
const SAMPLE = 'scripts/onboard/fixtures/sample-salon-branch.docx';
const templates = JSON.parse(readFileSync('scripts/provision/templates/onboarding.mn.json', 'utf8')) as Templates;
const read = (f: string) => {
  const r = readQuestionnaire(formBlocks(f, readFileSync(f)));
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.answers;
};
const sample = () => planFromForm(read(SAMPLE), { slug: 'tsetsegleg-demo', templates, facebookPageId: '990000000000001' });

// ---- the file -------------------------------------------------------------------------

test('the founder\'s real blank template reads as the questionnaire, every question found', () => {
  const a = read(BLANK);
  assert.equal(Object.keys(a.text).length + Object.keys(a.choices).length, Object.keys(FORM_FIELDS).length);
  assert.equal(a.services.length, 0, 'empty rows are not services');
  assert.equal(a.hours.length, 7);
});

test('the same template exported as text (Google Docs → Markdown) reads identically', () => {
  const md = readQuestionnaire(formBlocks('x.md', readFileSync('scripts/onboard/fixtures/dali-form-blank.md')));
  assert.ok(md.ok, JSON.stringify(!md.ok && md.problems));
  const docx = read(BLANK);
  assert.deepEqual(md.ok && Object.keys(md.answers.choices).sort(), Object.keys(docx.choices).sort());
  assert.deepEqual(md.ok && md.answers.hours, docx.hours);
});

test('EVERY answer filled into the form the founder sends clients is read back, none dropped', () => {
  // The sample is filled into «Дали_маягт_DalaTech.docx» (2026-09-27) by fixtures/fill.ts;
  // this compares the reader's result with the answers file, field by field.
  const want = JSON.parse(readFileSync('scripts/onboard/fixtures/sample-salon-branch.answers.json', 'utf8')) as {
    text: Record<string, string>; tick: Record<string, string[]>;
    tables: { hours: string[][]; services: string[][]; staff: string[][]; faqs: string[][]; signer: string[] };
  };
  const a = read(SAMPLE);
  const unread: string[] = [];
  const norm = (x: string) => x.replace(/\s+/gu, ' ').trim();
  for (const [id, v] of Object.entries(want.text)) if (norm(a.text[id] ?? '') !== norm(v)) unread.push(`text ${id}`);
  for (const [id, ticks] of Object.entries(want.tick)) {
    for (const t of ticks) {
      const [label, extra] = t.split('|');
      const c = (a.choices[id] ?? []).find((x) => x.label.startsWith(label!.slice(0, 6)));
      if (c?.checked !== true || (extra !== undefined && c.extra !== extra)) unread.push(`tick ${id} ${t}`);
    }
    const ticked = (a.choices[id] ?? []).filter((x) => x.checked).length;
    if (ticked !== ticks.length) unread.push(`tick ${id}: ${ticked} ticked, ${ticks.length} filled`);
  }
  want.tables.hours.forEach((r, i) => { if (a.hours[i]?.opens !== r[1] || a.hours[i]?.closes !== r[2]) unread.push(`hours row ${i}`); });
  const rowsOf = (t: string[][]) => t.map((r) => norm(r.map(norm).join(' | ')));
  assert.deepEqual(a.services.map((s) => norm([s.name, s.price, s.duration, s.note].join(' | '))), rowsOf(want.tables.services));
  assert.deepEqual(a.staff.map((s) => norm([s.name, s.grade, s.branch, s.active].join(' | '))), rowsOf(want.tables.staff));
  assert.deepEqual(a.faqs.map((f) => norm([f.question, f.answer].join(' | '))), rowsOf(want.tables.faqs));
  assert.deepEqual([a.signer.name, a.signer.title, a.signer.date, a.signer.phone], want.tables.signer);
  assert.deepEqual(unread, []);
});

test('the earlier Drive template and the form sent to clients read identically', () => {
  assert.deepEqual(formBlocks('a.docx', readFileSync(BLANK)), formBlocks('b.docx', readFileSync(BLANK_V1)));
});

test('boxes marked the ways clients mark them: ✓, [x], X, or the answer typed beside them', () => {
  assert.equal(readChoices('✓  Тийм\n☐  Үгүй')?.[0]?.checked, true);
  assert.equal(readChoices('[x] Тийм\n[ ] Үгүй')?.[0]?.checked, true);
  assert.equal(readChoices('X  Тийм\n☐  Үгүй')?.[0]?.checked, true);
  assert.deepEqual(readChoices('☐  Тийм\n☐  Үгүй\nҮгүй')?.map((c) => c.checked), [false, true], 'typed «Үгүй» picks Үгүй');
  assert.deepEqual(readChoices('☐  Тийм\n☐  Үгүй\nмэдэхгүй')?.map((c) => c.checked), [false, false], 'an unmatched word ticks nothing');
  // The boxes deleted and «Тийм» typed in their place.
  const md = readFileSync('scripts/onboard/fixtures/dali-form-blank.md', 'utf8')
    .replace(/(\| \\\*\\\*2\.2 [^|]*\| )[^|]*\|/u, '$1Тийм |');
  const r = readQuestionnaire(textBlocks(md));
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.answers.choices['2.2']?.map((c) => [c.label, c.checked]), [['Тийм', true]]);
});

test('a form whose numbering changed is REFUSED, never read by position (D-057)', () => {
  const md = '| **1.5 Утас** | 9911 |\n| **1.1 Байгууллагын нэр** | X |\n';
  const r = readQuestionnaire(textBlocks(md));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.some((p) => p.where === '1.5' && p.detail.includes('Хаяг')));
});

test('a file that is not a Word document says so', () => {
  assert.throws(() => formBlocks('x.docx', Buffer.from('not a zip')), /not a zip/);
  assert.throws(() => formBlocks('x.pdf', Buffer.from('')), /expected a \.docx/);
});

test('the Markdown export reads the same tables as the .docx', () => {
  const md = [
    '| **1.1 Байгууллагын нэр**\\*Үйлчлүүлэгчид хэрхэн дууддаг вэ\\* | Цэцэглэг |',
    '| :-: | :-: |',
    '| **2.1 Сувгууд** | ☒  Facebook Messenger<br>☐  Instagram (хаяг: ........) |',
  ].join('\n');
  const t = textBlocks(md);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0]!.type === 'table' && t[0]!.rows[1], ['2.1 Сувгууд', '☒  Facebook Messenger\n☐  Instagram (хаяг: ........)']);
});

// ---- the answers ------------------------------------------------------------------------

test('a ticked box is the answer; an unticked one is not; the blank beside it is the client\'s text', () => {
  const c = readChoices('☒  Facebook Messenger\n☒  Instagram (хаяг: @demo)\n☐  Вэбсайтын чат (хаяг: ......)');
  assert.deepEqual(c?.map((x) => [x.label, x.checked, x.extra]), [
    ['Facebook Messenger', true, ''], ['Instagram (хаяг', true, '@demo'], ['Вэбсайтын чат (хаяг', false, ''],
  ]);
});

test('prices: exact, range, from and tiers read; anything else is null, never a guess', () => {
  assert.deepEqual(parsePrice('55,000₮'), { kind: 'exact', min: '55000' });
  assert.deepEqual(parsePrice('55 000 ₮'), { kind: 'exact', min: '55000' });
  assert.deepEqual(parsePrice('176,000–200,000₮'), { kind: 'range', min: '176000', max: '200000' });
  assert.deepEqual(parsePrice('45,000₮-аас'), { kind: 'from', min: '45000' });
  assert.deepEqual(parsePrice('Үзлэгээр'), { kind: 'on_inspection' });
  assert.equal(parsePrice('55,000 эсвэл 60,000'), null);
  assert.equal(parsePrice('200,000–100,000'), null, 'a backwards range is not a range');
  assert.equal(parsePrice('асуугаарай'), null);
  assert.deepEqual(parsePriceCell('Мастер: 60,000₮\n1-р зэрэг: 45,000₮')?.map((v) => v.variantKey), ['Мастер', '1-р зэрэг']);
  assert.equal(parsePriceCell('Мастер: 60,000₮\nбусад'), null, 'one unreadable tier refuses the cell');
  // A plain price beside a tier (Tara's «Эрэгтэй тайралт»: 69,000₮, SPECIAL 89,000₮).
  assert.deepEqual(parsePriceCell('69,000₮\nSPECIAL: 89,000₮'), [
    { variantKey: '', price: { kind: 'exact', min: '69000' } },
    { variantKey: 'SPECIAL', price: { kind: 'exact', min: '89000' } },
  ]);
  assert.equal(parsePriceCell('69,000₮\n75,000₮'), null, 'two plain prices are two answers, not two tiers');
  assert.equal(parsePriceCell('Угаалт орсон\nМастер: 60,000₮'), null, 'a note in the price cell is not a price');
  assert.equal(parsePriceCell(': 60,000₮\nМастер: 70,000₮'), null, 'an empty tier name is not the plain price');
  assert.equal(parsePriceCell('Мастер: 60,000₮\nҮзлэгээр нэмэгдэж болно'), null, 'a note under a tier is not an on-inspection price');
  assert.equal(parsePriceCell('Мастер: 60,000₮\n45,000₮-аас'), null, 'beside tiers the plain line is an exact price or nothing');
});

test('times and durations', () => {
  assert.equal(parseClock('10:00'), '10:00');
  assert.equal(parseClock('9 цаг'), '09:00');
  assert.equal(parseClock('24:00'), '23:59');
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseDuration('1.5 цаг'), 90);
  assert.equal(parseDuration('1 цаг 30 мин'), 90);
  assert.equal(parseDuration('45 мин'), 45);
  assert.equal(parseDuration('2-3 цаг'), null);
});

// ---- the plan ---------------------------------------------------------------------------

test('the sample: every fact the client gave becomes a row, in their words', () => {
  const p = sample();
  assert.equal(p.intake.business.vertical, 'salon');
  assert.equal(p.intake.services.length, 7, 'the service with no price is not written with an invented one');
  assert.deepEqual(p.intake.hours.find((h) => h.weekday === 0), { weekday: 0, opens: null, closes: null, closed: true });
  assert.equal(p.intake.contacts.find((c) => c.kind === 'maps_url')?.value, 'https://maps.app.goo.gl/TsetseglegDemo3x');
  assert.ok(!p.intake.contacts.find((c) => c.kind === 'address')?.value.includes('http'), 'the link is not part of the address');
  assert.equal(p.staff.length, 4);
  assert.deepEqual(p.staff.find((s) => s.name === 'Нарантуяа')?.shortName, 'Наран');
  assert.equal(p.deposits[0]?.ruleText.includes('20,000₮'), true);
  assert.equal(p.intake.confirmedBy, null, 'the form is not the client\'s confirmation of the facts');
});

test('the missing answer is recorded and holds readiness; nothing is filled in', () => {
  const p = sample();
  const price = p.missing.find((m) => m.code === 'price');
  assert.equal(price?.subject, 'Сормуус суулгалт');
  assert.equal(price?.holdsReady, true);
  const r = onboardReadiness(p, { wording: { signed: true, pending: 0, id: 'w' }, facts: { confirmed: true, unconfirmed: 0, id: 'f' } }, new Date());
  assert.equal(r.stage, 'knowledge', 'a missing price holds the tenant even with both gates passed');
  assert.ok(r.waitingOn[0]?.includes('Сормуус суулгалт'), 'what holds the tenant leads the daily line');
});

test('the two similar service names are flagged before any customer meets them', () => {
  const f = validateIntake(sample().intake).filter((x) => x.code === 'service_name_collision');
  assert.equal(f.length, 1);
  assert.ok(f[0]!.detail.includes('Хумс будалт') && f[0]!.detail.includes('Гель хумс будалт'));
});

test('sentences are drafted from templates, with the client\'s phones, and no emoji when they said no', () => {
  const p = sample();
  assert.ok(p.intake.sentences['handoff']?.includes('7711-2233 эсвэл 9911-4455'));
  assert.equal(/\p{Extended_Pictographic}/u.test(Object.values(p.intake.sentences).join(' ')), false);
  assert.deepEqual(p.replyStyle, { max_emoji: 0 });
  assert.equal(p.wording.find((w) => w.kind === 'handover_notice')?.alreadyApprovedBytes, false,
    'the emoji-less media line is NOT the approved bytes, and says so');
  assert.equal(p.wording.find((w) => w.kind === 'refusal_health')?.alreadyApprovedBytes, true);
  assert.ok(p.intake.sentences['refusal_staff_schedule']?.startsWith('Үсчдийн'), 'a salon gets the salon line');
  // Founder, 2026-09-27: the approved wordings, filled with THIS client's data.
  assert.equal(p.intake.sentences['assistant_identity'],
    'Би Цэцэглэг Салон-ийн AI туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуух зүйл байвал бичээрэй.');
  assert.equal(p.intake.sentences['booking_line'], 'Цагаа онлайнаар захиалах бол: https://tsetsegleg-demo.mn/booking');
  assert.equal(p.intake.sentences['comment_public_reply'],
    'Сайн байна уу! Манай хуудас руу мессеж бичвэл дэлгэрэнгүй хариулъя', 'no-emoji client: the 😊 is dropped');
  // A photo, a video or a link gets the media line and the hand-off, as for the live tenants.
  assert.equal(p.intake.sentences['image_received'], undefined);
  assert.ok(p.intake.sentences['handover_notice'] !== undefined);
  assert.ok(p.wording.every((w) => w.templateApproved === '2026-09-27'));
});

test('a business outside the known verticals gets the neutral lines and an operator question', () => {
  const a = read(SAMPLE);
  const p = planFromForm({ ...a, text: { ...a.text, '1.2': 'Авто угаалга' } }, { slug: 'x', templates });
  assert.equal(p.vertical.value, 'auto_service');
  const q = planFromForm({ ...a, text: { ...a.text, '1.1': 'Мөнх Ном', '1.2': 'Ном худалдаа' } }, { slug: 'x', templates });
  assert.equal(q.vertical.value, 'general');
  assert.ok(q.intake.sentences['refusal_staff_schedule']?.startsWith('Ажилтнуудын'));
  assert.ok(!Object.values(q.intake.sentences).join(' ').includes('Салон'), 'no salon word for a bookshop');
  assert.ok(q.missing.some((m) => m.question === '1.2' && m.audience === 'operator'));
});

test('no Page id: the channel is not created and the operator is asked', () => {
  const p = planFromForm(read(SAMPLE), { slug: 'x', templates });
  assert.equal(p.channels.find((c) => c.provider === 'facebook_page')?.externalId, null);
  assert.ok(p.missing.some((m) => m.question === '11.1' && m.audience === 'operator' && m.holdsReady));
});

test('a blank form writes no sentence it cannot finish: no phone, no handoff, stage routing', () => {
  const p = planFromForm(read(BLANK), { slug: 'blank', templates });
  assert.equal(p.intake.sentences['handoff'], undefined);
  const r = onboardReadiness(p, null, new Date());
  assert.equal(r.stage, 'routing');
  assert.ok(p.missing.some((m) => m.question === '1.6'));
});

test('never-say answers become whole-phrase rules — «хүүхдийн үнэ» never fires on «үнэ»', () => {
  const p = sample();
  const w = p.intake.neverSay.find((n) => n.key === 'withhold_1');
  assert.deepEqual(w?.stems, ['хүүхдийн үнэ']);
  assert.equal(p.intake.neverSay.filter((n) => n.responseKind === 'handoff').length, 2);
  assert.deepEqual(listItems('гомдол, буцаалт; хүүхдийн үнэ.'), ['гомдол', 'буцаалт', 'хүүхдийн үнэ']);
  assert.equal(phonesPhrase('7711-2233, 9911-4455'), '7711-2233 эсвэл 9911-4455');
});

// ---- the cases ---------------------------------------------------------------------------

test('reply cases ask for the figures as the platform renders them', () => {
  const p = sample();
  const cs = generateCases(p.intake, p.deposits);
  assert.equal(renderAmount('60000'), '60,000₮');
  assert.deepEqual(cs.find((c) => c.id === 'price_1')?.mustInclude, ['60,000₮', '45,000₮']);
  assert.deepEqual(cs.find((c) => c.id === 'deposit_1')?.mustInclude, ['20,000₮']);
  const media = cs.find((c) => c.id === 'media_link');
  assert.equal(media?.message, MEDIA_PROBE);
  assert.equal(media?.expectedBody, p.intake.sentences['handover_notice']);
  for (const c of cs) {
    assert.ok(c.expectedBody !== null || c.mustInclude.length + c.mustNotInclude.length > 0, `${c.id} asserts something`);
  }
});

// ---- the gates ---------------------------------------------------------------------------

const FACTS: Facts = {
  services: [{ name: 'А', durationMinutes: 60, variants: [{ key: '', kind: 'exact', min: '1000', max: '', confirmed: false }] }],
  hours: [], contacts: [], bookingUrl: null, deposits: [], staff: [],
  faqs: [{ question: 'Q', answer: 'A', confirmed: false }], documents: [],
};

test('the summary id covers the facts and not their confirmation; any changed fact changes it', () => {
  const confirmed: Facts = {
    ...FACTS,
    services: [{ ...FACTS.services[0]!, variants: [{ ...FACTS.services[0]!.variants[0]!, confirmed: true }] }],
    faqs: [{ ...FACTS.faqs[0]!, confirmed: true }],
  };
  assert.equal(factsHash(FACTS), factsHash(confirmed));
  const changed: Facts = { ...FACTS, faqs: [{ question: 'Q', answer: 'B', confirmed: false }] };
  assert.notEqual(factsHash(FACTS), factsHash(changed));
});

test('the sheet id covers every line shown; a gate passes only while what was signed is what is there', () => {
  const w: Wording = { lines: [{ kind: 'handoff', locale: 'mn-MN', body: 'x', signed: false }], modelVisible: [] };
  const w2: Wording = { ...w, lines: [{ kind: 'handoff', locale: 'mn-MN', body: 'x ', signed: false }] };
  assert.notEqual(wordingHash(w), wordingHash(w2), 'one space is a different line (D-077)');
  const signedW: Wording = { lines: [{ kind: 'handoff', locale: 'mn-MN', body: 'x', signed: true }], modelVisible: [] };
  assert.equal(wordingHash(w), wordingHash(signedW), 'signing does not move the id');
  const id = gateStatus(signedW, FACTS, { wording: null, facts: null }).wording.id;
  assert.equal(gateStatus(signedW, FACTS, { wording: id, facts: null }).wording.signed, true);
  assert.equal(gateStatus(w, FACTS, { wording: id, facts: null }).wording.signed, false, 'a pending line is not signed');
  const ruleChanged: Wording = { ...signedW, modelVisible: [{ where: 'rule never_1', text: 'new' }] };
  assert.equal(gateStatus(ruleChanged, FACTS, { wording: id, facts: null }).wording.signed, false,
    'a changed rule question re-opens the founder\'s gate');
  assert.equal(gateStatus({ lines: [], modelVisible: [] }, FACTS, { wording: 'x', facts: null }).wording.signed, false,
    'no lines at all is not a signed sheet');
});

test('the client\'s gate re-opens when ANY fact changes, not only a price (reviewer, 2026-09-27)', () => {
  const confirmed: Facts = {
    ...FACTS,
    services: [{ ...FACTS.services[0]!, variants: [{ ...FACTS.services[0]!.variants[0]!, confirmed: true }] }],
    faqs: [{ ...FACTS.faqs[0]!, confirmed: true }],
  };
  const id = gateStatus({ lines: [], modelVisible: [] }, confirmed, { wording: null, facts: null }).facts.id;
  assert.equal(gateStatus({ lines: [], modelVisible: [] }, confirmed, { wording: null, facts: id }).facts.confirmed, true);
  const newHours: Facts = { ...confirmed, hours: [{ weekday: 1, opens: '09:00', closes: '20:00', closed: false }] };
  assert.equal(gateStatus({ lines: [], modelVisible: [] }, newHours, { wording: null, facts: id }).facts.confirmed, false);
});

// ---- the live tenants ----------------------------------------------------------------------

function stubDb(t: { tenant: Record<string, unknown>; channels?: unknown[]; steps?: unknown[]; revisions?: unknown[]; canned?: unknown[]; identities?: unknown[] }) {
  const chain = (data: unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'not', 'limit']) c[m] = () => c;
    c['maybeSingle'] = async () => ({ data, error: null });
    c['then'] = (res: (v: unknown) => unknown) => res({ data, error: null });
    return c;
  };
  const by: Record<string, unknown> = {
    tenants: t.tenant, tenant_channels: t.channels ?? [], onboarding_steps: t.steps ?? [],
    config_revisions: t.revisions ?? [], canned_responses: t.canned ?? [], channel_identity: t.identities ?? [],
  };
  return { from: (name: string) => chain(by[name]) } as never;
}
const T = { id: 't-1', slug: 'x', live_revision_id: null };
const shadow = [{ provider: 'facebook_page', external_id: '1', delivery_mode: 'shadow', went_live_at: null }];

test('a tenant that has ever been live is refused before anything is written', async () => {
  await assert.rejects(refuseForeignTenant(stubDb({ tenant: T, channels: [{ ...shadow[0], delivery_mode: 'live' }] }), 'x'), /has been live/);
  await assert.rejects(refuseForeignTenant(stubDb({ tenant: T, channels: [{ ...shadow[0], went_live_at: '2026-09-06' }] }), 'x'), /has been live/);
});

test('a tenant onboarding did not create is refused, even in shadow — Tara\'s case (reviewer, 2026-09-27)', async () => {
  // Tara sits in shadow with a published revision and signed lines: not ours, never written.
  await assert.rejects(refuseForeignTenant(stubDb({ tenant: { ...T, live_revision_id: 'rev-9' }, channels: shadow }), 'x'), /not created by onboarding/);
  await assert.rejects(refuseForeignTenant(stubDb({ tenant: T, channels: shadow, canned: [{ kind: 'handoff' }] }), 'x'), /not created by onboarding/);
  await assert.rejects(refuseForeignTenant(stubDb({ tenant: T, channels: shadow, identities: [{ id: 'i' }] }), 'x'), /not created by onboarding/);
  // Ours: the step is recorded — even after its own shadow publish.
  assert.deepEqual(await refuseForeignTenant(stubDb({ tenant: { ...T, live_revision_id: 'rev-1' }, channels: shadow, steps: [{ step_key: 'onboard_command' }] }), 'x'), { tenantId: 't-1' });
  // A first run that died after creating the tenant, before recording it: nothing of its own yet.
  assert.deepEqual(await refuseForeignTenant(stubDb({ tenant: T }), 'x'), { tenantId: 't-1' });
});
