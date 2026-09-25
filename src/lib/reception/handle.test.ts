import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_LABELS } from '../prompt/tenant.ts';
import { cannedHashOf } from '../prompt/sections.ts';
import { renderStablePrefix } from '../prompt/render.ts';
import { renderTenantSections } from '../prompt/tenant.ts';
import { DAY_ONE_KB } from '../prompt/tenantKb.fixtures.ts';
import { handleReception, PRICE_VIOLATION_FLAG, type ReceptionDeps, type ReceptionInput } from './handle.ts';
import type { CallOutcome } from '../model/reception.ts';
import type { GateRule } from '../gate/match.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';
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
  provenance: 'tenant_confirmed',
};

const GUARD_VIEW: TenantGuardView = {
  primaryScript: 'Cyrillic',
  allowedUrls: [],
  allowedNumbers: ['33,000'],
  kbHasPromotion: false, approvedPercentages: [],
  concessionStems: ['хямдр'],
  forbiddenStemSeqs: {},
  promptCorpus: '',
  cannedResponses: CANNED.map((c) => c.body),
  scriptShareExclusions: [],
  maxReplyChars: 1900,
};

const OK_REPLY: CallOutcome = {
  kind: 'ok',
  // The price-list row quoted whole, as the platform requires (D-120). Written as
  // «Чёлк тайралт 33,000₮ байна.» it is the price in the model's own words, which
  // `guard/facts.ts` replaces with the row — see the fact tests at the end of this file.
  text: 'Чёлк тайралт: 33,000₮ байна.',
  usage: { input_tokens: 9000, output_tokens: 40, cache_read_input_tokens: 8800, cache_creation_input_tokens: 0 },
  modelReturned: 'm', stopReason: 'end_turn',
};

function deps(over: Partial<ReceptionDeps> & { result?: CallOutcome } = {}) {
  const calls: string[] = [];
  const flags: { code: string; detail?: string; attempted?: string }[] = [];
  const observed: { requestedModel: string; servedModel: string; terminalReason?: string }[] = [];
  /** What was actually drafted, so a test can assert the TEXT and not only its provenance. */
  const drafts: { body: string; answeredBy: string }[] = [];
  const d: ReceptionDeps = {
    callModel: async () => { calls.push('callModel'); return over.result ?? OK_REPLY; },
    draft: async ({ body, answeredBy }) => {
      calls.push(`draft:${answeredBy}`);
      drafts.push({ body, answeredBy });
      return { ok: true, id: 'om-1' };
    },
    markCalled: async () => { calls.push('markCalled'); return true; },
    settle: async () => { calls.push('settle'); return { ok: true }; },
    release: async () => { calls.push('release'); },
    flag: async (f) => { calls.push(`flag:${f.code}`); flags.push(f); },
    observe: async (o) => { calls.push('observe'); observed.push(o); },
    ...over,
  };
  return { deps: d, calls, flags, observed, drafts };
}

/**
 * A prefix that carries tenant data, because the fixture must not be a state the platform
 * refuses to answer from.
 *
 * Before the `no_tenant_data` check existed, `promptStable: 'STABLE'` stood for "a compiled
 * prompt" in every test here — and eighteen of them went green while describing exactly the
 * production configuration that greeted a customer as a beauty salon (D-033). The marker is
 * the difference between a gate-only prefix and a provisioned one, so the fixture carries it.
 */
const STABLE = `STABLE\n=== ${SECTION_LABELS.dataMarker} ===\n=== ҮНИЙН ЖАГСААЛТ ===\n- Чёлк тайралт: 33,000₮`;

/** The same prompt for a tenant that has entered nothing: the gate, and nothing under it. */
const GATE_ONLY = 'STABLE';

