import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReception, type ReceptionDeps, type ReceptionInput } from './handle.ts';
import type { CallOutcome } from '../model/reception.ts';
import type { GateRule } from '../gate/match.ts';
import type { TenantGuardView } from '../guard/outbound.ts';

const REVIEWED = '2026-09-04T00:00:00Z';

const CANNED = [
  { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: REVIEWED },
  { kind: 'refusal_topic', body: 'Хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.', reviewedAt: REVIEWED },
  { kind: 'closing', body: '', reviewedAt: REVIEWED },
];

const CHILDREN: GateRule = {
  gate: 'Ш1', topicKey: 'children_services',
  matcher: { mode: 'contains_stem', stems: ['хүүхэд', 'хүүхд'] },
  quotePrice: false, deterministicShortcircuit: false, responseKind: 'refusal_topic',
};

const GUARD_VIEW: TenantGuardView = {
  primaryScript: 'Cyrillic',
  allowedUrls: [],
  allowedNumbers: ['33,000'],
  kbHasPromotion: false,
  concessionStems: ['хямдр'],
  forbiddenStemSeqs: {},
  promptCorpus: '',
  cannedResponses: CANNED.map((c) => c.body),
  scriptShareExclusions: [],
  maxReplyChars: 1900,
};

const OK_REPLY: CallOutcome = {
  kind: 'ok',
  text: 'Чёлк тайралт 33,000₮ байна.',
  usage: { input_tokens: 9000, output_tokens: 40, cache_read_input_tokens: 8800, cache_creation_input_tokens: 0 },
  modelReturned: 'm', stopReason: 'end_turn',
};

function deps(over: Partial<ReceptionDeps> & { result?: CallOutcome } = {}) {
  const calls: string[] = [];
  const flags: { code: string; attempted?: string }[] = [];
  const observed: { requestedModel: string; servedModel: string; terminalReason?: string }[] = [];
  const d: ReceptionDeps = {
    callModel: async () => { calls.push('callModel'); return over.result ?? OK_REPLY; },
    draft: async ({ answeredBy }) => { calls.push(`draft:${answeredBy}`); return { ok: true, id: 'om-1' }; },
    markCalled: async () => { calls.push('markCalled'); return true; },
    settle: async () => { calls.push('settle'); return { ok: true }; },
    release: async () => { calls.push('release'); },
    flag: async (f) => { calls.push(`flag:${f.code}`); flags.push(f); },
    observe: async (o) => { calls.push('observe'); observed.push(o); },
    ...over,
  };
  return { deps: d, calls, flags, observed };
}

const base: ReceptionInput = {
  customerMessage: 'Чёлк тайралт хэд вэ?',
  history: [],
  eventAt: new Date('2026-09-04T09:59:00Z'),
  now: new Date('2026-09-04T10:00:00Z'),
  promptStable: 'STABLE',
  promptVolatile: 'VOLATILE',
  modelId: 'a-model',
  cacheMode: '1h',
  timeoutMs: 25_000,
  rules: [CHILDREN],
  deterministic: [],
  historyState: { known: true, empty: true },
  canned: CANNED,
  tenantGuard: GUARD_VIEW,
  cannedLabel: 'БЭЛЭН ХАРИУЛТ',
};

// ---------------------------------------------------------------------------
// The happy path, and the order that makes it safe.
// ---------------------------------------------------------------------------

test('a clean reply is settled, guarded, then drafted — in that order', async () => {
  const { deps: d, calls } = deps();
  const r = await handleReception(d, base);
  assert.equal(r.kind, 'drafted');
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
  assert.deepEqual(calls, ['markCalled', 'callModel', 'observe', 'settle', 'draft:model']);
});

test('the reservation is marked called BEFORE the provider is reached', async () => {
  const { deps: d, calls } = deps();
  await handleReception(d, base);
  assert.equal(calls.indexOf('markCalled') < calls.indexOf('callModel'), true);
});

test('the canned section rides in the VOLATILE tail, never the cached prefix', async () => {
  // Tenant sentences change when a tenant edits them; the cached prefix must not.
  let seen = '';
  const { deps: d } = deps({ callModel: async (req) => { seen = req.promptVolatile; return OK_REPLY; } });
  await handleReception(d, base);
  assert.equal(seen.includes('=== БЭЛЭН ХАРИУЛТ ==='), true);
  assert.equal(seen.includes('"handoff"'), true);
});

// ---------------------------------------------------------------------------
// Three refusals that cost nothing, all before the call.
// ---------------------------------------------------------------------------

test('a stale event is dropped without a call, and the hold goes back', async () => {
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, eventAt: new Date('2026-09-03T12:00:00Z') });
  assert.equal(r.kind === 'dropped' && r.reason, 'stale_event');
  assert.deepEqual(calls, ['release']);
});

test('an unparseable matcher retries and never calls the model', async () => {
  const broken: GateRule = { ...CHILDREN, matcher: { mode: 'regex' } };
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, rules: [broken] });
  assert.equal(r.kind, 'retry');
  assert.equal(calls.includes('callModel'), false);
  assert.deepEqual(calls, ['release']);
});

