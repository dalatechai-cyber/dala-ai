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
  promptStable: STABLE, hours: [], closures: [], allowedNumbers: ['120,000', '190,000'], cannedHash: null, fallbackLine: null, complaintRules: [],
  promptGate: 'GATE', revisionId: 'r1', contentHash: 'h1', rules: [], deterministic: [WHO], serviceAliases: [],
  spellings: [], branches: [], days: null,
  canned: [{ kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: REVIEWED }],
  tenantGuard: {
    primaryScript: 'Cyrillic', allowedUrls: [], allowedNumbers: ['120,000', '190,000'], kbHasPromotion: false, approvedPercentages: [],
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
  assert.equal(renderGate([{ ok: true, slug: 's', results: [{ id: 1, pass: false, outcome: 'wrong', reply: null, answeredBy: null, why: ['x'], flags: [] }] }]).pass, false);
  assert.equal(renderGate([{ ok: false, slug: 's', detail: 'reply_cases unreadable' }]).pass, false);
});

// The two cases the founder marked on 2026-09-25 (conversation a70ce9fe), as they will sit in
// `reply_cases`: judged by what must and must not appear, because the right answer names
// TOMORROW and so changes with the day the gate runs on.
test('DONE-TEST: the tomorrow and holiday cases pass through the whole reply path with no model', async () => {
  const rows = [
    { intent: 'tomorrow_hours', body: 'Маргааш ({tomorrow.day}) {tomorrow.hours} ажиллана.', placement: 'replace' as const },
    { intent: 'holiday_hours_note', body: 'Баярын өдрийн цагийг 76001888 дугаараас лавлана уу.', placement: 'append' as const },
  ];
  const { readFileSync } = await import('node:fs');
  const { parseMatcher } = await import('../gate/match.ts');
  const { withDaySlots } = await import('../reception/load.ts');
  const tpl = JSON.parse(readFileSync(new URL('../../../scripts/provision/templates/day_hours.salon.json', import.meta.url), 'utf8')) as {
    rows: { intent: string; matcher: unknown }[];
  };
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => (weekday === 0
    ? { weekday, opens: '11:00:00', closes: '19:00:00', closed: false }
    : { weekday, opens: '10:00:00', closes: '20:00:00', closed: false }));
  const deterministic = withDaySlots(rows.map((r): DeterministicRule => {
    const p = parseMatcher(tpl.rows.find((t) => t.intent === r.intent)?.matcher);
    return {
      ...r, enabled: true, matchMode: 'matcher', stems: [], coverWords: [], quoteServices: [],
      requiresEmptyHistory: false, provenance: 'tenant_confirmed', matcher: p.ok ? p.spec : null,
    };
  }), { localDate: '2026-09-25', hours, closures: [], branchCount: 0 });
  const ctx: ReceptionContext = { ...CTX, hours, deterministic, days: { today: 5, tomorrow: 6, closed: [] } };
  const week = 'Даваа: 10:00 - 20:00\nМягмар: 10:00 - 20:00\nЛхагва: 10:00 - 20:00\nПүрэв: 10:00 - 20:00\nБаасан: 10:00 - 20:00\nБямба: 10:00 - 20:00\nНям: 11:00 - 19:00';
  const results = await runCases({
    cases: [
      kase({
        id: 7, customerMessage: 'Hi margaash tanaih ajilahu', expectedBody: null,
        mustInclude: ['Маргааш (', 'ажиллана.'], mustNotInclude: ['Даваа:', 'Ням:', 'үнийн мэдээлэл'],
      }),
      kase({
        id: 8, customerMessage: 'Margaash automashingvi bvh niitiin amraltiin udur ym bn', expectedBody: null,
        history: [{ role: 'user', content: 'Hi margaash tanaih ajilahu' }, { role: 'assistant', content: week }],
        mustInclude: ['Маргааш (', 'Баярын өдрийн цагийг 76001888 дугаараас лавлана уу.'],
        mustNotInclude: ['үнийн мэдээлэл', 'Даваа:'],
      }),
    ],
    ctx, timezone: 'Asia/Ulaanbaatar', now: new Date('2026-09-25T11:05:44Z'), callModel: null,
  });
  for (const r of results) {
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(r.answeredBy, 'deterministic');
  }
  assert.equal(results[1]?.reply, 'Маргааш (Бямба) 10:00–20:00 ажиллана.\n\nБаярын өдрийн цагийг 76001888 дугаараас лавлана уу.');
});

test('REPLY_GATE_PRINT: every reply printed verbatim beside the customer\'s message, and nothing else changes', async () => {
  const { renderReplies, findingsOf } = await import('./run.ts');
  const results = await runCases({
    cases: [kase({}), kase({ id: 2, customerMessage: 'Сор хэд вэ?', expectedBody: 'Сор: 120,000₮–190,000₮' })],
    ctx: CTX, timezone: 'Asia/Ulaanbaatar', now: new Date(), callModel: null,
  });
  assert.equal(results[0]?.message, 'ci henbe');
  const gates = [{ ok: true as const, slug: 'tara', results }, { ok: false as const, slug: 'other', detail: 'unreadable' }];
  const printed = renderReplies(gates);
  assert.ok(printed.includes('tara case 1 — PASS (deterministic)'));
  assert.ok(printed.includes(`  reply:    ${WHO.body}`), 'the reply, verbatim');
  assert.ok(printed.includes('  customer: ci henbe'));
  assert.ok(printed.includes('tara case 2 — UNCHECKED'));
  assert.ok(printed.includes('  reply:    (no reply was drafted)'));
  assert.ok(!printed.includes('other'), 'a tenant that could not be checked has no replies to print');
  // A multi-line reply stays readable: continuation lines are indented under the reply.
  const multi = renderReplies([{ ok: true, slug: 's', results: [{ id: 3, pass: true, outcome: 'pass', message: 'a', reply: 'x\ny', answeredBy: 'model', why: [], flags: ['f'] }] }]);
  assert.ok(multi.includes('  reply:    x\n            y'));
  assert.ok(multi.includes('  flags:    f'));
  assert.equal(renderReplies([]), '');
  // The verdict is computed from the same results with or without the print.
  assert.deepEqual(findingsOf(gates), { wrong: [], unchecked: ['tara case 2: this case reaches the model and no ANTHROPIC_API_KEY was given', 'other: unreadable'] });
});