const base: ReceptionInput = {
  customerMessage: 'Чёлк тайралт хэд вэ?',
  customerAttachments: [],
  customerSentPhoto: false,
  serviceAliases: [],
  spellings: [],
  branches: [],
  history: [],
  eventAt: new Date('2026-09-04T09:59:00Z'),
  now: new Date('2026-09-04T10:00:00Z'),
  promptStable: STABLE,
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
  // The pre-D-058 format: the prefix does not carry the canned section, so the volatile
  // tail still must. Tests for the published-in-the-prefix format set it explicitly.
  // The price list the STABLE fixture renders, so the name counter has something to check.
  serviceNames: [{ name: 'Чёлк тайралт', prices: ['22000'], rows: [] }],
  depositRows: [],
  faqAnswers: [],
  cannedHash: null, fallbackLine: null,
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

test('a snapshot from before D-058 still gets the canned section in the volatile tail', async () => {
  // `cannedHash: null` is a FORMAT marker, not "unknown". A prefix compiled before the
  // section moved does not contain it, so it must still be appended — otherwise the
  // rollout has a window in which every tenant loses its canned lines entirely, between
  // the deploy and the republish.
  let seen = '';
  const { deps: d } = deps({ callModel: async (req) => { seen = req.promptVolatile; return OK_REPLY; } });
  await handleReception(d, { ...base, cannedHash: null });
  assert.equal(seen.includes('=== БЭЛЭН ХАРИУЛТ ==='), true);
  assert.equal(seen.includes('"handoff"'), true);
});

test('DONE-TEST: WITH THE SECTION IN THE PREFIX IT IS NOT ALSO IN THE TAIL', async () => {
  // The whole point of D-058: ~1,000 tokens of tenant sentences billed at full input rate
  // on every reply, for text that changes only at publish. Sending it twice would cost
  // MORE than before the change while looking like it worked.
  let seen = '';
  const { deps: d } = deps({ callModel: async (req) => { seen = req.promptVolatile; return OK_REPLY; } });
  const r = await handleReception(d, { ...base, cannedHash: cannedHashOf(CANNED) });
  assert.equal(r.kind, 'drafted');
  assert.equal(seen.includes('=== БЭЛЭН ХАРИУЛТ ==='), false);
  assert.equal(seen, 'VOLATILE');
});

test('DONE-TEST: AN EDITED CANNED LINE REFUSES RATHER THAN ANSWERING FROM EITHER COPY', async () => {
  // The mitigation that ships with the change, not after it. Once the sentence is in the
  // published prefix, an operator editing the row without republishing gives the model one
  // version and the deterministic short-circuit another — D-039's shape, two sources of one
  // fact, and no way to tell from the data which a customer was answered from.
  const { deps: d, calls } = deps();
  const edited = CANNED.map((c) => (c.kind === 'handoff' ? { ...c, body: 'бид тантай холбогдоно' } : c));
  const r = await handleReception(d, { ...base, canned: edited, cannedHash: cannedHashOf(CANNED) });
  assert.equal(r.kind, 'retry');
  assert.equal(r.kind === 'retry' && r.detail.startsWith('canned_stale'), true);
  // 503 with the hold released: QStash still has the customer's message, so republishing
  // and letting the retry through answers it. Dropping would lose a real question to fix a
  // problem that outlives the request.
  assert.deepEqual(calls, ['release']);
});

test('the staleness check is on the rows as rendered, not on their order in the array', async () => {
  // `cannedHashOf` sorts by kind, exactly as the section body does. If it hashed the array
  // as given, the loader returning the same rows in a different order — one `.order()`
  // clause away — would 503 every reply with nothing actually wrong.
  const { deps: d } = deps();
  const r = await handleReception(d, {
    ...base, canned: [...CANNED].reverse(), cannedHash: cannedHashOf(CANNED),
  });
  assert.equal(r.kind, 'drafted');
});

test('an unreviewed row is caught BEFORE the staleness check, and by its own code', async () => {
  // Ordering matters for the operator reading the log: nulling `reviewed_at` must report
  // the unreviewed line, not `canned_stale`, or the fix looks like "republish" when it is
  // "get this sentence reviewed".
  const { deps: d } = deps();
  const rows = [...CANNED, { kind: 'refusal_health', body: 'x', reviewedAt: null }];
  const r = await handleReception(d, { ...base, canned: rows, cannedHash: cannedHashOf(CANNED) });
  assert.equal(r.kind, 'retry');
  assert.equal(r.kind === 'retry' && r.detail.includes('refusal_health'), true);
  assert.equal(r.kind === 'retry' && r.detail.includes('canned_stale'), false);
});

// ---------------------------------------------------------------------------
// Three refusals that cost nothing, all before the call.
// ---------------------------------------------------------------------------

test('DONE-TEST: A DAY-ONE TENANT TAKES THE HANDOFF, THROUGH THE REAL COMPILER', async () => {
  // The regression D-058 shipped and this file did not catch. Every fixture here is either
  // a bare string or a fully provisioned prefix; the state in between — canned lines and no
  // knowledge, which is every tenant on its first day — was described by nothing, so the
  // change that made it look provisioned passed the whole suite.
  //
  // This compiles `DAY_ONE_KB` through `renderTenantSections` and `renderStablePrefix`
  // rather than hand-writing a prefix, so it fails if the RENDERER starts emitting the data
  // marker for a tenant that has only boilerplate — which is exactly how it broke.
  // DAY_ONE_KB's SHAPE — canned lines and nothing else — carrying this file's own canned
  // rows, so the gate's required kinds are still satisfied and the only thing under test is
  // the day-one shape rather than which sentences it holds.
  const kb = { ...DAY_ONE_KB, canned: base.canned.map((c) => ({ kind: c.kind, body: c.body })) };
  const rendered = renderStablePrefix([
    { layer: 'L0', key: 'gate', ordinal: 0, body: 'ЖАГСААЛТ', reviewedAt: REVIEWED, origin: 'platform' },
    ...renderTenantSections(kb, REVIEWED),
  ]);
  assert.equal(rendered.ok, true);
  const promptStable = rendered.ok ? rendered.rendered.promptStable : '';
  assert.equal(promptStable.includes(SECTION_LABELS.canned), true, 'the canned lines belong in the prefix');

  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, promptStable, cannedHash: cannedHashOf(kb.canned) });
  assert.equal(r.kind === 'drafted' && r.refusal, 'no_tenant_data');
  assert.deepEqual(calls, ['release', 'flag:no_tenant_data', 'draft:canned']);
  assert.equal(calls.includes('callModel'), false, 'the provider must not be reached');
});

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
  // A gate short-circuit answers from a `canned_responses` row, so `canned` is right here —
  // it is the DETERMINISTIC_REPLIES path that is its own provenance.
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
// A tenant with no facts is never asked to produce any.
// ---------------------------------------------------------------------------

test('DONE-TEST: NO TENANT DATA, NO MODEL CALL — the handoff line, for free', async () => {
  // The first real reply this platform sent, on a tenant whose vertical is `software`:
  // «Манай гоо сайхны салонтой холбоотой асуулт байвал асуугаарай — үнийн мэдээлэл…»
  // ("questions about our beauty salon… price information"). Nobody supplied either fact.
  // «салон» appears four times in the compiled prefix — Ш1, Ш3, Ш6 and Ш8's own examples —
  // and the tenant's name and vertical appear nowhere in it, so it was the only
  // business-type noun in the model's context (D-033).
  const { deps: d, calls, flags } = deps();
  const r = await handleReception(d, { ...base, promptStable: GATE_ONLY });

  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(r.kind === 'drafted' && r.refusal, 'no_tenant_data');
  assert.deepEqual(calls, ['release', 'flag:no_tenant_data', 'draft:canned']);
  assert.equal(flags[0]?.code, 'no_tenant_data');
});

test('it costs nothing: no reservation is marked called and nothing is settled', async () => {
  // The saving is real ($0.0159 a message at the measured rate) but it is the second
  // reason. A refusal that spent the money and then declined to send it would be just as
  // correct about what the customer sees, and this one is cheaper because the safe order
  // happens to be the cheap one.
  const { deps: d, calls } = deps();
  await handleReception(d, { ...base, promptStable: GATE_ONLY });
  for (const step of ['markCalled', 'callModel', 'settle', 'observe']) {
    assert.equal(calls.includes(step), false, `${step} must not run for a tenant with no data`);
  }
});

test('THE ROW-BACKED ANSWERS STILL WORK — the check runs after both short-circuits', async () => {
  // A deterministic reply and a gate short-circuit both send a sentence the tenant wrote,
  // with no model in the loop, so nothing can be invented and there is nothing to withhold.
  // Refusing them would turn a safety fix into a product regression on the two paths that
  // were already safe.
  const greet = deps();
  const g = await handleReception(greet.deps, {
    ...base, promptStable: GATE_ONLY, customerMessage: 'Сайн байна уу', deterministic: [GREET],
  });
  // `deterministic`, not `canned`: a deterministic_replies row and a canned_responses line
  // are different tables with different review gates, and this path spends nothing at all.
  // `0001`'s CHECK has allowed both values since the schema was written.
  assert.equal(g.kind === 'drafted' && g.answeredBy, 'deterministic');
  assert.equal(g.kind === 'drafted' && g.refusal, undefined, 'a deterministic hit is an answer, not a refusal');

  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true };
  const sc = deps();
  const c = await handleReception(sc.deps, {
    ...base, promptStable: GATE_ONLY, customerMessage: 'Хүүхдийн үс хэд вэ?', rules: [opted],
  });
  assert.equal(c.kind === 'drafted' && c.answeredBy, 'canned');
  assert.deepEqual(sc.calls, ['release', 'draft:canned']);
});