test('an unreviewed canned line retries and never calls the model', async () => {
  const { deps: d, calls } = deps();
  const r = await handleReception(d, {
    ...base,
    canned: [...CANNED, { kind: 'refusal_health', body: 'x', reviewedAt: null }],
  });
  assert.equal(r.kind, 'retry');
  assert.equal(r.kind === 'retry' && r.detail.includes('refusal_health'), true);
  assert.deepEqual(calls, ['release']);
});

// ---------------------------------------------------------------------------
// The short-circuit.
// ---------------------------------------------------------------------------

test('an enabled short-circuit answers from a row with NO model call', async () => {
  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true };
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, customerMessage: 'Хүүхдийн үс хэд вэ?', rules: [opted] });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.deepEqual(calls, ['release', 'draft:canned']);
});

test('a short-circuit naming an unprovisioned kind retries rather than improvising', async () => {
  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true, responseKind: 'refusal_health' };
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, customerMessage: 'Хүүхдийн үс', rules: [opted] });
  assert.equal(r.kind, 'retry');
  assert.equal(calls.includes('callModel'), false);
});

// ---------------------------------------------------------------------------
// Model outcomes. The money is spent whatever happens next.
// ---------------------------------------------------------------------------

test('a REFUSAL is settled and answered with the handoff line, never the model text', async () => {
  const refusal: CallOutcome = {
    kind: 'terminal', reason: 'refusal', detail: 'refused: cyber', category: 'cyber',
    usage: { input_tokens: 9000, output_tokens: 5 },
  };
  const { deps: d, calls, flags } = deps({ result: refusal });
  const r = await handleReception(d, base);
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(r.kind === 'drafted' && r.refusal, 'model_refusal');
  assert.equal(calls.includes('settle'), true, 'a refusal is billed and must settle');
  assert.deepEqual(flags.map((f) => f.code), ['model_refusal']);
});

test('a max_tokens truncation never reaches the customer', async () => {
  const truncated: CallOutcome = {
    kind: 'terminal', reason: 'max_tokens', detail: 'ceiling hit',
    usage: { input_tokens: 9000, output_tokens: 700 },
  };
  const { deps: d } = deps({ result: truncated });
  const r = await handleReception(d, base);
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
});

test('a retryable failure leaves the reservation CALLED rather than releasing it', async () => {
  // We do not know whether tokens were consumed. Releasing would give back a hold that
  // may have been spent; the expiry sweep reconciles it. An unknown is parked, not
  // guessed — the same posture as `indeterminate` on the outbound side.
  const { deps: d, calls } = deps({ result: { kind: 'retryable', reason: 'upstream', detail: '503' } });
  const r = await handleReception(d, base);
  assert.equal(r.kind, 'retry');
  assert.equal(calls.includes('release'), false);
  assert.equal(calls.includes('settle'), false);
});

test('A LEDGER FAILURE DOES NOT REFUSE THE CUSTOMER — the money is already spent', async () => {
  const { deps: d, calls, flags } = deps({ settle: async () => ({ ok: false, detail: 'ledger down' }) });
  const r = await handleReception(d, base);
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model', 'they are owed the answer');
  assert.deepEqual(flags.map((f) => f.code), ['ledger_deadletter']);
  assert.equal(calls.includes('draft:model'), true);
});

// ---------------------------------------------------------------------------
// The guard, and what happens when it refuses.
// ---------------------------------------------------------------------------

test('a guard refusal sends the handoff line and files the FULL attempted reply', async () => {
  const invented: CallOutcome = { ...OK_REPLY, text: 'Хөмсөг засалт 20,000₮ байна.' };
  const { deps: d, flags } = deps({ result: invented });
  const r = await handleReception(d, base);
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(r.kind === 'drafted' && r.refusal, 'outbound_price');
  assert.equal(flags[0]?.attempted, 'Хөмсөг засалт 20,000₮ байна.', 'the Quality layer needs what was attempted');
});

test('the guard sees the customer text, so an echoed numeral is not refused', async () => {
  const echoed: CallOutcome = { ...OK_REPLY, text: '15:00 цагт болно.' };
  const { deps: d } = deps({ result: echoed });
  const r = await handleReception(d, { ...base, customerMessage: 'Маргааш 15:00 цагт болох уу?' });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
});

test('a refused topic reaches the guard, so a listed price is still blocked', async () => {
  const { deps: d } = deps();
  const r = await handleReception(d, { ...base, customerMessage: 'Хүүхдийн чёлк тайралт хэд вэ?' });
  assert.equal(r.kind === 'drafted' && r.refusal, 'outbound_refused_topic_price');
});

test('NEVER SILENCE: a missing handoff line retries instead of sending nothing', async () => {
  // §5.7's ladder is explicit that even a spent budget answers with something. A customer
  // who gets nothing does not know whether anyone is there.
  const { deps: d } = deps({ result: { ...OK_REPLY, text: 'Хөмсөг засалт 20,000₮.' } });
  const r = await handleReception(d, { ...base, canned: CANNED.filter((c) => c.kind !== 'handoff') });
  assert.equal(r.kind, 'retry');
  assert.equal(r.kind === 'retry' && r.detail.includes('handoff'), true);
});

