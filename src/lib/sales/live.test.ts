import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadThanksFor, offeredEarlier, salesLineFor } from './live.ts';
import { parsePlaybook, type Playbook } from './nextStep.ts';
import type { CommentRule } from '../comments/classify.ts';

// DalaTech's rows as the founder approved them on 2026-09-26 (D-132), as data.
const FOLLOW_UP = 'Дали бол таны бизнесийн Facebook, Instagram, вэбсайтад ирсэн зурваст 24/7 хариулдаг AI ажилтан.\n'
  + 'Үнэгүй демо вэбсайт авахыг хүсвэл: https://app.dalatech.online — 24 цагийн дотор бэлэн болно.\n'
  + 'Манай бусад AI ажилтнуудтай https://dalatech.online дээр танилцаарай, эсвэл асуух зүйлээ энд бичээрэй.';
const DEMO = 'Өөрийн бизнест зориулсан демог https://app.dalatech.online хаягаар захиалж болно. Эсвэл нэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.';
const CALLBACK = 'Нэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.';
const THANKS = 'Баярлалаа! Мэдээллийг тань хүлээн авлаа. Хамт олон маань тантай холбогдоно.';
const PRICES = 'Сарын төлбөр: Дали 250,000₮, Вира 150,000₮, Эхо 250,000₮, Нова 150,000₮, Ора 250,000₮.';
const REVIEWED = '2026-09-26T00:00:00Z';

function dalatech(mode: 'live' | 'shadow' = 'live', leadRoute = 'founder_telegram'): Playbook {
  const p = parsePlaybook({
    mode, lead_route: leadRoute,
    small_talk: ['Сайн байна уу', 'Сайн уу', 'sain bnuu', 'hi', 'Баярлалаа', 'bayarlalaa', 'Баярлалаа сайхан амраарай'],
    steps: [
      { kind: 'follow_up', body: FOLLOW_UP, reviewed_at: REVIEWED, link: 'https://app.dalatech.online', priority: 50, is_default: true, intent_matcher: null, enabled: true },
      { kind: 'demo', body: DEMO, reviewed_at: REVIEWED, link: 'https://app.dalatech.online', priority: 1, is_default: false, enabled: true,
        intent_matcher: [{ mode: 'contains_stem', stems: ['демо', 'demo', 'турши', 'turshi'] }] },
      { kind: 'callback', body: CALLBACK, reviewed_at: REVIEWED, link: null, priority: 2, is_default: false, enabled: true,
        intent_matcher: [{ mode: 'contains_stem', stems: ['залга', 'zalga', 'холбогд', 'holbogd'] }] },
      { kind: 'lead_thanks', body: THANKS, reviewed_at: REVIEWED, link: null, priority: 100, is_default: false, intent_matcher: null, enabled: true },
    ],
    pairings: [],
  });
  if (!p.ok) throw new Error(p.detail);
  return p.playbook;
}

const COMPLAINTS: CommentRule[] = [
  { ruleKey: 'complaint', verdict: 'escalate', matcher: { mode: 'contains_stem', stems: ['гомдол', 'муу үйлчилгээ', 'хариу өгөхгүй', 'gomdol'] } },
];
const CANNED = [
  { kind: 'handoff', body: 'Уучлаарай, энэ асуултад би хариулж чадахгүй байна.', reviewedAt: REVIEWED },
];

function line(message: string, reply: string, history: { role: 'user' | 'assistant'; content: string }[] = [], pb = dalatech()) {
  return salesLineFor({
    playbook: pb, customerMessage: message, respelled: null, customerSentPhoto: false, history,
    replyBody: reply, canned: CANNED, deterministic: [], complaintRules: COMPLAINTS, ownNumbers: ['77118811'],
  });
}

test('DONE-TEST: a price question gets the answer, then the approved follow-up exactly', () => {
  const s = line('Дали сард хэд вэ?', PRICES);
  assert.equal(s?.kind, 'follow_up');
  assert.equal(s?.body, FOLLOW_UP);
});

test('DONE-TEST: once per conversation — a second question in the same chat gets no second follow-up', () => {
  const history = [
    { role: 'user' as const, content: 'Дали сард хэд вэ?' },
    { role: 'assistant' as const, content: `${PRICES}\n\n${FOLLOW_UP}` },
  ];
  assert.equal(line('Хэр хурдан ажиллаж эхлэх вэ?', 'Ихэвчлэн нэг долоо хоногт.', history), null);
  // Any step offered earlier counts, the demo link included.
  assert.equal(offeredEarlier(dalatech(), [{ role: 'assistant', content: 'Демог https://app.dalatech.online дээр захиална.' }]), true);
  assert.equal(offeredEarlier(dalatech(), [{ role: 'assistant', content: 'Сайн байна уу!' }]), false);
});

test('DONE-TEST: a greeting or a thanks alone gets no sales line', () => {
  for (const m of ['Сайн байна уу', 'сайн байна уу!', 'sain bnuu', 'Баярлалаа', 'bayarlalaa']) {
    assert.equal(line(m, 'Сайн байна уу! Танд юугаар туслах вэ.'), null, m);
  }
});