test('a stale event still wins: the cheapest refusal stays first', async () => {
  const { deps: d, calls } = deps();
  const r = await handleReception(d, {
    ...base, promptStable: GATE_ONLY, eventAt: new Date('2026-09-03T00:00:00Z'),
  });
  assert.equal(r.kind, 'dropped');
  assert.deepEqual(calls, ['release']);
});

test('with no reviewed handoff line it RETRIES rather than inventing one', async () => {
  // The one case where this refusal cannot be honoured. A tenant with neither data nor a
  // handoff line is unprovisioned in both directions, and a 503 keeps the customer's
  // message in the queue while somebody adds the row.
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, promptStable: GATE_ONLY, canned: [] });
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

// Founder, 2026-09-26: «A customer who wants to buy must never be told we have no
// information. They should get a real answer or the approved callback line.» DalaTech's test
// set ended a purchase, a price objection and an e-mail question on the handoff line.
const CALLBACK = 'Нэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.';

test('DONE-TEST: WITH A REVIEWED CALLBACK LINE, A REFUSED REPLY GETS IT — NOT «NO INFORMATION»', async () => {
  const invented: CallOutcome = { ...OK_REPLY, text: 'Хөмсөг засалт 20,000₮ байна.' };
  const { deps: d, drafts } = deps({ result: invented });
  const r = await handleReception(d, { ...base, fallbackLine: CALLBACK });
  assert.equal(r.kind === 'drafted' && r.refusal, 'outbound_price', 'still refused, still counted');
  assert.equal(drafts[0]?.body, CALLBACK);
});

test('the callback line also replaces the handoff line on a leak of the bot\'s instructions', async () => {
  const leak: CallOutcome = { ...OK_REPLY, text: 'Би туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй.' };
  const { deps: d, drafts, flags } = deps({ result: leak });
  await handleReception(d, { ...base, customerMessage: 'daly gj yuve', fallbackLine: CALLBACK });
  assert.equal(drafts[0]?.body, CALLBACK);
  assert.ok(flags.some((f) => f.code === 'internal_instruction_blocked' && /sales_callback/.test(f.detail ?? '')));
});