test('a draft failure is a retry, not a lost reply', async () => {
  const { deps: d } = deps({ draft: async () => ({ ok: false, detail: 'insert failed' }) });
  assert.equal((await handleReception(d, base)).kind, 'retry');
});

test('a reservation that cannot be marked called never reaches the provider', async () => {
  const { deps: d, calls } = deps({ markCalled: async () => false });
  const r = await handleReception(d, base);
  assert.equal(r.kind, 'retry');
  assert.equal(calls.includes('callModel'), false);
  assert.equal(calls.includes('release'), true);
});

// ---------------------------------------------------------------------------
// §6.8's pre-model layer, inside the flow.
// ---------------------------------------------------------------------------

const GREET = {
  intent: 'greeting', body: 'Сайн байна уу! Танд юугаар туслах вэ?',
  enabled: true, matchMode: 'whole_message' as const,
  stems: ['сайн байна уу'], requiresEmptyHistory: true,
};

test('a greeting is answered from a row with NO model call, and the hold goes back', async () => {
  // §6.3.8 prices what this absorbs at ₮26,300/tenant-month — the largest single saving
  // in the design, and it was unreachable until the matcher columns existed.
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, customerMessage: 'Сайн байна уу', deterministic: [GREET] });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.deepEqual(calls, ['release', 'draft:canned']);
});

test('IT RUNS AFTER THE REVIEW GATE — an unreviewed line does not ship just because no model chose it', async () => {
  const { deps: d, calls } = deps();
  const r = await handleReception(d, {
    ...base, customerMessage: 'Сайн байна уу', deterministic: [GREET],
    canned: [...CANNED, { kind: 'refusal_health', body: 'x', reviewedAt: null }],
  });
  assert.equal(r.kind, 'retry');
  assert.equal(calls.includes('draft:canned'), false);
});

test('a greeting mid-conversation falls through to the model', async () => {
  const { deps: d, calls } = deps();
  const r = await handleReception(d, {
    ...base, customerMessage: 'Сайн байна уу', deterministic: [GREET],
    historyState: { known: true, empty: false },
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
  assert.equal(calls.includes('callModel'), true);
});

test('UNKNOWN history falls through to the model rather than greeting from scratch', async () => {
  const { deps: d } = deps();
  const r = await handleReception(d, {
    ...base, customerMessage: 'Сайн байна уу', deterministic: [GREET],
    historyState: { known: false },
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
});

test('a message that is not a greeting is untouched by the layer', async () => {
  const { deps: d, calls } = deps();
  await handleReception(d, { ...base, customerMessage: 'Чёлк тайралт хэд вэ?', deterministic: [GREET] });
  assert.equal(calls.includes('callModel'), true);
});

test('an empty rule set is the normal case and costs nothing', async () => {
  const { deps: d, calls } = deps();
  await handleReception(d, { ...base, deterministic: [] });
  assert.deepEqual(calls, ['markCalled', 'callModel', 'observe', 'settle', 'draft:model']);
});

// ---------------------------------------------------------------------------
// §6.10.5's health signals, inside the flow.
// ---------------------------------------------------------------------------

test('the served model is reported on every successful call', async () => {
  const { deps: d, observed } = deps({ result: { ...OK_REPLY, modelReturned: 'served-by-other' } });
  await handleReception(d, base);
  assert.equal(observed[0]?.requestedModel, 'a-model');
  assert.equal(observed[0]?.servedModel, 'served-by-other');
});

test('OBSERVE RUNS BEFORE SETTLE, so a bookkeeping failure cannot swallow the signal', async () => {
  // The overridden settle does not record itself, so the ordering is asserted against the
  // deadletter flag it produces — which is recorded, and which necessarily comes after.
  const { deps: d, calls } = deps({ settle: async () => ({ ok: false, detail: 'ledger down' }) });
  await handleReception(d, base);
  assert.equal(calls.includes('observe'), true);
  assert.equal(calls.indexOf('observe') < calls.indexOf('flag:ledger_deadletter'), true);
});

test('a terminal outcome still reports, and carries its reason', async () => {
  // A refusal is billed and a retired model is an outage; both need the signal even
  // though neither produces a reply.
  const { deps: d, observed } = deps({
    result: { kind: 'terminal', reason: 'model_not_found', detail: '404' },
  });
  await handleReception(d, base);
  assert.equal(observed[0]?.terminalReason, 'model_not_found');
  assert.equal(observed[0]?.servedModel, '', 'a failed call reports no served model');
});

test('a RETRYABLE failure does not report — nothing is known about the call', async () => {
  const { deps: d, calls } = deps({ result: { kind: 'retryable', reason: 'upstream', detail: '503' } });
  await handleReception(d, base);
  assert.equal(calls.includes('observe'), false);
});

test('a short-circuited reply reports nothing, because no model was asked', async () => {
  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true };
  const { deps: d, calls } = deps();
  await handleReception(d, { ...base, customerMessage: 'Хүүхдийн үс', rules: [opted] });
  assert.equal(calls.includes('observe'), false);
});
