// The founder's 2026-09-24 list, B1–B8, through the real `handleReception`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_LABELS } from '../prompt/tenant.ts';
import { handleReception, type ReceptionDeps, type ReceptionInput } from './handle.ts';
import type { CallOutcome, ReceptionRequest } from '../model/reception.ts';
import type { GateRule } from '../gate/match.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';
import type { TenantGuardView } from '../guard/outbound.ts';

const R = '2026-09-18T00:00:00Z';
const TARA = 'Тийм, манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ.';
const QUESTION = 'Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?';
const SUITABILITY = 'Уучлаарай, энэ таны үсэнд тохирох эсэхийг би шийдэж өгөх боломжгүй.';
const BOOKING = 'Та манай вэбсайтаар онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
const UNLISTED = 'Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна.';
const IMAGE = 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
const CANNED = [
  { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: R },
  { kind: 'refusal_suitability', body: SUITABILITY, reviewedAt: R },
  { kind: 'booking_line', body: BOOKING, reviewedAt: R },
  { kind: 'refusal_price_unlisted', body: UNLISTED, reviewedAt: R },
  { kind: 'image_received', body: IMAGE, reviewedAt: R },
];

const ROWS = {
  root: 'Үсний угийн будаг: 135,000₮',
  mid: 'Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮',
  long: 'Урт үсний будаг (мөр давсан урттай үс): 200,000₮',
  sor: 'Сор: 120,000₮–190,000₮',
  office: 'Оффис колор: 380,000₮–460,000₮',
  bleach: 'Цайруулалт: 430,000₮–570,000₮',
  usan: 'Усан хими: 132,000₮–154,000₮',
  archilt: 'Хими арчилт: 154,000₮',
  emch: 'Эмчилгээний хими: 220,000₮–255,000₮',
  womenM: 'Эмэгтэй тайралт (Мастер): 66,000₮–88,000₮',
  womenF: 'Эмэгтэй тайралт (1-р зэрэг): 55,000₮',
};
const SERVICES = [
  { name: 'Дунд үсний будаг', prices: ['176000'], rows: [ROWS.mid] },
  { name: 'Оффис колор', prices: ['380000', '460000'], rows: [ROWS.office] },
  { name: 'Сор', prices: ['120000', '190000'], rows: [ROWS.sor] },
  { name: 'Цайруулалт', prices: ['430000', '570000'], rows: [ROWS.bleach] },
  { name: 'Усан хими', prices: ['132000', '154000'], rows: [ROWS.usan] },
  { name: 'Хими арчилт', prices: ['154000'], rows: [ROWS.archilt] },
  { name: 'Эмчилгээний хими', prices: ['220000', '255000'], rows: [ROWS.emch] },
  { name: 'Эмэгтэй тайралт', prices: ['66000', '88000', '55000'], rows: [ROWS.womenM, ROWS.womenF] },
  { name: 'Урт үсний будаг', prices: ['200000'], rows: [ROWS.long] },
  { name: 'Үсний угийн будаг', prices: ['135000'], rows: [ROWS.root] },
];
const DOC = 'Будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно.';
const STABLE = `GATE\n=== ${SECTION_LABELS.dataMarker} ===\n=== ҮНИЙН ЖАГСААЛТ ===\n`
  + Object.values(ROWS).map((r) => `- ${r}`).join('\n') + `\n=== ТАНИЛЦУУЛГА ===\n${DOC}`
  // Since D-058 the reviewed lines are IN the prefix, so a refusal row is the tenant's own words.
  + `\n=== БЭЛЭН ХАРИУЛТ ===\n` + CANNED.filter((c) => c.kind !== 'image_received').map((c) => `- ${c.kind}: ${c.body}`).join('\n');

