import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReply, decide, leadDetail, nextStepDetail, parsePlaybook, rowState, stepHosts,
  type DecisionInput, type Playbook, type ReplyFacts,
} from './nextStep.ts';
import type { CommentRule } from '../comments/classify.ts';

// A playbook written the way a tenant's rows are: a default booking step, a callback step
// with intent words, the two lines that are not next steps, and one pairing. No tenant.
function playbook(over: Partial<{ route: string; bodies: boolean; reviewed: boolean }> = {}): Playbook {
  const body = (s: string): string | null => (over.bodies === true ? s : null);
  const reviewed = over.reviewed === true ? '2026-09-26T00:00:00Z' : null;
  const p = parsePlaybook({
    mode: 'shadow',
    lead_route: over.route ?? 'tenant_telegram',
    steps: [
      {
        kind: 'booking', priority: 1, is_default: true, link: 'https://booking.example.mn/', enabled: true,
        body: body('ЗАХИАЛГЫН МӨР'), reviewed_at: reviewed,
        intent_matcher: [
          { mode: 'contains_stem', stems: ['захиал', 'zahial'] },
          { mode: 'stem_sequence', stems: ['цаг', 'ав'], windowCp: 12 },
        ],
      },
      {
        kind: 'callback', priority: 2, is_default: false, link: null, enabled: true,
        body: body('ЗАЛГАХ МӨР'), reviewed_at: reviewed,
        intent_matcher: [
          { mode: 'contains_stem', stems: ['залга', 'дугаар', 'dugaar'] },
          { mode: 'has_word', words: ['утас', 'utas'] },
        ],
      },
      { kind: 'related_service', priority: 100, is_default: false, intent_matcher: null, body: null, reviewed_at: null },
      { kind: 'lead_thanks', priority: 100, is_default: false, intent_matcher: null, body: null, reviewed_at: null },
    ],
    pairings: [{ service_name: 'Эрэгтэй тайралт', related_name: 'Сахал засах', enabled: true, provenance: 'seeded' }],
  });
  if (!p.ok) throw new Error(p.detail);
  return p.playbook;
}

const COMPLAINTS: CommentRule[] = [
  { ruleKey: 'complaint', verdict: 'escalate', matcher: { mode: 'contains_stem', stems: ['гомдол', 'gomdol'] } },
  { ruleKey: 'praise', verdict: 'ignore', matcher: { mode: 'contains_stem', stems: ['гоёзүйл'] } },
];

const ANSWER: ReplyFacts = { exists: true, cannedKinds: [], refusal: false, asksQuestion: false, smallTalk: false, carriesStepLink: false };

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    playbook: playbook(),
    customerMessage: 'Эмэгтэй тайралт хэд вэ',
    customerSentPhoto: false,
    earlierCustomerMessages: [],
    reply: ANSWER,
    threadControl: 'unknown',
    offeredBefore: false,
    leadBefore: false,
    complaintRules: COMPLAINTS,
    ownNumbers: ['76001888', '80905498'],
    serviceNames: ['Эмэгтэй тайралт', 'Эрэгтэй тайралт', 'Сахал засах', 'Сор'],
    ...over,
  };
}

test('an answered question gets the DEFAULT step, and says its row is unwritten', () => {
  const d = decide(input());
  assert.deepEqual(d.nextStep, { verdict: 'offer', kind: 'booking', chosenBy: 'default', row: 'unwritten' });
  assert.equal(d.lead.detected, false);
});

test("intent words choose the step: «dugaar» asks for a call-back, Latin or Cyrillic", () => {
  for (const m of ['Sn bnu Badmaa stylestiin dugaar hed we', 'Яармаг салбарын утас хэд вэ', 'залгаж болох уу']) {
    const d = decide(input({ customerMessage: m }));
    assert.equal(d.nextStep.verdict === 'offer' && d.nextStep.kind, 'callback', m);
    assert.equal(d.nextStep.verdict === 'offer' && d.nextStep.chosenBy, 'intent', m);
  }
});

