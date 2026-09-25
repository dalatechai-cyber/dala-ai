import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, renderGate, runCases, withCompiled, type ReplyCase } from './run.ts';
import type { ReceptionContext } from '../reception/load.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';
import { SECTION_LABELS } from '../prompt/tenant.ts';

const REVIEWED = '2026-09-04T00:00:00Z';
const WHO: DeterministicRule = {
  intent: 'assistant_who', body: 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.',
  enabled: true, matchMode: 'whole_message', stems: ['ci henbe', 'чи хэн бэ'], coverWords: [],
  placement: 'replace', quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
};
const STABLE = `GATE\n=== ${SECTION_LABELS.dataMarker} ===\n=== ${SECTION_LABELS.priceList} ===\n- Сор: 120,000₮–190,000₮`;

const CTX: ReceptionContext = {
  promptStable: STABLE, hours: [], closures: [], allowedNumbers: ['120,000', '190,000'], cannedHash: null,
  promptGate: 'GATE', revisionId: 'r1', contentHash: 'h1', rules: [], deterministic: [WHO], serviceAliases: [],
  spellings: [],
  canned: [{ kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: REVIEWED }],
  tenantGuard: {
    primaryScript: 'Cyrillic', allowedUrls: [], allowedNumbers: ['120,000', '190,000'], kbHasPromotion: false,
    concessionStems: [], forbiddenStemSeqs: {}, promptCorpus: 'GATE', cannedResponses: [], scriptShareExclusions: [],
    maxReplyChars: 1900,
  },
  cacheMode: 'off',
};

function kase(over: Partial<ReplyCase>): ReplyCase {
  return { id: 1, customerMessage: 'ci henbe', history: [], expectedBody: WHO.body, mustInclude: [], mustNotInclude: [], note: null, ...over };
}

test('judge: exact text once whitespace is collapsed, then the must-include and must-not lists', () => {
  assert.deepEqual(judge(kase({}), `  ${WHO.body.replace(' ', '\n')} `), []);
  assert.equal(judge(kase({}), 'Би Матрикс эко салоны туслах.').length, 1);
  assert.deepEqual(judge(kase({ expectedBody: null, mustInclude: ['Tara'], mustNotInclude: ['Матрикс'] }), 'Би Матрикс'),
    ['missing «Tara»', 'contains «Матрикс»']);
  assert.deepEqual(judge(kase({}), null), ['no reply was drafted']);
});

test('a case answered by a row passes, through handleReception, with no model', async () => {
  const [r] = await runCases({ cases: [kase({})], ctx: CTX, timezone: 'Asia/Ulaanbaatar', now: new Date(), callModel: null });
  assert.equal(r?.pass, true, JSON.stringify(r));
  assert.equal(r?.answeredBy, 'deterministic');
});

test('DONE-TEST: A CASE THAT NEEDS THE MODEL AND HAS NO KEY FAILS — IT IS NEVER SKIPPED', async () => {
  // "Could not check" letting a publish through is the failure the gate exists to end.
  const [r] = await runCases({
    cases: [kase({ customerMessage: 'Сор хэд вэ?', expectedBody: 'Сор: 120,000₮–190,000₮' })],
    ctx: CTX, timezone: 'Asia/Ulaanbaatar', now: new Date(), callModel: null,
  });
  assert.equal(r?.pass, false);
  assert.match(r?.why.join(' ') ?? '', /no ANTHROPIC_API_KEY/);
});

test('with a model, the reply is judged as the customer would get it — facts served from the row', async () => {
  const [r] = await runCases({
    cases: [kase({ customerMessage: 'Сор хэд вэ?', expectedBody: 'Сор: 120,000₮–190,000₮' })],
    ctx: CTX, timezone: 'Asia/Ulaanbaatar', now: new Date(),
    callModel: async () => ({
      kind: 'ok', text: 'Сор 120,000₮-190,000₮ байна.', modelReturned: 'm', stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  });
  assert.equal(r?.pass, true, JSON.stringify(r));
  assert.ok(r?.flags.includes('fact_restated'));
});

test('a publish is judged against the prefix it is about to publish, not the live one', () => {
  const next = withCompiled(CTX, { promptStable: 'NEW', allowedNumbers: ['1'], cannedHash: 'c2', promptGate: 'G2' });
  assert.equal(next.promptStable, 'NEW');
  assert.deepEqual(next.tenantGuard.allowedNumbers, ['1']);
  assert.equal(next.tenantGuard.promptCorpus, 'G2');
  assert.equal(next.cannedHash, 'c2');
});

test('the summary fails when any case fails, or when a tenant could not be checked', () => {
  assert.equal(renderGate([{ ok: true, slug: 's', results: [] }]).pass, true);
  assert.equal(renderGate([{ ok: true, slug: 's', results: [{ id: 1, pass: false, reply: null, answeredBy: null, why: ['x'], flags: [] }] }]).pass, false);
  assert.equal(renderGate([{ ok: false, slug: 's', detail: 'reply_cases unreadable' }]).pass, false);
});