const ALIASES = [
  { name: 'Эмчилгээний хими', alias: 'himi' }, { name: 'Үсний угийн будаг', alias: 'өнгө' },
  { name: 'Үсний угийн будаг', alias: 'budaad' }, { name: 'Цайруулалт', alias: 'цайруул' },
];
const DEPOSITS = ['Мастер үсчин: 20,000₮', '1-р зэргийн үсчин: 10,000₮'];
const confirmed = { requiresEmptyHistory: false, provenance: 'tenant_confirmed', enabled: true } as const;
const TARA_NAME: DeterministicRule = {
  ...confirmed, intent: 'tara_name', body: TARA, matchMode: 'covers_message',
  stems: ['tara', 'тара'], coverWords: ['энэ', 'салон', 'мөн', 'үү'], placement: 'replace', quoteServices: [],
};
const TARA_APPEND: DeterministicRule = {
  ...confirmed, intent: 'tara_rebrand', body: TARA, matchMode: 'contains_stem',
  stems: ['tara', 'тара', 'hayag', 'хаяг'], coverWords: [], placement: 'append', quoteServices: [],
};
const DYE: DeterministicRule = {
  ...confirmed, intent: 'dye_prices', body: QUESTION, matchMode: 'covers_message',
  stems: ['будаг', 'будуул'], coverWords: ['үс', 'хэд', 'вэ'], placement: 'replace',
  quoteServices: ['Үсний угийн будаг', 'Дунд үсний будаг', 'Урт үсний будаг'],
};
const STYLIST = 'Үсэнд тань аль нь тохирохыг мастер үсчин зөвлөж өгнө.';
const STYLIST_ROW: DeterministicRule = {
  ...confirmed, intent: 'suitability_stylist', body: STYLIST, matchMode: 'on_topic',
  stems: ['suitability_lat_orh'], coverWords: [], placement: 'append', quoteServices: [],
};
const SUIT: GateRule = {
  gate: 'Ш8', topicKey: 'suitability_lat_orh', matcher: { mode: 'stem_sequence', stems: ['usend', 'oroh'], windowCp: 40 },
  quotePrice: true, deterministicShortcircuit: false, responseKind: 'refusal_suitability',
  provenance: 'tenant_confirmed', groundedOnly: true,
};

const GUARD: TenantGuardView = {
  primaryScript: 'Cyrillic', allowedUrls: [],
  allowedNumbers: ['135,000', '176,000', '200,000', '120,000', '190,000', '380,000', '460,000', '220,000', '255,000', '132,000', '154,000', '20,000', '10,000', '1'],
  kbHasPromotion: false, approvedPercentages: [], concessionStems: [], forbiddenStemSeqs: { 'Ш2': [['мастер', 'илүү']] },
  promptCorpus: '', cannedResponses: CANNED.map((c) => c.body), scriptShareExclusions: [], maxReplyChars: 1900,
};

function run(text: string) {
  const drafts: { body: string; answeredBy: string }[] = [];
  const flags: string[] = [];
  const requests: ReceptionRequest[] = [];
  const result: CallOutcome = {
    kind: 'ok', text, modelReturned: 'm', stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const deps: ReceptionDeps = {
    callModel: async (req) => { requests.push(req); return result; },
    draft: async (x) => { drafts.push(x); return { ok: true, id: 'o' }; },
    markCalled: async () => true, settle: async () => ({ ok: true }), release: async () => {},
    flag: async (f) => { flags.push(f.code); }, observe: async () => {},
  };
  return { deps, drafts, flags, requests };
}

const base: ReceptionInput = {
  customerMessage: '', customerAttachments: [], customerSentPhoto: false, history: [],
  eventAt: new Date('2026-09-24T05:00:00Z'), now: new Date('2026-09-24T05:00:05Z'),
  promptStable: STABLE, promptVolatile: 'VOLATILE', modelId: 'm', cacheMode: '1h', timeoutMs: 25_000,
  rules: [SUIT], deterministic: [TARA_NAME, TARA_APPEND, DYE, STYLIST_ROW], historyState: { known: true, empty: false },
  canned: CANNED, tenantGuard: GUARD, cannedLabel: 'БЭЛЭН ХАРИУЛТ', cannedHash: null,
  serviceNames: SERVICES, serviceAliases: ALIASES, depositRows: DEPOSITS, faqAnswers: [], spellings: [], branches: [],
};

test('B1 DONE-TEST: AN ADDRESS QUESTION GETS ITS ANSWER, THEN THE TARA LINE', async () => {
  const t = run('Манай салон Яармагт байрладаг.');
  const r = await handleReception(t.deps, { ...base, customerMessage: 'Tara salon hayag?' });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
  assert.equal(t.drafts[0]?.body, `Манай салон Яармагт байрладаг.\n\n${TARA}`);
  assert.match(t.requests[0]?.promptVolatile ?? '', /Tara Salon нэртэй болсон/, 'the model is told the line is coming');
});

test('B1 DONE-TEST: ONLY A QUESTION ABOUT THE NAME GETS THE LINE ON ITS OWN', async () => {
  const t = run('never called');
  const r = await handleReception(t.deps, { ...base, customerMessage: 'Энэ Тара салон мөн үү?' });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'deterministic');
  assert.deepEqual(t.drafts.map((x) => x.body), [TARA]);
  assert.equal(t.requests.length, 0);
});