test('when two steps fire, the lower priority wins: a booking request that also asks the number books', () => {
  const d = decide(input({ customerMessage: 'Цаг захиалмаар байна, утас хэд вэ?' }));
  assert.equal(d.nextStep.verdict === 'offer' && d.nextStep.kind, 'booking');
  assert.equal(d.nextStep.verdict === 'offer' && d.nextStep.chosenBy, 'intent');
});

test('the respelled message counts for intent words (D-120)', () => {
  const d = decide(input({ customerMessage: 'dugaaraa ugnu uu', respelled: null }));
  assert.equal(d.nextStep.verdict === 'offer' && d.nextStep.kind, 'callback');
  const e = decide(input({ customerMessage: 'tsag zahialay', respelled: 'цаг захиалъя' }));
  assert.equal(e.nextStep.verdict === 'offer' && e.nextStep.kind, 'booking');
});

test('EVERY skip reason, in the order the founder listed them', () => {
  const cases: [Partial<DecisionInput>, string][] = [
    [{ reply: { exists: false } }, 'no_reply'],
    [{ threadControl: 'human' }, 'person_in_thread'],
    [{ customerMessage: 'Гомдол гаргамаар байна' }, 'complaint'],
    [{ earlierCustomerMessages: ['gomdol bn'] }, 'complaint_earlier'],
    [{ customerMessage: 'Миний дугаар 9911 2233' }, 'lead_given'],
    [{ earlierCustomerMessages: ['99112233'] }, 'lead_given_earlier'],
    [{ leadBefore: true }, 'lead_given_earlier'],
    [{ customerSentPhoto: true }, 'image_line'],
    [{ reply: { ...ANSWER, cannedKinds: ['image_received'] } }, 'image_line'],
    [{ reply: { ...ANSWER, cannedKinds: ['handoff'] } }, 'refusal_or_handoff'],
    [{ reply: { ...ANSWER, cannedKinds: ['refusal_price_unlisted'] } }, 'refusal_or_handoff'],
    [{ reply: { ...ANSWER, refusal: true } }, 'refusal_or_handoff'],
    [{ offeredBefore: true }, 'already_offered'],
    [{ reply: { ...ANSWER, asksQuestion: true } }, 'reply_asks'],
    [{ reply: { ...ANSWER, smallTalk: true } }, 'small_talk'],
    [{ customerSmallTalk: true }, 'small_talk'],
    [{ customerMessage: 'л' }, 'no_content'],
  ];
  for (const [over, reason] of cases) {
    const d = decide(input(over));
    assert.deepEqual(d.nextStep, { verdict: 'skip', reason }, reason);
  }
});

test('a reply that already carries the step link counts as offered, not as a new offer', () => {
  const d = decide(input({ reply: { ...ANSWER, carriesStepLink: true } }));
  assert.deepEqual(d.nextStep, { verdict: 'in_reply' });
});

test('a complaint outranks a phone number: no next step, but the lead is still recorded', () => {
  const d = decide(input({ customerMessage: 'гомдолтой байна, 99112233 руу залга' }));
  assert.deepEqual(d.nextStep, { verdict: 'skip', reason: 'complaint' });
  assert.equal(d.lead.detected, true);
});

test('a malformed escalate rule counts as a complaint — never sell on a rule nobody can read', () => {
  const d = decide(input({ complaintRules: [{ ruleKey: 'broken', verdict: 'escalate', matcher: { mode: 'contains_stem', stems: ['аа'] } }] }));
  assert.deepEqual(d.nextStep, { verdict: 'skip', reason: 'complaint' });
});

test('ONCE per conversation: the second answered turn is already_offered', () => {
  const first = decide(input());
  assert.equal(first.nextStep.verdict, 'offer');
  const second = decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ', offeredBefore: true }));
  assert.deepEqual(second.nextStep, { verdict: 'skip', reason: 'already_offered' });
});