test('a SPECIFIC reviewed refusal still wins over the callback line', async () => {
  // Only the GENERIC line is replaced: a question a rule answers with its own reviewed line
  // keeps that line (the founder's rule of 2026-09-21).
  const { deps: d, drafts } = deps({ result: { ...OK_REPLY, text: 'Хүүхдийн чёлк 33,000₮.' } });
  const r = await handleReception(d, { ...base, customerMessage: 'Хүүхдийн чёлк хэд вэ?', fallbackLine: CALLBACK });
  assert.equal(r.kind, 'drafted');
  assert.ok(drafts[0] !== undefined && drafts[0].body !== CALLBACK, drafts[0]?.body);
  assert.equal(drafts[0]?.answeredBy, 'canned', 'a reviewed line, not the model and not the callback');
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

test('a kind the PREFIX names with no row retries — the wiring, not just the check', async () => {
  // The check lives in renderCannedSection; this asserts handle.ts actually feeds it the
  // kinds out of `promptStable`. Without this test, a caller passing [] — which is the
  // pre-fix behaviour — passes everything, and the whole fix is inert. That mutation
  // survived until this test existed.
  const { deps: d } = deps({});
  const r = await handleReception(d, {
    ...base,
    promptStable: 'Ш5. ... «БЭЛЭН ХАРИУЛТ» хэсгийн "refusal_health" мөрийг яг хэвээр нь бич.',
  });
  assert.equal(r.kind, 'retry');
  assert.equal(r.kind === 'retry' && r.detail.startsWith('canned_response_missing:'), true, JSON.stringify(r));
  assert.equal(r.kind === 'retry' && r.detail.includes('refusal_health'), true);
});

test('a kind only the TENANT\'S RULES name with no row retries — the hole nothing saw', async () => {
  // The prefix names nothing here, so `kindsReferencedBy` returns []. The requirement can
  // only come from the rule itself. This is the live shape found on the project on
  // 2026-09-07: Matrix's `photo_consultation` row points at `refusal_out_of_scope` and no
  // such row exists, and before this check the gate fired, the model was told to reproduce
  // a sentence that was not in its context, and it improvised — with nothing going red.
  const { deps: d, calls } = deps({});
  const photo: GateRule = {
    gate: 'Ш8', topicKey: 'photo_consultation',
    matcher: { mode: 'contains_stem', stems: ['зураг'] },
    quotePrice: false, deterministicShortcircuit: false, responseKind: 'refusal_out_of_scope',
    provenance: 'tenant_confirmed',
  };
  const r = await handleReception(d, { ...base, promptStable: STABLE, rules: [CHILDREN, photo] });
  assert.equal(r.kind, 'retry', JSON.stringify(r));
  assert.equal(r.kind === 'retry' && r.detail.startsWith('canned_response_missing:'), true, JSON.stringify(r));
  assert.equal(r.kind === 'retry' && r.detail.includes('refusal_out_of_scope'), true);
  // And it costs nothing: the refusal is structural, decided before the provider call.
  assert.equal(calls.some((c) => c === 'model'), false, calls.join(','));
});

test('a rule whose line exists but is UNREVIEWED retries too', async () => {
  // Worth pinning, and worth being exact about WHERE it comes from: this property does not
  // come from the union above. `renderCannedSection`'s unreviewed check runs over every row
  // it is handed, not only the required ones, so it would hold with the union removed —
  // measured, by mutation. The test earns its place as a statement that a rule cannot be
  // the route by which an unsigned Mongolian sentence reaches a customer; it is NOT
  // coverage of `kindsRequiredByRules`, and reading it as such is the mistake this comment
  // exists to prevent.
  const { deps: d } = deps({});
  const unreviewed = CANNED.map((c) => (c.kind === 'refusal_topic' ? { ...c, reviewedAt: null } : c));
  const r = await handleReception(d, { ...base, canned: unreviewed });
  assert.equal(r.kind, 'retry', JSON.stringify(r));
  assert.equal(r.kind === 'retry' && r.detail.startsWith('canned_response_unreviewed:'), true, JSON.stringify(r));
  assert.equal(r.kind === 'retry' && r.detail.includes('refusal_topic'), true);
});

test('the model is never called when a named kind is missing — the refusal is free', async () => {
  const { deps: d, calls } = deps({});
  await handleReception(d, {
    ...base,
    promptStable: '«БЭЛЭН ХАРИУЛТ» ... "refusal_health" ...',
  });
  // `calls` records every dep, and the refusal legitimately calls `release` to hand the
  // budget hold back. What must not appear is the model.
  assert.equal(calls.includes('callModel'), false, `a provisioning fault must cost no tokens; got ${calls.join(', ')}`);
  assert.deepEqual(calls, ['release']);
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
  stems: ['сайн байна уу'], coverWords: [], placement: 'replace' as const, quoteServices: [], requiresEmptyHistory: true, provenance: 'tenant_confirmed',
};

test('a greeting is answered from a row with NO model call, and the hold goes back', async () => {
  // §6.3.8 prices what this absorbs at ₮26,300/tenant-month — the largest single saving
  // in the design, and it was unreachable until the matcher columns existed.
  const { deps: d, calls } = deps();
  const r = await handleReception(d, { ...base, customerMessage: 'Сайн байна уу', deterministic: [GREET] });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'deterministic');
  assert.deepEqual(calls, ['release', 'draft:deterministic']);
});

test('DONE-TEST: THE THREE PROVENANCES ARE THREE, not two', async () => {
  // `messages.answered_by` has allowed model | deterministic | canned | human since `0001`
  // and nothing had ever written any of them — `deps.ts` carried a literal `void answeredBy`.
  // Recording the deterministic short-circuit as `canned` would have kept two of the three
  // indistinguishable on the day the column finally started being written, and the first
  // question anybody asks of the mirror's corpus is how often a row answered without the
  // model. Asserted on all three paths together so a future edit cannot quietly merge them.
  const det = deps();
  const d1 = await handleReception(det.deps, {
    ...base, customerMessage: 'Сайн байна уу', deterministic: [GREET],
  });
  assert.equal(d1.kind === 'drafted' && d1.answeredBy, 'deterministic');

  // A tenant with no rendered sections takes the handoff line before the provider call
  // (D-033), which is a canned_responses row.
  const han = deps();
  const d2 = await handleReception(han.deps, { ...base, promptStable: GATE_ONLY });
  assert.equal(d2.kind === 'drafted' && d2.answeredBy, 'canned');

  const mod = deps();
  const d3 = await handleReception(mod.deps, { ...base, customerMessage: 'юу байна' });
  assert.equal(d3.kind === 'drafted' && d3.answeredBy, 'model');
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

// ---------------------------------------------------------------------------
// D-020 — provenance reaches the Quality layer
// ---------------------------------------------------------------------------

test('DONE-TEST: a seeded refusal that fires is flagged — the reply is unchanged', async () => {
  // The customer is protected either way; the point is that afterwards somebody can tell
  // "the bot refused" from "the bot refused on a rule somebody guessed". Without the flag
  // those two replies are byte-identical in every record the platform keeps.
  const { deps: d, calls, flags } = deps();
  const r = await handleReception(d, {
    ...base,
    customerMessage: 'Хүүхдийн үс',
    rules: [{ ...CHILDREN, provenance: 'seeded' }],
  });
  assert.equal(r.kind, 'drafted', 'the refusal still produced a reply');
  assert.equal(calls.includes('flag:gate_rule_unconfirmed'), true);
  assert.ok(flags.find((f) => f.code === 'gate_rule_unconfirmed'));
});

test('a confirmed refusal writes no flag — silence has to mean something', async () => {
  const { deps: d, calls } = deps();
  await handleReception(d, { ...base, customerMessage: 'Хүүхдийн үс' });
  assert.equal(calls.some((c) => c.startsWith('flag:gate_rule_unconfirmed')), false);
});

test('DONE-TEST: a withheld deterministic reply falls to the MODEL, and is flagged', async () => {
  // The cost of the whole rule, stated exactly: one model call. §6.3.8 prices the layer at
  // ₮26,300/tenant-month, so this is not free — it is just far cheaper than sending a
  // sentence nobody at the salon wrote.
  const { deps: d, calls } = deps();
  const r = await handleReception(d, {
    ...base,
    customerMessage: 'Сайн байна уу',
    deterministic: [{
      intent: 'greeting', body: 'Сайн байна уу! Танд юугаар туслах вэ?',
      enabled: true, matchMode: 'whole_message' as const,
      stems: ['сайн байна уу'], coverWords: [], placement: 'replace' as const, quoteServices: [], requiresEmptyHistory: true, provenance: 'seeded',
    }],
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model', 'the model answered instead');
  assert.equal(calls.includes('callModel'), true);
  assert.equal(calls.includes('flag:deterministic_reply_unconfirmed'), true);
  assert.equal(calls.includes('draft:canned'), false, 'the guessed sentence was never drafted');
});

// ---------------------------------------------------------------------------
// Pinned lines: reproduced, or paraphrased (D-065)
// ---------------------------------------------------------------------------

/** The handoff row, with «би» removed — Matrix's measured drift, 2026-09-14. */
const PARAPHRASED: CallOutcome = {
  ...OK_REPLY,
  text: 'Уучлаарай, энэ асуултад хариулж чадахгүй байна.',
};

test('DONE-TEST: A PARAPHRASED PINNED LINE IS REPLACED BY THE ROW, AND COUNTED', async () => {
  // Four gate blocks tell the model to copy an approved sentence «нэг ч үсэг өөрчлөхгүйгээр»
  // and nothing had ever checked that it did. Matrix's third mirror draft dropped one word.
  // The draft nine minutes earlier is byte-exact and is not a counter-example — the guard
  // refused the model's text there and `handoff()` served the row, so the platform typed it.
  // A near-copy is an unreviewed sentence with an approved one's meaning, and `reviewed_at`
  // cannot see it because the gate is on the row, not on what came back.
  const { deps: d, drafts, flags } = deps({ result: PARAPHRASED });
  const r = await handleReception(d, { ...base, customerMessage: 'будаг хэдээр хийх вэ' });

  assert.equal(r.kind, 'drafted');
  // Served from the row, byte for byte — NOT the model's text repaired, which would be the
  // editing this module and `handleReception` both refuse.
  assert.equal(drafts[0]?.body, CANNED[0]?.body);
  assert.equal(drafts[0]?.answeredBy, 'canned', 'a canned line answered, whoever typed it');

  // Corrected AND counted. A paraphrase quietly fixed is a paraphrase nobody knows is
  // happening, and the rate is the only evidence about whether the gate wording works.
  assert.ok(flags.some((f) => f.code === 'canned_paraphrased'), JSON.stringify(flags));
  assert.match(String(flags.find((f) => f.code === 'canned_paraphrased')?.detail), /handoff/);
});

test('an EXACT reproduction is recorded as canned, and raises no flag', async () => {
  // The other half. The text is already right, so there is nothing to correct — but calling
  // it a model answer would misstate the corpus the mirror exists to produce.
  const exact: CallOutcome = { ...OK_REPLY, text: CANNED[0]?.body ?? '' };
  const { deps: d, drafts, flags } = deps({ result: exact });
  const r = await handleReception(d, { ...base, customerMessage: 'будаг хэдээр хийх вэ' });

  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(drafts[0]?.body, CANNED[0]?.body);
  assert.equal(flags.some((f) => f.code === 'canned_paraphrased'), false, 'obeying is not a finding');
});

test('a genuine answer still goes through the guard untouched', async () => {
  // The regression this must not cause. `OK_REPLY` quotes an allowed price and resembles no
  // canned line; replacing it with a refusal would be far worse than the drift being fixed.
  const { deps: d, drafts } = deps();
  const r = await handleReception(d, { ...base });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
  assert.equal(drafts[0]?.body, OK_REPLY.kind === 'ok' ? OK_REPLY.text : '');
});

// ---------------------------------------------------------------------------
// Founder's rule, 2026-09-21: a refused question gets the line written FOR IT.
// ---------------------------------------------------------------------------

test('DONE-TEST: A REFUSED QUESTION GETS ITS OWN REVIEWED LINE, NOT THE GENERIC HANDOFF', async () => {
  // Measured turn 14, 2026-09-21: a suitability question was refused by the guard and the
  // customer got «Уучлаарай, би энэ асуултад хариулж чадахгүй байна…» while the tenant's
  // own reviewed `refusal_suitability` row — written for exactly that question — sat
  // unused. Founder: "Customers must see the refusal line written for that question."
  //
  // The reply quotes an unlisted price, so the guard refuses it and the fallback runs.
  const { deps: d, drafts, flags } = deps({
    result: { ...OK_REPLY, text: 'Хүүхдийн тайралт 99,999₮ байна.' },
  });
  const r = await handleReception(d, { ...base, customerMessage: 'Хүүхдийн үс хэд вэ?' });

  assert.equal(r.kind, 'drafted');
  assert.equal(drafts.at(-1)?.body, 'Хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.',
    'the children`s line, not the generic one');
  assert.notEqual(drafts.at(-1)?.body, 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.');
  // WHICH line was served is in the flag, or the corpus cannot tell two refusals apart.
  assert.match(flags.at(-1)?.detail ?? '', /\[served: refusal_topic\]/);
});

test('DONE-TEST: no topic matched still gets the generic line', async () => {
  // The generic line is what you say when you do not know what was asked. A message that
  // fires no rule is exactly that, and must not be given some other topic's sentence.
  const { deps: d, drafts, flags } = deps({
    result: { ...OK_REPLY, text: 'Энэ үйлчилгээ 99,999₮ байна.' },
  });
  const r = await handleReception(d, { ...base, customerMessage: 'Маникюр хэд вэ?' });
  assert.equal(r.kind, 'drafted');
  assert.equal(drafts.at(-1)?.body, 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.');
  assert.match(flags.at(-1)?.detail ?? '', /\[served: handoff\]/);
});

test('DONE-TEST: a rule whose line is missing REFUSES THE TENANT, it does not quietly downgrade', async () => {
  // Written twice and wrong both times, which is the finding. It first asserted that an
  // UNREVIEWED specific line falls through to the generic one, then that a MISSING one
  // does. Neither happens: `refusal_topic` is a REQUIRED kind because a rule names it, so
  // `renderCannedSection` refuses the whole tenant (`canned_response_missing`) long
  // before any reply is drafted.
  //
  // So the founder's rule is enforced one layer ABOVE this fallback and more strictly
  // than he asked: if a rule can fire, its reviewed line is guaranteed to exist, and a
  // tenant missing one cannot answer at all rather than answering generically. The
  // `prefer` list's fall-through is defence in depth for a kind no rule requires, not a
  // live path. Found by running the test rather than by reasoning about the code.
  const rows = CANNED.filter((c) => c.kind !== 'refusal_topic');
  const { deps: d, drafts } = deps({
    result: { ...OK_REPLY, text: 'Хүүхдийн тайралт 99,999₮ байна.' },
  });
  const r = await handleReception(d, {
    ...base, customerMessage: 'Хүүхдийн үс хэд вэ?', canned: rows,
    tenantGuard: { ...GUARD_VIEW, cannedResponses: rows.map((c) => c.body) },
  });
  assert.equal(r.kind, 'retry');
  assert.match(r.kind === 'retry' ? r.detail : '', /canned_response_missing: refusal_topic/);
  assert.equal(drafts.length, 0, 'nothing is drafted: a downgraded refusal is not served');
});

test('DONE-TEST: A RULE-(4) VIOLATION IS FLAGGED AND THE REPLY IS STILL SENT', async () => {
  // The rule is the founder's, signed and published; compliance was measured at roughly
  // half. This counts it so the next wording change can be judged against a rate rather
  // than against four eyeballed replies.
  //
  // The reply is NOT discarded: its content is right and only its shape is wrong.
  //
  // 44,000 rather than the fixture row's 33,000: the price list's own amount written in the
  // model's words is replaced by the row now (D-120), and this test is about the shape.
  const { deps: d, flags, drafts } = deps({
    result: { ...OK_REPLY, text: 'Тайралт 44,000₮, засалт 22,000₮ байна.' },
  });
  // Both figures must be on the allow-list or check 2 refuses the reply before the style
  // counter is ever reached — which is what the first run of this test measured.
  const twoPrices = { ...GUARD_VIEW, allowedNumbers: ['44,000', '22,000'] };
  // `serviceNames: []` so the PRICE-PRESENTATION guard has nothing to check: this test is
  // about rule (4), and 22,000 is the fixture service's price, so leaving the list in
  // would substitute the price-list rows and the test would stop measuring what it names.
  const r = await handleReception(d, { ...base, serviceNames: [], tenantGuard: twoPrices });
  assert.equal(r.kind, 'drafted');
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model', 'still answered by the model');
  assert.equal(drafts.at(-1)?.body, 'Тайралт 44,000₮, засалт 22,000₮ байна.', 'unedited');
  assert.equal(flags.some((f) => f.code === 'style_price_lines'), true);
});

test('DONE-TEST: AN ALTERED FAQ ANSWER IS REPLACED BY THE PUBLISHED TEXT', async () => {
  // The measured drift: the model reproduced the founder's damaged-hair FAQ and inserted
  // «үзээд». Nothing caught it, because pinning only ever saw canned_responses.
  const FAQ = 'Хуурай, хугарсан үсэнд CICA нөхөн сэргээх эмчилгээ тохиромжтой. '
    + 'Үсэнд тань аль нь тохирохыг мастер үсчин зөвлөж өгнө.';
  const drifted = 'Хуурай, хугарсан үсэнд CICA нөхөн сэргээх эмчилгээ тохиромжтой. '
    + 'Үсэнд тань аль нь тохирохыг мастер үсчин үзээд зөвлөж өгнө.';
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text: drifted } });
  const r = await handleReception(d, { ...base, faqAnswers: [FAQ] });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(drafts.at(-1)?.body, FAQ, 'the PUBLISHED text, served as written');
  const f = flags.find((x) => x.code === 'faq_paraphrased');
  assert.ok(f, 'counted, never a silent correction');
  assert.equal(f?.attempted, drifted, 'quality_flags keeps what the model wrote');
});

test('DONE-TEST: a FAQ answer quoted EXACTLY is not drift and is left alone', async () => {
  const FAQ = 'Хуурай үсэнд CICA эмчилгээ тохиромжтой. Мастер үсчин зөвлөж өгнө.';
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text: FAQ } });
  const r = await handleReception(d, { ...base, faqAnswers: [FAQ] });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model', 'an exact quotation is not drift');
  assert.equal(drafts.at(-1)?.body, FAQ);
  assert.equal(flags.some((x) => x.code === 'faq_paraphrased'), false);
});

test('a reply unrelated to any FAQ is untouched', async () => {
  const { deps: d, flags } = deps({ result: { ...OK_REPLY, text: 'Сайн байна уу.' } });
  await handleReception(d, { ...base, faqAnswers: ['Огт өөр сэдвээр бичсэн урт хариулт байна.'] });
  assert.equal(flags.some((x) => x.code === 'faq_paraphrased'), false);
});

test('DONE-TEST: A BOOKING APOLOGY IS REPLACED BY THE DEPOSIT AND THE LINK', async () => {
  // Three instructions failed at this, the third while containing «УУЧЛАЛТ БҮҮ ГУЙ». End to
  // end through handleReception, because a module test proves the rule and not the wiring.
  const BOOKING = 'Та манай вэбсайтаар (https://x.test/) онлайнаар цаг захиалж болно.';
  // The BASE canned set plus the booking line: the gate requires refusal_topic, and
  // dropping it refuses the whole tenant as canned_response_missing before any draft.
  const rows = [...CANNED, { kind: 'booking_line', body: BOOKING, reviewedAt: REVIEWED }];
  const text = `Уучлаарай, би цаг захиалж чадахгүй. ${BOOKING}`;
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text } });
  const r = await handleReception(d, {
    ...base,
    canned: rows,
    tenantGuard: { ...GUARD_VIEW, cannedResponses: rows.map((c) => c.body), allowedUrls: ['https://x.test/'] },
    depositRows: ['Мастер үсчин: 20,000₮', '1-р зэргийн үсчин: 10,000₮'],
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'deterministic');
  assert.equal(drafts.at(-1)?.body,
    `Мастер үсчин: 20,000₮\n1-р зэргийн үсчин: 10,000₮\n\n${BOOKING}`,
    'the deposit rows then the reviewed line — no new sentence anywhere');
  const f = flags.find((x) => x.code === 'booking_apology');
  assert.ok(f, 'counted, never silent');
  assert.equal(f?.attempted, text, 'quality_flags keeps what the MODEL wrote');
});