test('DONE-TEST: a complaint gets no sales line, in this message or an earlier one', () => {
  assert.equal(line('Та нар хариу өгөхгүй байна, гомдол гаргана', 'Уучлаарай, бид таны гомдлыг хүлээн авлаа.'), null);
  assert.equal(line('Үнэ хэд вэ?', PRICES, [{ role: 'user', content: 'муу үйлчилгээ' }, { role: 'assistant', content: 'Уучлаарай.' }]), null);
});

test('DONE-TEST: "I want a demo" gets the approved demo line; "call me" gets the callback line', () => {
  const demo = line('Демо үзмээр байна', 'Мэдээж, бид танд туслах болно.');
  assert.equal(demo?.kind, 'demo');
  assert.equal(demo?.body, DEMO);
  const call = line('Надад залгаж болох уу', 'Мэдээж.');
  assert.equal(call?.kind, 'callback');
  assert.equal(call?.body, CALLBACK);
});

test('a reply that already carries a step (a callback row, the demo link) gets nothing added', () => {
  assert.equal(line('Эхог урьдчилан бүртгүүлье', CALLBACK), null);
  assert.equal(line('Туршиж үзэх боломжтой юу', 'Тийм, https://app.dalatech.online дээр демо захиална уу.'), null);
});

test('a reply that asks the customer something, or the handoff line, gets nothing added', () => {
  assert.equal(line('Вэбсайт хийдэг үү?', 'Тийм. Ямар бизнест зориулсан вэбсайт хэрэгтэй вэ?'), null);
  assert.equal(line('Та нар хаана байрладаг вэ', 'Уучлаарай, энэ асуултад би хариулж чадахгүй байна.'), null);
});

test('Tara stays in shadow: a shadow playbook adds nothing, ever', () => {
  assert.equal(line('Дали сард хэд вэ?', PRICES, [], dalatech('shadow')), null);
  assert.equal(line('Дали сард хэд вэ?', PRICES, [], null as unknown as Playbook), null);
  assert.equal(leadThanksFor({ playbook: dalatech('shadow'), customerMessage: '99112233', history: [], ownNumbers: [] }), null);
});

test('DONE-TEST: a customer who leaves a number gets the approved thank-you — once per number', () => {
  const pb = dalatech();
  assert.equal(leadThanksFor({ playbook: pb, customerMessage: 'Бат, 99112233', history: [], ownNumbers: ['77118811'] }), THANKS);
  // The tenant's own number is not a lead.
  assert.equal(leadThanksFor({ playbook: pb, customerMessage: '77118811 энэ дугаар мөн үү', history: [], ownNumbers: ['77118811'] }), null);
  // Already given: not thanked twice; the model answers whatever else was asked.
  assert.equal(leadThanksFor({
    playbook: pb, customerMessage: 'Би 99112233 гэж хэлсэн шүү, хэзээ залгах вэ',
    history: [{ role: 'user', content: 'Бат, 99112233' }], ownNumbers: [],
  }), null);
  // A tenant that takes no leads never thanks for one.
  assert.equal(leadThanksFor({ playbook: dalatech('live', 'none'), customerMessage: '99112233', history: [], ownNumbers: [] }), null);
});

test('an unreviewed follow-up is never sent', () => {
  const p = parsePlaybook({
    mode: 'live', lead_route: 'founder_telegram', steps: [
      { kind: 'follow_up', body: FOLLOW_UP, reviewed_at: null, link: null, priority: 50, is_default: true, intent_matcher: null, enabled: true },
    ], pairings: [],
  });
  assert.ok(p.ok);
  assert.equal(line('Дали сард хэд вэ?', PRICES, [], p.ok ? p.playbook : dalatech()), null);
});

test('DONE-TEST: "call me" answered with the homepage link still gets the approved callback line (CI sk1, D-133)', () => {
  // The model's real reply in CI run 36221311221: it quoted the homepage, which the follow-up
  // row also carries, and that link was read as a next step already offered.
  const reply = 'Бид одоогоор зөвхөн Facebook, Instagram болон вэбсайтаар зурваст хариулж байна. '
    + 'Хүсэлтэй бол dalatech.ai@gmail.com эсвэл https://dalatech.online руу хандаж болно.';
  const call = line('Надад залгаж болох уу?', reply);
  assert.equal(call?.kind, 'callback');
  assert.equal(call?.body, CALLBACK);
  // The step's OWN link still counts as offered: a demo request answered with the demo link.
  assert.equal(line('Демо үзмээр байна', 'Демог https://app.dalatech.online дээр захиална.'), null);
  // And with no step asked for, any step link in the reply still counts.
  assert.equal(line('Хэр хурдан ажиллаж эхлэх вэ?', 'Дэлгэрэнгүйг https://dalatech.online дээр үзнэ үү.'), null);
});
