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
import { refuseIfEverLive } from './onboardWrite.ts';

const BLANK = 'scripts/onboard/fixtures/dali-form-blank.docx';
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
});

test('a business outside the known verticals gets the neutral lines and an operator question', () => {
  const a = read(SAMPLE);
  const p = planFromForm({ ...a, text: { ...a.text, '1.2': 'Авто угаалга' } }, { slug: 'x', templates });
  assert.equal(p.vertical.value, 'auto_service');
  const q = planFromForm({ ...a, text: { ...a.text, '1.2': 'Ном худалдаа' } }, { slug: 'x', templates });
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

test('the sheet id covers every line shown; a gate is passed only when nothing is pending', () => {
  const w: Wording = { pending: [{ kind: 'handoff', body: 'x' }], signedCount: 0, modelVisible: [] };
  const w2: Wording = { ...w, pending: [{ kind: 'handoff', body: 'x ' }] };
  assert.notEqual(wordingHash(w), wordingHash(w2), 'one space is a different line (D-077)');
  const g = gateStatus(w, FACTS);
  assert.equal(g.wording.signed, false);
  assert.equal(g.facts.confirmed, false);
  assert.equal(g.facts.unconfirmed, 2);
  assert.equal(gateStatus({ pending: [], signedCount: 0, modelVisible: [] }, FACTS).wording.signed, false,
    'no lines at all is not a signed sheet');
});

// ---- the live tenants ----------------------------------------------------------------------

function stubDb(channels: unknown[]) {
  const chain = (data: unknown): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) c[m] = () => c;
    c['maybeSingle'] = async () => ({ data, error: null });
    c['then'] = (res: (v: unknown) => unknown) => res({ data, error: null });
    return c;
  };
  return { from: (t: string) => (t === 'tenants' ? chain({ id: 't-1', slug: 'x' }) : chain(channels)) } as never;
}

test('a tenant that has ever been live is refused before anything is written', async () => {
  await assert.rejects(refuseIfEverLive(stubDb([{ provider: 'facebook_page', external_id: '1', delivery_mode: 'live', went_live_at: null }]), 'x'), /has been live/);
  await assert.rejects(refuseIfEverLive(stubDb([{ provider: 'facebook_page', external_id: '1', delivery_mode: 'shadow', went_live_at: '2026-09-06' }]), 'x'), /has been live/);
  assert.deepEqual(await refuseIfEverLive(stubDb([{ provider: 'facebook_page', external_id: '1', delivery_mode: 'shadow', went_live_at: null }]), 'x'), { tenantId: 't-1' });
});
