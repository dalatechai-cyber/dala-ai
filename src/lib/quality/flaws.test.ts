import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFlaws, previousDate, renderFlawReport, type FlawPair, type FlawSignals } from './flaws.ts';

const SIGNALS: FlawSignals = {
  handoff: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна.',
  refusals: [{ kind: 'refusal_topic', body: 'Хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.' }],
  correctionStems: ['bish', 'биш', 'буруу'],
  correctionBodies: ['Уучлаарай, би буруу ойлгосон байна.'],
  apologyStems: ['Уучлаарай'],
  refusalMarker: 'гүй',
};
const at = (m: number) => new Date(Date.UTC(2026, 8, 24, 22, m));
function pair(ref: string, customer: string, reply: string, m: number): FlawPair {
  return { ref, conversationId: 'c1', customer, reply, at: at(m), replyAt: at(m) };
}

test('DONE-TEST: THE FIRST LIVE NIGHT\'S CONVERSATION IS FLAGGED FOR THE RIGHT REASONS', () => {
  // The founder's own test thread, 2026-09-24 21:55–21:58 UTC, as it was answered.
  const pairs = [
    pair('dd722f47', 'tnah matrix salonu', 'Уучлаарай, таны асуултыг сайн ойлгосонгүй. Та манай салоны үйлчилгээний талаар асуугаарай.', 1),
    pair('e68092d0', 'une hedve', 'Та ямар үйлчилгээний үнэ асууж байгаагаа тодруулж хэлнэ үү?', 2),
    pair('1e84c416', 'usnii himi', 'Усны хими 132,000₮–154,000₮ байна.', 3),
    pair('c45f106b', 'cmg hen hiisen be', 'Уучлаарай, энэ талаар хуваалцах боломжгүй.', 5),
    pair('359cb5d8', 'sain bnuu', 'Сайн байна уу! Танд юугаар туслах вэ?', 0),
  ];
  const inbound = [
    ...pairs.map((p) => ({ conversationId: p.conversationId, body: p.customer, at: p.at })),
    { conversationId: 'c1', body: 'us bish usnii himi', at: at(4) },
    { conversationId: 'c1', body: 'une hedve', at: at(20) },
  ];
  const got = Object.fromEntries(detectFlaws(pairs, inbound, SIGNALS).map((f) => [f.pair.ref, f.reasons]));
  assert.deepEqual(got, {
    dd722f47: ['refusal (own words)', "didn't understand"],
    e68092d0: ['repeated', "didn't understand"],
    '1e84c416': ['corrected'],
    c45f106b: ['refusal (own words)'],
  });
});

test('handoff and reviewed refusals are named by their row', () => {
  const flaws = detectFlaws([
    pair('a', 'x', SIGNALS.handoff as string, 1),
    pair('b', 'хүүхдийн үс', `Сайн байна уу. ${SIGNALS.refusals[0]?.body}`, 2),
  ], [], SIGNALS);
  assert.deepEqual(flaws.map((f) => f.reasons), [['handoff'], ['refusal (topic)']]);
});

test('the report shows the customer, the bot and the ref, and a clean day still says so', () => {
  const [flaw] = detectFlaws([pair('1e84c416', 'usnii himi', 'Усны хими 132,000₮–154,000₮ байна.', 3)],
    [{ conversationId: 'c1', body: 'us bish', at: at(4) }], SIGNALS);
  const text = renderFlawReport([
    { ok: true, name: 'Matrix Eco Salon', slug: 'matrix-eco-salon', date: '2026-09-25', replies: 7, flaws: flaw === undefined ? [] : [flaw],
      learned: [{ latin: 'hayag', cyrillic: 'хаяг' }], asks: [{ latin: 'usnii', candidates: ['үсний', 'усны'], evidence: ['usnii himi'] }] },
    { ok: true, name: 'Dalatech', slug: 'dalatech', date: '2026-09-25', replies: 3, flaws: [], learned: [], asks: [] },
  ]);
  assert.match(text, /Matrix Eco Salon — 2026-09-25: 1 of 7 replies looks wrong\./);
  assert.match(text, /1e84c416 · corrected\nC: usnii himi\nB: Усны хими 132,000₮–154,000₮ байна\./);
  assert.match(text, /Dalatech — 2026-09-25: 0 of 3 replies look wrong\./);
  assert.match(text, /Spellings learned: hayag→хаяг/);
  assert.match(text, /select set_spelling\('matrix-eco-salon', 'usnii', 'үсний'\);/);
  assert.match(text, /select mark_reply_wrong\('<ref>', '<the right reply>'\);/);
});

test('an unreadable tenant says UNREADABLE, never zero', () => {
  const text = renderFlawReport([{ ok: false, name: 'Matrix Eco Salon', detail: 'messages unreadable: reset' }]);
  assert.match(text, /UNREADABLE — messages unreadable: reset/);
  assert.doesNotMatch(text, /0 of/);
});

test('yesterday is calendar arithmetic, across a month boundary', () => {
  assert.equal(previousDate('2026-10-01'), '2026-09-30');
  assert.equal(previousDate('2026-09-25'), '2026-09-24');
});