test('DONE-TEST: A CROSS-SERVICE RANGE IS REPLACED BY THE PRICE LIST\'S OWN ROWS', async () => {
  // The measured «us budalt» reply, end to end through handleReception — the module test
  // proves the rule, this proves the WIRING, which is the half D-064 keeps finding absent.
  const DYES = [
    { name: 'Дунд үсний будаг', prices: ['176000'], rows: ['Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮'] },
    { name: 'Урт үсний будаг', prices: ['200000'], rows: ['Урт үсний будаг (мөр давсан урттай үс): 200,000₮'] },
  ];
  const { deps: d, flags, drafts } = deps({
    result: { ...OK_REPLY, text: 'Бүтэн будалт (дунд, урт зэргээс шалтгаалан): 176,000₮–200,000₮' },
  });
  const r = await handleReception(d, {
    ...base,
    serviceNames: DYES,
    tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['176,000', '200,000'] },
  });
  assert.equal(r.kind, 'drafted');
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'deterministic',
    'no model text survives, and nothing was spent choosing the rows');
  assert.equal(drafts.at(-1)?.body,
    'Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮\nУрт үсний будаг (мөр давсан урттай үс): 200,000₮',
    'the data\'s own bytes, not a re-rendering');
  const f = flags.find((x) => x.code === 'outbound_price_presentation');
  assert.ok(f, 'the substitution is counted, never silent');
  assert.match(f?.detail ?? '', /cross_service_range/);
  assert.equal(f?.attempted, 'Бүтэн будалт (дунд, урт зэргээс шалтгаалан): 176,000₮–200,000₮',
    'what the MODEL wrote is kept — quality_flags says that, the draft says what was served');
});

