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
const CANNED = [
  { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: R },
  { kind: 'refusal_suitability', body: SUITABILITY, reviewedAt: R },
];

const ROWS = {
  root: 'Үсний угийн будаг: 135,000₮',
  mid: 'Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮',
  long: 'Урт үсний будаг (мөр давсан урттай үс): 200,000₮',
  sor: 'Сор: 120,000₮–190,000₮',
  office: 'Оффис колор: 380,000₮–460,000₮',
};
const SERVICES = [
  { name: 'Дунд үсний будаг', prices: ['176000'], rows: [ROWS.mid] },
  { name: 'Оффис колор', prices: ['380000', '460000'], rows: [ROWS.office] },
  { name: 'Сор', prices: ['120000', '190000'], rows: [ROWS.sor] },
  { name: 'Урт үсний будаг', prices: ['200000'], rows: [ROWS.long] },
  { name: 'Үсний угийн будаг', prices: ['135000'], rows: [ROWS.root] },
];
const DOC = 'Будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно.';
const STABLE = `GATE\n=== ${SECTION_LABELS.dataMarker} ===\n=== ҮНИЙН ЖАГСААЛТ ===\n`
  + Object.values(ROWS).map((r) => `- ${r}`).join('\n') + `\n=== ТАНИЛЦУУЛГА ===\n${DOC}`;

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
const SUIT: GateRule = {
  gate: 'Ш8', topicKey: 'suitability_lat_orh', matcher: { mode: 'stem_sequence', stems: ['usend', 'oroh'], windowCp: 40 },
  quotePrice: true, deterministicShortcircuit: false, responseKind: 'refusal_suitability',
  provenance: 'tenant_confirmed', groundedOnly: true,
};

const GUARD: TenantGuardView = {
  primaryScript: 'Cyrillic', allowedUrls: [],
  allowedNumbers: ['135,000', '176,000', '200,000', '120,000', '190,000', '380,000', '460,000'],
  kbHasPromotion: false, concessionStems: [], forbiddenStemSeqs: { 'Ш2': [['мастер', 'илүү']] },
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
  customerMessage: '', customerAttachments: [], history: [],
  eventAt: new Date('2026-09-24T05:00:00Z'), now: new Date('2026-09-24T05:00:05Z'),
  promptStable: STABLE, promptVolatile: 'VOLATILE', modelId: 'm', cacheMode: '1h', timeoutMs: 25_000,
  rules: [SUIT], deterministic: [TARA_NAME, TARA_APPEND, DYE], historyState: { known: true, empty: false },
  canned: CANNED, tenantGuard: GUARD, cannedLabel: 'БЭЛЭН ХАРИУЛТ', cannedHash: null,
  serviceNames: SERVICES, depositRows: [], faqAnswers: [],
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

test('B6 DONE-TEST: ADVICE NO ROW GIVES IS REPLACED BY THE REFUSAL, WITH THE PRICE', async () => {
  const t = run(`Оффис колор нь харанхуй/хар үсэнд хийхэд тохирдог арга бөгөөд үнэ нь 380,000₮–460,000₮ байна.`);
  await handleReception(t.deps, { ...base, customerMessage: 'Office color har usni ungute usend orohu' });
  assert.equal(t.drafts[0]?.body, `${ROWS.office}\n\n${SUITABILITY}`);
  assert.ok(t.flags.includes('advice_ungrounded'));
});

test('B6: advice that IS the salon\'s document stands', async () => {
  const t = run(DOC);
  await handleReception(t.deps, { ...base, customerMessage: 'budagtai usend orohu himi' });
  assert.deepEqual(t.drafts, [{ body: DOC, answeredBy: 'model' }]);
});

test('B7 DONE-TEST: A QUESTION DOES NOT OPEN WITH «Уучлаарай»', async () => {
  const t = run('Уучлаарай, ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?');
  await handleReception(t.deps, { ...base, customerMessage: 'une hedve' });
  assert.equal(t.drafts[0]?.body, 'Ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?');
  assert.ok(t.flags.includes('apology_removed'));
});