test('the lead: masked, route recorded, repeat known, own numbers excluded', () => {
  const d = decide(input({ customerMessage: 'Бат байна, 8811-2233 руу залгаарай' }));
  assert.equal(d.lead.detected, true);
  if (!d.lead.detected) return;
  assert.deepEqual(d.lead.masked, ['8811****']);
  assert.equal(d.lead.withWords, true);
  assert.equal(d.lead.repeat, false);
  assert.equal(d.lead.route, 'tenant_telegram');
  assert.equal(d.lead.thanksRow, 'unwritten');
  const again = decide(input({ customerMessage: '88112233', earlierCustomerMessages: ['Бат байна, 8811-2233'] }));
  assert.equal(again.lead.detected && again.lead.repeat, true);
  assert.equal(again.lead.detected && again.lead.withWords, false);
  assert.equal(decide(input({ customerMessage: '76001888 руу залгасан' })).lead.detected, false);
});

test('the related service: only a UNIQUE listed name the tenant pairs, once, never under a skip', () => {
  const d = decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ' }));
  assert.deepEqual(d.related, { from: 'Эрэгтэй тайралт', to: 'Сахал засах', confirmed: false, row: 'unwritten' });
  // Independent of the next step: suggested on a later turn too.
  assert.notEqual(decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ', offeredBefore: true })).related, null);
  assert.equal(decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ', relatedBefore: true })).related, null);
  assert.equal(decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ', reply: { ...ANSWER, cannedKinds: ['handoff'] } })).related, null);
  assert.equal(decide(input({ customerMessage: 'Эмэгтэй тайралт хэд вэ' })).related, null, 'no pairing');
  assert.equal(decide(input({ customerMessage: 'тайралт хэд вэ' })).related, null, 'not unique');
  assert.equal(decide(input({ customerMessage: 'сорри' })).related, null);
  // A pairing whose related service is not on the list is inert.
  assert.equal(decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ', serviceNames: ['Эрэгтэй тайралт'] })).related, null);
});

test('row states: missing, unwritten, unreviewed, reviewed', () => {
  assert.equal(rowState(playbook().steps, 'demo'), 'missing');
  assert.equal(rowState(playbook().steps, 'booking'), 'unwritten');
  assert.equal(rowState(playbook({ bodies: true }).steps, 'booking'), 'unreviewed');
  assert.equal(rowState(playbook({ bodies: true, reviewed: true }).steps, 'booking'), 'reviewed');
});

test('parsePlaybook: live exists since 0054 (D-132), an unknown mode does not, and a bad intent refuses the whole playbook', () => {
  const base = { lead_route: 'founder_telegram', steps: [], pairings: [] };
  assert.equal(parsePlaybook({ ...base, mode: 'live' }).ok, true);
  assert.equal(parsePlaybook({ ...base, mode: 'on' }).ok, false);
  assert.equal(parsePlaybook({ ...base, mode: 'shadow', lead_route: 'email' }).ok, false);
  const bad = parsePlaybook({
    ...base, mode: 'shadow',
    steps: [{ kind: 'demo', intent_matcher: [{ mode: 'contains_stem', stems: ['дэ'] }] }],
  });
  assert.equal(bad.ok, false);
  const empty = parsePlaybook({ ...base, mode: 'shadow', steps: [{ kind: 'demo', intent_matcher: [] }] });
  assert.equal(empty.ok, false);
  const single = parsePlaybook({
    ...base, mode: 'shadow',
    steps: [{ kind: 'demo', is_default: true, intent_matcher: { mode: 'contains_stem', stems: ['демо'] } }],
  });
  assert.equal(single.ok && single.playbook.steps[0]?.intent?.length, 1);
  assert.equal(parsePlaybook({ ...base, mode: 'shadow', steps: [{ kind: 'sms' }] }).ok, false);
});

test('a tenant with no default and no intent fired is recorded as unconfigured, not guessed', () => {
  const p = parsePlaybook({
    mode: 'shadow', lead_route: 'founder_telegram', pairings: [],
    steps: [{ kind: 'callback', is_default: false, intent_matcher: [{ mode: 'contains_stem', stems: ['залга'] }] }],
  });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(decide(input({ playbook: p.playbook })).nextStep, { verdict: 'skip', reason: 'no_step_configured' });
});

test('classifyReply: exact questions only', () => {
  const canned = [
    { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.', reviewedAt: '2026-09-01' },
    { kind: 'refusal_topic', body: 'Хүүхдийн үйлчилгээ байхгүй.', reviewedAt: null },
  ];
  const hosts = stepHosts(playbook().steps);
  assert.deepEqual(hosts, ['booking.example.mn']);
  const r = classifyReply({
    body: 'Сайн байна уу! Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Хүүхдийн үйлчилгээ байхгүй.',
    refusal: false, canned, smallTalkBodies: [], hosts,
  });
  assert.ok(r.exists);
  if (!r.exists) return;
  assert.deepEqual(r.cannedKinds, ['handoff'], 'an unreviewed row is not a reviewed line');
  assert.equal(r.asksQuestion, false);
  const q = classifyReply({ body: 'Танд юугаар туслах вэ? 😊', refusal: false, canned, smallTalkBodies: [], hosts });
  assert.equal(q.exists && q.asksQuestion, true, 'an emoji after the question mark is still a question');
  const link = classifyReply({ body: 'Цагаа https://Booking.example.mn/ хаягаар захиална уу.', refusal: false, canned, smallTalkBodies: [], hosts });
  assert.equal(link.exists && link.carriesStepLink, true);
  const st = classifyReply({ body: ' Сайн байна уу! Танд юугаар туслах вэ?', refusal: false, canned, smallTalkBodies: ['Сайн байна уу! Танд юугаар туслах вэ?'], hosts });
  assert.equal(st.exists && st.smallTalk, true);
  assert.deepEqual(classifyReply({ body: null, refusal: false, canned, smallTalkBodies: [], hosts }), { exists: false });
});

test('stepHosts never reads a Cyrillic sentence as a host', () => {
  const p = parsePlaybook({
    mode: 'shadow', lead_route: 'founder_telegram', pairings: [],
    steps: [{ kind: 'demo', is_default: true, intent_matcher: null, body: 'Манай салон.Та https://app.example.online хаягаар', link: null }],
  });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(stepHosts(p.playbook.steps), ['app.example.online']);
});

test('THE RECORD carries kinds and ids, never customer text and never a phone digit run', () => {
  const d = decide(input({ customerMessage: 'Эрэгтэй тайралт хэд вэ, миний утас 9911 2233' }));
  const n = JSON.stringify(nextStepDetail(d, { outbound_id: 'om-1', mode: 'shadow' }));
  assert.ok(!n.includes('9911 2233') && !/\d{5,}/u.test(n.replace('om-1', '')), n);
  assert.ok(!n.includes('хэд вэ'), n);
  assert.ok(d.lead.detected);
  if (!d.lead.detected) return;
  const l = JSON.stringify(leadDetail(d.lead, { outbound_id: 'om-1' }));
  assert.ok(l.includes('9911****'));
  assert.ok(!/\d{5,}/u.test(l), l);
});

test('a tenant that takes no leads: booking is the only step, a number is detected but routed nowhere', () => {
  // Tara, 2026-09-26: the salon's staff do not call back. The callback and lead_thanks rows
  // are gone and lead_route is `none` (0053). «dugaar» used to choose the call-back step.
  const p = parsePlaybook({
    mode: 'shadow', lead_route: 'none',
    steps: [{
      kind: 'booking', priority: 1, is_default: true, link: 'https://booking.example.mn/', enabled: true,
      body: 'ЗАХИАЛГЫН МӨР', reviewed_at: '2026-09-26T00:00:00Z',
      intent_matcher: [{ mode: 'contains_stem', stems: ['захиал'] }],
    }],
    pairings: [],
  });
  assert.ok(p.ok, p.ok ? '' : p.detail);
  const pb = p.ok ? p.playbook : playbook();
  for (const m of ['Sn bnu Badmaa stylestiin dugaar hed we', 'залгаж болох уу', 'Эмэгтэй тайралт хэд вэ']) {
    const d = decide(input({ playbook: pb, customerMessage: m }));
    assert.equal(d.nextStep.verdict === 'offer' && d.nextStep.kind, 'booking', m);
  }
  const lead = decide(input({ playbook: pb, customerMessage: 'Миний дугаар 99112233' })).lead;
  assert.equal(lead.detected && lead.route, 'none');
  assert.equal(lead.detected && lead.thanksRow, 'missing');
});