test('B2/B3 DONE-TEST: «Үс будуулахад хэд вэ?» IS THE ROWS IN ORDER, THEN THE QUESTION, FROM DATA', async () => {
  const t = run('never called');
  await handleReception(t.deps, { ...base, customerMessage: 'Үс будуулахад хэд вэ?' });
  assert.equal(t.drafts[0]?.body, `${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n\n${QUESTION}`);
  assert.equal(t.drafts[0]?.answeredBy, 'deterministic');
});

test('B2 DONE-TEST: A LEAKED LABEL ON A PRICED ANSWER SERVES THE PRICES, NOT THE HANDOFF', async () => {
  const t = run(`Ш2-т хамаарах боловч тодруулъя.\n${ROWS.mid}\n${ROWS.long}\n${ROWS.root}`);
  await handleReception(t.deps, { ...base, customerMessage: 'Будаг хийлгэх гэсэн юм' });
  assert.equal(t.drafts[0]?.body, `${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n\n${QUESTION}`);
  assert.ok(t.flags.includes('outbound_gate_label'));
});

test('B3 DONE-TEST: A MODEL REPLY IN PRICE-LIST ORDER IS SERVED IN THE TENANT\'S ORDER', async () => {
  const t = run(`${QUESTION}\n\n${ROWS.mid}\n${ROWS.long}\n${ROWS.root}`);
  await handleReception(t.deps, { ...base, customerMessage: 'Будаг хийлгэх гэсэн юм' });
  assert.equal(t.drafts[0]?.body, `${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n\n${QUESTION}`);
  assert.ok(t.flags.includes('set_presentation'));
});

test('B3: a reply already in the tenant\'s order is left exactly as written', async () => {
  const text = `Будгийн үнэ:\n${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n\n${QUESTION}`;
  const t = run(text);
  await handleReception(t.deps, { ...base, customerMessage: 'Будаг хийлгэх гэсэн юм' });
  assert.deepEqual(t.drafts, [{ body: text, answeredBy: 'model' }]);
});

test('B3 DONE-TEST: «Сор хэд вэ?» DOES NOT GET THE COLOUR QUESTION', async () => {
  const t = run(`${ROWS.sor}\n\n${QUESTION}`);
  await handleReception(t.deps, { ...base, customerMessage: 'Сор хэд вэ?' });
  assert.equal(t.drafts[0]?.body, ROWS.sor);
  assert.ok(t.flags.includes('set_question_stray'));
});

test('B4 DONE-TEST: A REPLY SAYING MASTER IS BETTER IS NEVER SENT', async () => {
  const t = run('Мастер үсчин илүү сайн.');
  await handleReception(t.deps, { ...base, customerMessage: 'Мастер дээр үү?' });
  assert.doesNotMatch(t.drafts[0]?.body ?? '', /илүү/);
  assert.ok(t.flags.includes('outbound_forbidden'));
});