test('DONE-TEST: AN AMBIGUOUS OWNER IS COUNTED AND THE REPLY IS LEFT AS WRITTEN', async () => {
  const SHARED = [
    { name: 'CICA нөхөн сэргээх эмчилгээ', prices: ['198000'], rows: ['CICA нөхөн сэргээх эмчилгээ: 198,000₮'] },
    { name: 'Хуримын засалт', prices: ['198000'], rows: ['Хуримын засалт: 198,000₮'] },
  ];
  const text = 'CICA бол хими биш, нэг удаа 198,000₮.';
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text } });
  const r = await handleReception(d, {
    ...base, serviceNames: SHARED, tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['198,000'] },
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model', 'a true answer is not discarded');
  assert.equal(drafts.at(-1)?.body, text, 'left exactly as written');
  const f = flags.find((x) => x.code === 'outbound_price_presentation');
  assert.match(f?.detail ?? '', /owner ambiguous/, 'but it is counted, never silent');
});

test('DONE-TEST: A PRICE VIOLATION IS COUNTED EVEN WHEN ANOTHER PATH REPLACES THE REPLY', async () => {
  // Founder, 2026-09-24: "Count every violation." A FAQ drift is served before the price
  // guard runs, so until now a misplaced price inside it was never counted anywhere.
  const DYES = [
    { name: 'Дунд үсний будаг', prices: ['176000'], rows: ['Дунд үсний будаг: 176,000₮'] },
  ];
  const FAQ = 'Хуурай, хугарсан үсэнд CICA нөхөн сэргээх эмчилгээ тохиромжтой. '
    + 'Үсэнд тань аль нь тохирохыг мастер үсчин зөвлөж өгнө.';
  const drifted = 'Хуурай, хугарсан үсэнд CICA нөхөн сэргээх эмчилгээ тохиромжтой. '
    + 'Үсэнд тань аль нь тохирохыг мастер үсчин үзээд зөвлөж өгнө. Будаг 176,000₮.';
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text: drifted } });
  await handleReception(d, {
    ...base, faqAnswers: [FAQ], serviceNames: DYES, tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['176,000'] },
  });
  assert.equal(drafts.at(-1)?.body, FAQ, 'the FAQ path still serves the published answer');
  const f = flags.find((x) => x.code === PRICE_VIOLATION_FLAG);
  assert.ok(f, 'the misplaced price in the model text is counted anyway');
  assert.match(f?.detail ?? '', /^1 violation\(s\): orphaned/);
  assert.equal(f?.attempted, drifted);
});

test('the counter fires alongside the guard on an ordinary violation, and not on a clean reply', async () => {
  const DYES = [
    { name: 'Дунд үсний будаг', prices: ['176000'], rows: ['Дунд үсний будаг: 176,000₮'] },
    { name: 'Урт үсний будаг', prices: ['200000'], rows: ['Урт үсний будаг: 200,000₮'] },
  ];
  const bad = await (async () => {
    const { deps: d, flags } = deps({ result: { ...OK_REPLY, text: 'Будалт 176,000₮–200,000₮' } });
    await handleReception(d, { ...base, serviceNames: DYES, tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['176,000', '200,000'] } });
    return flags;
  })();
  assert.ok(bad.some((x) => x.code === PRICE_VIOLATION_FLAG));
  assert.ok(bad.some((x) => x.code === 'outbound_price_presentation'));
  const { deps: d, flags } = deps({ result: { ...OK_REPLY, text: 'Дунд үсний будаг: 176,000₮ байна.' } });
  await handleReception(d, { ...base, serviceNames: DYES, tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['176,000'] } });
  assert.equal(flags.some((x) => x.code === PRICE_VIOLATION_FLAG), false);
});

test('DONE-TEST: a correctly presented price is left entirely alone', async () => {
  const DYES = [
    { name: 'Дунд үсний будаг', prices: ['176000'], rows: ['Дунд үсний будаг: 176,000₮'] },
  ];
  const { deps: d, flags, drafts } = deps({
    result: { ...OK_REPLY, text: 'Дунд үсний будаг: 176,000₮ байна.' },
  });
  const r = await handleReception(d, {
    ...base, serviceNames: DYES, tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['176,000'] },
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'model');
  assert.equal(drafts.at(-1)?.body, 'Дунд үсний будаг: 176,000₮ байна.', 'unedited');
  assert.equal(flags.some((x) => x.code === 'outbound_price_presentation'), false);
});

test('DONE-TEST: a compliant reply is not flagged', async () => {
  const { deps: d, flags } = deps({
    result: { ...OK_REPLY, text: 'Тайралт: 33,000₮\nЗасалт: 22,000₮' },
  });
  await handleReception(d, { ...base, serviceNames: [], tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['33,000', '22,000'] } });
  assert.equal(flags.some((f) => f.code === 'style_price_lines'), false);
});

// ---------------------------------------------------------------------------
// D-120: facts come from the data, and a Latin spelling reaches the gate.
// ---------------------------------------------------------------------------

/** Matrix's shape: two services share 132,000, and a range belongs to one of them. */
const PRICED = `STABLE\n=== ${SECTION_LABELS.dataMarker} ===\n=== ${SECTION_LABELS.priceList} ===\n`
  + '- CMC тэжээл: 132,000₮\n- Усан хими: 132,000₮–154,000₮\n'
  + `=== ${SECTION_LABELS.contacts} ===\n- Утас: 76001888, 80905498`;

test('DONE-TEST: A PRICE IN THE MODEL\'S OWN WORDS IS REPLACED BY ITS ROW (live «usnii himi»)', async () => {
  // Measured 2026-09-24 on the first live night: «usnii himi» got «Усны хими 132,000₮–154,000₮
  // байна.» — two real prices under a service name that does not exist, sent as written
  // because 132,000 has two owners and the presentation guard would not guess. The range
  // names one row; that row is what the customer gets.
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text: 'Усны хими 132,000₮–154,000₮ байна.' } });
  const r = await handleReception(d, {
    ...base, customerMessage: 'usnii himi', promptStable: PRICED, serviceNames: [],
    tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['132,000', '154,000'] },
  });
  assert.equal(r.kind, 'drafted');
  assert.equal(drafts.at(-1)?.body, 'Усан хими: 132,000₮–154,000₮');
  assert.equal(drafts.at(-1)?.answeredBy, 'deterministic', 'no model wording survives');
  const f = flags.find((x) => x.code === 'fact_restated');
  assert.ok(f !== undefined, 'the restatement is counted');
  assert.equal(f?.attempted, 'Усны хими 132,000₮–154,000₮ байна.', 'with what the model wrote');
});

test('a price row quoted whole, and the phone number as written, are sent untouched', async () => {
  const text = 'Усан хими: 132,000₮–154,000₮. Дэлгэрэнгүйг 76001888 дугаараас асуугаарай.';
  const { deps: d, flags, drafts } = deps({ result: { ...OK_REPLY, text } });
  await handleReception(d, {
    ...base, customerMessage: 'usnii himi', promptStable: PRICED, serviceNames: [],
    tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['132,000', '154,000', '76001888'] },
  });
  assert.equal(drafts.at(-1)?.body, text);
  assert.equal(drafts.at(-1)?.answeredBy, 'model');
  assert.equal(flags.some((x) => x.code === 'fact_restated'), false);
});