test('4 DONE-TEST: ADVICE NO ROW GIVES IS REPLACED BY THE PRICES, THEN «THE STYLIST DECIDES»', async () => {
  const t = run(`Оффис колор нь харанхуй/хар үсэнд хийхэд тохирдог арга бөгөөд үнэ нь 380,000₮–460,000₮ байна.`);
  await handleReception(t.deps, { ...base, customerMessage: 'Office color har usni ungute usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.office}\n\n${STYLIST}`);
  assert.ok(t.flags.includes('suitability_prices_served'));
});

test('4 DONE-TEST: THE MODEL REFUSING A «CAN IT BE DONE» QUESTION IS ANSWERED WITH THE NAMED PRICES', async () => {
  const t = run(SUITABILITY);
  await handleReception(t.deps, { ...base, customerMessage: 'Цайруулалт хар usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.bleach}\n\n${STYLIST}`);
});

test('4: with no price to give, unsupported advice gets the refusal — and no stylist line after it', async () => {
  const t = run('Хар үсэнд маш сайн тохирно, санаа зоволтгүй, гоё болно.');
  await handleReception(t.deps, { ...base, customerMessage: 'har usend orohu' });
  assert.equal(t.drafts[0]?.body, SUITABILITY);
  assert.ok(t.flags.includes('advice_ungrounded'));
});

test('4 DONE-TEST: THE SALON\'S OWN ANSWER STANDS, THE NAMED PRICES FOLLOW IT, THEN THE STYLIST LINE', async () => {
  // c07: answered from the salon's document exactly, and no price. The document says
  // «цайруулаагүй»; bleaching is not what was asked about, and is not listed.
  const t = run(DOC);
  await handleReception(t.deps, { ...base, customerMessage: 'budagtai usend orohu himi' });
  assert.deepEqual(t.drafts, [{ body: `${DOC}\n\n${ROWS.emch}\n${ROWS.usan}\n\n${STYLIST}`, answeredBy: 'model' }]);
  assert.ok(t.flags.includes('suitability_prices_added'));
});

test('4: a grounded answer that already quotes a price is left as written, then the stylist line', async () => {
  const text = `${DOC}\n${ROWS.emch}`;
  const t = run(text);
  await handleReception(t.deps, { ...base, customerMessage: 'budagtai usend orohu himi' });
  assert.deepEqual(t.drafts, [{ body: `${text}\n\n${STYLIST}`, answeredBy: 'model' }]);
});

test('4: a grounded answer whose customer named no service gets no rows', async () => {
  const t = run(DOC);
  await handleReception(t.deps, { ...base, customerMessage: 'minii usend orohu' });
  assert.deepEqual(t.drafts, [{ body: `${DOC}\n\n${STYLIST}`, answeredBy: 'model' }]);
});

test('B7 DONE-TEST: A QUESTION DOES NOT OPEN WITH «Уучлаарай»', async () => {
  const t = run('Уучлаарай, ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?');
  await handleReception(t.deps, { ...base, customerMessage: 'une hedve' });
  assert.equal(t.drafts[0]?.body, 'Ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?');
  assert.ok(t.flags.includes('apology_removed'));
});

test('1 DONE-TEST: «уг цайруулалт» NAMES A LISTED SERVICE, SO «NO PRICE» IS REPLACED BY ITS ROW', async () => {
  const t = run(UNLISTED);
  await handleReception(t.deps, { ...base, customerMessage: 'будагтай үсний уг цайруулалт хэд вэ' });
  assert.equal(t.drafts[0]?.body, ROWS.bleach);
  assert.ok(t.flags.includes('price_unlisted_overridden'));
});

test('1: «no price» stands when the message names no listed service', async () => {
  const t = run(UNLISTED);
  await handleReception(t.deps, { ...base, customerMessage: 'кератин хэд вэ' });
  assert.equal(t.drafts[0]?.body, UNLISTED);
});

test('2 DONE-TEST: THE BOOKING LINK ALONE GETS THE DEPOSITS, JUST ABOVE IT', async () => {
  const t = run(`Танд туслахад бэлэн байна. ${BOOKING}`);
  await handleReception(t.deps, { ...base, customerMessage: 'tsag zahialah' });
  assert.equal(t.drafts[0]?.body, `Танд туслахад бэлэн байна.\n\n${DEPOSITS.join('\n')}\n\n${BOOKING}`);
});

test('2: a reply that already states every deposit is left as written', async () => {
  const text = `${BOOKING}\n${DEPOSITS.join('\n')}`;
  const t = run(text);
  await handleReception(t.deps, { ...base, customerMessage: 'tsag zahialah' });
  assert.equal(t.drafts[0]?.body, text);
});

test('3 DONE-TEST: TIER PRAISE IS NEVER SENT, AND THE ANSWER IS BOTH TIERS — NOT THE HANDOFF', async () => {
  const t = run('Мастер үсчин илүү сайн.');
  await handleReception(t.deps, { ...base, customerMessage: 'Мастер үсчин илүү сайн уу?' });
  assert.equal(t.drafts[0]?.body, `${ROWS.womenM}\n${ROWS.womenF}`);
  assert.ok(t.flags.includes('outbound_forbidden'));
});

test('5 DONE-TEST: A PHOTO WITH ANY CAPTION GETS THE PHOTO LINE, WITH NO MODEL CALL', async () => {
  const t = run('never called');
  const r = await handleReception(t.deps, { ...base, customerMessage: 'iim bolgoj bolhu', customerAttachments: ['image'], customerSentPhoto: true });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.deepEqual(t.drafts.map((x) => x.body), [IMAGE]);
  assert.equal(t.requests.length, 0);
});

test('4: unsupported advice on a named service is answered with that service\'s price, then the stylist line', async () => {
  const t = run('Цайруулалт хар үсэнд маш сайн тохирдог, санаа зоволтгүй.');
  await handleReception(t.deps, { ...base, customerMessage: 'Цайруулалт хар usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.bleach}\n\n${STYLIST}`);
});

test('4: a reply that quotes a price and then refuses is answered with the price and the stylist line', async () => {
  const t = run(`${ROWS.bleach}\n\n${SUITABILITY}`);
  await handleReception(t.deps, { ...base, customerMessage: 'Цайруулалт хар usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.bleach}\n\n${STYLIST}`);
});

test('4 DONE-TEST: «himi» FINDS EVERY «… хими» SERVICE BY ALIAS AND KIND — NOT «Хими арчилт»', async () => {
  // c07: the model answered from the document, paraphrased, and quoted no price.
  const t = run('Будсан үсэнд хими хийж болно, гэхдээ үс хэт цайруулаагүй байх шаардлагатай гэж бодож байна.');
  await handleReception(t.deps, { ...base, customerMessage: 'Budagtai usend himi hiidegv', rules: [{ ...SUIT, matcher: { mode: 'stem_sequence', stems: ['usend', 'himi'], windowCp: 40 } }] });
  assert.equal(t.drafts[0]?.body, `${ROWS.emch}\n${ROWS.usan}\n\n${STYLIST}`,
    'the named service leads its kind; the care service is another kind; and the reply\'s «цайруулаагүй» chooses nothing');
});

test('4 DONE-TEST: THE CUSTOMER\'S WORDS CHOOSE THE ROWS, NOT THE MODEL\'S ADVICE', async () => {
  // c07 measured: «хэт цайруулсан бол…» in the reply matched an alias of «Цайруулалт», and a
  // question about perming dyed hair was answered with the price of bleaching.
  const t = run('Хэт цайруулсан үсэнд хими барихгүй тул мастер үсчин таны үсийг үзэж дүгнэнэ.');
  await handleReception(t.deps, { ...base, customerMessage: 'Budagtai usend himi hiidegv', rules: [{ ...SUIT, matcher: { mode: 'stem_sequence', stems: ['usend', 'himi'], windowCp: 40 } }] });
  assert.ok(!(t.drafts[0]?.body ?? '').includes(ROWS.bleach), t.drafts[0]?.body);
  assert.equal(t.drafts[0]?.body, `${ROWS.emch}\n${ROWS.usan}\n\n${STYLIST}`);
});

test('4: the reply is consulted only when the customer names nothing', async () => {
  const t = run('Цайруулалт хийсэн үсэнд тохирохгүй байж магадгүй гэж бодож байна.');
  await handleReception(t.deps, { ...base, customerMessage: 'Минийх шиг usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.bleach}\n\n${STYLIST}`);
});

test('4 DONE-TEST: KINDS IN THE ORDER THE CUSTOMER NAMES THEM — COLOUR, THEN PERM', async () => {
  // c08 «Yag ingej budaad dolgiontoi himi hij boldoguu».
  const t = run('Будалт болон химийг хослуулах эсэх нь үсний байдлаас хамаарна гэж бодож байна.');
  await handleReception(t.deps, { ...base, customerMessage: 'Yag ingej budaad dolgiontoi himi hij boldoguu', rules: [{ ...SUIT, matcher: { mode: 'stem_sequence', stems: ['budaa', 'himi'], windowCp: 40 } }] });
  assert.equal(t.drafts[0]?.body, `${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n${ROWS.emch}\n${ROWS.usan}\n\n${STYLIST}`);
});

test('4 DONE-TEST: «Хар өнгөтэй үсэнд орох уу» FINDS THE COLOUR SERVICES THROUGH AN ALIAS', async () => {
  const t = run(SUITABILITY);
  await handleReception(t.deps, { ...base, customerMessage: 'Хар өнгөтэй usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n\n${STYLIST}`, 'the aliased service leads its kind');
});

test('4 DONE-TEST: A SUITABILITY QUESTION ANSWERED WITH ANOTHER REFUSAL ROW STILL GETS THE PRICES', async () => {
  // c03, second full run: the model answered with a different approved refusal, exactly.
  for (const reply of [UNLISTED, CANNED[0]?.body ?? '']) {
    const t = run(reply);
    await handleReception(t.deps, { ...base, customerMessage: 'Хар өнгөтэй usend orohu' });
    assert.equal(t.drafts[0]?.body, `${ROWS.root}\n${ROWS.mid}\n${ROWS.long}\n\n${STYLIST}`, reply);
  }
});

test('4: a refusal row that another fired rule points at stands', async () => {
  const OTHER: GateRule = {
    gate: 'Ш1', topicKey: 'keratin', matcher: { mode: 'contains_stem', stems: ['кератин'] },
    quotePrice: false, deterministicShortcircuit: false, responseKind: 'refusal_price_unlisted',
    provenance: 'tenant_confirmed', groundedOnly: false,
  };
  const t = run(UNLISTED);
  await handleReception(t.deps, { ...base, rules: [SUIT, OTHER], customerMessage: 'кератин өнгөтэй usend orohu' });
  assert.equal(t.drafts[0]?.body, UNLISTED);
});

test('2 DONE-TEST: A REFUSED REPLY QUOTING THE BOOKING LINE WHOLE SERVES THAT LINE, WITH THE DEPOSITS', async () => {
  // n03 measured: the label refused it, and the customer got the handoff instead of the link.
  const t = run(`Ш3 хамааралтай тул booking_line бэлэн хариултыг ашиглав.\n\n${BOOKING}`);
  const r = await handleReception(t.deps, { ...base, customerMessage: 'tsag zahialah' });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(t.drafts[0]?.body, `${DEPOSITS.join('\n')}\n\n${BOOKING}`);
  assert.deepEqual(t.flags, ['outbound_gate_label']);
});

test('2: a refused reply quoting the IMAGE line is not answered with it — no picture was sent', async () => {
  // An unreviewed row cannot reach this path at all: the review gate refuses the request
  // before the model is called, so that case has nothing to test here.
  const t = run(`Ш5 хамааралтай тул.\n\n${IMAGE}`);
  await handleReception(t.deps, { ...base, customerMessage: 'iim bolgoj bolhu' });
  assert.equal(t.drafts[0]?.body, CANNED[0]?.body);
});

// --- A correction is never answered with the same reply (live, 2026-09-24, 773 → 774) ------

const CLARIFY = 'Уучлаарай, би буруу ойлгосон байна. Та юу асууж байгаагаа арай дэлгэрэнгүй бичнэ үү?';
const CORRECTION: DeterministicRule = {
  ...confirmed, intent: 'correction_clarify', body: CLARIFY, matchMode: 'on_correction',
  stems: ['bish', 'буруу'], coverWords: [], placement: 'replace', quoteServices: [],
};
const corrected = (history: ReceptionInput['history']) => ({
  ...base, deterministic: [...base.deterministic, CORRECTION], history,
});
const WATER_TURN: ReceptionInput['history'] = [
  { role: 'user', content: 'usnii himi' }, { role: 'assistant', content: `Усны хими ${ROWS.usan.slice(ROWS.usan.indexOf(':') + 2)} байна.` },
];

test('3 DONE-TEST: A CORRECTION ANSWERED WITH THE SAME PRICES GETS THE CLARIFYING LINE, NOT THE REPEAT', async () => {
  const t = run(`Буруу ойлголоо. ${ROWS.usan} байна.`);
  await handleReception(t.deps, { ...corrected(WATER_TURN), customerMessage: 'us bish usnii himi' });
  assert.deepEqual(t.drafts, [{ body: CLARIFY, answeredBy: 'deterministic' }]);
  assert.ok(t.flags.includes('correction_repeat_blocked'));
});

test('3: a customer re-asking in other words is owed the same answer again', async () => {
  const t = run(`${ROWS.usan} байна.`);
  await handleReception(t.deps, { ...corrected(WATER_TURN), customerMessage: 'usan himi hed ve' });
  assert.equal(t.drafts[0]?.body, `${ROWS.usan} байна.`);
});

test('3: a correction the new reply acts on is sent as written', async () => {
  const t = run(`${ROWS.emch} байна.`);
  await handleReception(t.deps, { ...corrected(WATER_TURN), customerMessage: 'us bish usnii himi' });
  assert.equal(t.drafts[0]?.body, `${ROWS.emch} байна.`);
});

test('3: the correction row never answers a message by itself', async () => {
  const t = run('Тийм, тодруулж хэлнэ үү.');
  await handleReception(t.deps, { ...corrected([]), customerMessage: 'bish' });
  assert.equal(t.requests.length, 1, 'the model is asked');
  assert.notEqual(t.drafts[0]?.body, CLARIFY);
});