test('DONE-TEST: A SETTLED LATIN SPELLING REACHES THE CHILDREN\'S RULE, AND ONLY WITH THE ROW', async () => {
  // D-067 measured it: «huuhdiin us zasuulna» fires no Cyrillic stem, so the founder's
  // children's rule never fired for it. The spelling list (D-120) is what closes it — and a
  // test that passed without the row would be testing nothing.
  const opted: GateRule = { ...CHILDREN, deterministicShortcircuit: true };
  const without = deps();
  await handleReception(without.deps, { ...base, customerMessage: 'huuhdiin us zasuulna', rules: [opted] });
  assert.equal(without.drafts.at(-1)?.body === CANNED[1]?.body, false, 'no row, no refusal');

  const withRow = deps();
  const r = await handleReception(withRow.deps, {
    ...base, customerMessage: 'huuhdiin us zasuulna', rules: [opted],
    spellings: [{ latin: 'huuhdiin', cyrillic: 'хүүхдийн' }],
  });
  assert.equal(r.kind === 'drafted' && r.answeredBy, 'canned');
  assert.equal(withRow.drafts.at(-1)?.body, CANNED[1]?.body);
  assert.deepEqual(withRow.calls, ['release', 'draft:canned'], 'answered from the row, no model call');
});

test('restated set prices are served the tenant\'s way: its order, then its question', async () => {
  const SET: DeterministicRule = {
    intent: 'dye_prices', body: 'Та бүтэн будуулах уу?', enabled: true, matchMode: 'contains_stem',
    stems: ['будагны үнэ'], coverWords: [], placement: 'replace',
    quoteServices: ['Үсний угийн будаг', 'Урт үсний будаг'], requiresEmptyHistory: false, provenance: 'tenant_confirmed',
  };
  const prefix = `STABLE\n=== ${SECTION_LABELS.dataMarker} ===\n=== ${SECTION_LABELS.priceList} ===\n`
    + '- Урт үсний будаг: 200,000₮\n- Үсний угийн будаг: 135,000₮';
  // The model's own labels for the two rows, longest first — measured on Matrix 2026-09-24.
  const { deps: d, drafts } = deps({ result: { ...OK_REPLY, text: 'Далнаас доош 200,000₮, хүзүүний урт 135,000₮ будаг.' } });
  await handleReception(d, {
    ...base, customerMessage: 'Будаг хэд вэ?', promptStable: prefix, deterministic: [SET],
    serviceNames: [
      { name: 'Урт үсний будаг', prices: ['200000'], rows: ['Урт үсний будаг: 200,000₮'] },
      { name: 'Үсний угийн будаг', prices: ['135000'], rows: ['Үсний угийн будаг: 135,000₮'] },
    ],
    tenantGuard: { ...GUARD_VIEW, allowedNumbers: ['200,000', '135,000'] },
  });
  assert.equal(drafts.at(-1)?.body, 'Үсний угийн будаг: 135,000₮\nУрт үсний будаг: 200,000₮\n\nТа бүтэн будуулах уу?');
});

// Founder, 2026-09-25 (D-126 addendum): "when the checker is unsure, send the general line,
// never a wrong approved line." Matrix's live rows and the live holiday reply (flag 154).
const LIVE_HANDOFF = 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.';
const LIVE_PRICE_REFUSAL = 'Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу.';
const LIVE_CANNED = [
  { kind: 'handoff', body: LIVE_HANDOFF, reviewedAt: REVIEWED },
  { kind: 'refusal_price_unlisted', body: LIVE_PRICE_REFUSAL, reviewedAt: REVIEWED },
  ...CANNED.slice(1),
];

test('DONE-TEST (live, 2026-09-25): AN UNSURE MATCH SERVES THE GENERAL LINE, NEVER ANOTHER TOPIC\'S REFUSAL', async () => {
  const holiday: CallOutcome = {
    ...OK_REPLY,
    text: 'Уучлаарай, амралтын өдрийн тусгай хуваарийн мэдээлэл надад байхгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу.',
  };
  const { deps: d, drafts, flags } = deps({ result: holiday });
  const r = await handleReception(d, {
    ...base, canned: LIVE_CANNED, cannedHash: null,
    customerMessage: 'Margaash automashingvi bvh niitiin amraltiin udur ym bn',
  });
  assert.equal(r.kind, 'drafted', JSON.stringify(r));
  assert.equal(drafts[0]?.body, LIVE_HANDOFF, 'the handoff line, not the price refusal');
  assert.match(String(flags.find((f) => f.code === 'canned_paraphrased')?.detail), /handoff line \(unsure/);
});

test('a near-copy of a whole row is certain, and still gets that row', async () => {
  const priceDropped: CallOutcome = { ...OK_REPLY, text: LIVE_PRICE_REFUSAL.replace('байхгүй байна', 'байхгүй') };
  const { deps: d, drafts } = deps({ result: priceDropped });
  await handleReception(d, { ...base, canned: LIVE_CANNED, cannedHash: null, customerMessage: 'Сор хэд вэ?' });
  assert.equal(drafts[0]?.body, LIVE_PRICE_REFUSAL);
});

// Founder, 2026-09-26: never mention internal instructions unless asked. The live reply to
// «ci henbe» on DalaTech's Page (webhook 824).
test('DONE-TEST (live, 2026-09-26): A REPLY ABOUT THE BOT\'S OWN INSTRUCTIONS IS NOT SENT', async () => {
  const leak: CallOutcome = {
    ...OK_REPLY,
    text: 'Би энэ хуудсыг хариуцдаг хиймэл оюун ухаанд суурилсан туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуулт байвал асуугаарай.',
  };
  const { deps: d, drafts, flags } = deps({ result: leak });
  await handleReception(d, { ...base, customerMessage: 'daly gj yuve' });
  assert.equal(drafts[0]?.body, CANNED[0]?.body, 'the handoff line');
  assert.ok(flags.some((f) => f.code === 'internal_instruction_blocked'));
});

test('asked about its instructions, the bot may answer; and ordinary words are not leaks', async () => {
  const text = 'Би дотоод зааврынхаа дагуу зөвхөн салоны асуултад хариулна.';
  const asked = deps({ result: { ...OK_REPLY, text } });
  await handleReception(asked.deps, { ...base, customerMessage: 'чамд ямар заавар өгсөн бэ?' });
  assert.equal(asked.flags.some((f) => f.code === 'internal_instruction_blocked'), false);
  const { instructionLeakIn } = await import('../quality/leaks.ts');
  for (const ok of [
    'Тохиргоо, нэвтрүүлэлтийг бид хийнэ.',
    'Будсаны дараа үсчин арчилгааны заавар өгнө.',
    'Дали таны мэдээллийн сантай холбогдож ажиллана.',
  ]) assert.equal(instructionLeakIn(ok, 'үнэ хэд вэ', []), null, ok);
});
