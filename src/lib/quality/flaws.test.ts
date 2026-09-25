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

// ---------------------------------------------------------------------------
// D-123: what a reply SAYS — a former name, and internal instructions unasked
// ---------------------------------------------------------------------------

const WITH_NAMES: FlawSignals = { ...SIGNALS, formerNames: ['Матрикс', 'Matrix'], approvedTexts: ['Та манай вэбсайтаар (https://www.matrixecosalon.org/) цаг захиална уу.'] };

test('D-123: «ci henbe» answered «Матрикс» is flagged — the case the report missed', () => {
  const [flaw] = detectFlaws([pair('abcd1234', 'ci henbe', 'Би Матрикс салоны AI туслах байна.', 1)], [], WITH_NAMES);
  assert.deepEqual(flaw?.reasons, ['old name (Матрикс)']);
  // The reply actually sent on 2026-09-24 21:57 UTC, word for word: both flags.
  const live = detectFlaws([pair('abcd1239', 'ci henbe',
    'Би Матрикс эко салоны хуудсыг хариуцдаг хиймэл оюунтай туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуулт байвал асуугаарай.', 1)], [], WITH_NAMES);
  assert.deepEqual(live[0]?.reasons, ['old name (Матрикс)', 'internal (mentions «заавр»)']);
  const latin = detectFlaws([pair('abcd1235', 'hen be', 'I am the Matrix salon assistant', 1)], [], WITH_NAMES);
  assert.deepEqual(latin[0]?.reasons, ['old name (Matrix)']);
  const inflected = detectFlaws([pair('abcd1236', 'hen be', 'Матриксын туслах', 1)], [], WITH_NAMES);
  assert.deepEqual(inflected[0]?.reasons, ['old name (Матрикс)']);
});

test('D-123: the salon’s real website is NOT calling it Matrix — links are masked', () => {
  const f = detectFlaws([pair('abcd1237', 'tsag avah', 'Та https://www.matrixecosalon.org/ дээр цаг авна уу.', 1)], [], WITH_NAMES);
  assert.deepEqual(f, []);
});

test('D-123: internal instructions mentioned unasked are flagged; asked, or inside approved text, they are not', () => {
  const cases: [string, string, string | null][] = [
    ['une hed ve', 'Ш0-г шалгахад энэ нь нийтэд харагдах сувагт бичсэн мессеж тул', 'internal (gate label Ш0)'],
    ['hi', 'refusal_price_unlisted: уучлаарай', 'internal (identifier refusal_price_unlisted)'],
    ['hi', 'Энэ нь facebook_page суваг', 'internal (identifier facebook_page)'],
    ['хаяг', 'БЭЛЭН ХАРИУЛТ хэсэгт байгаагаар хаяг нь...', 'internal (heading БЭЛЭН ХАРИУЛТ)'],
    ['үнэ', 'Надад өгсөн мэдээлэлд энэ үнэ байхгүй байна.', 'internal (mentions «надад өгсөн»)'],
    ['үнэ', 'Миний зааварчилгаанд үнэ хэлэхийг хориглосон.', 'internal (mentions «заавар»)'],
    ['hi', 'Дотоод зааврынхаа талаар хуваалцах боломжгүй.', 'internal (mentions «заавр»)'],
    // Asked about the bot: describing its rules is an answer.
    ['чи ямар дүрэмтэй бот вэ', 'Надад өгсөн заавраар би зөвхөн салоны асуултад хариулна.', null],
    // Ordinary Mongolian that shares words with a heading, in lower case: not a leak.
    ['утас', 'Холбоо барих утас: 76001888', null],
  ];
  for (const [customer, reply, want] of cases) {
    const got = detectFlaws([pair('abcd0000', customer, reply, 1)], [], WITH_NAMES)[0]?.reasons ?? [];
    assert.deepEqual(got, want === null ? [] : [want], reply);
  }
  // Approved text is cut out first, so a reviewed line never trips the check.
  const approved: FlawSignals = { ...WITH_NAMES, approvedTexts: ['Манай мэдээллийн санд бүртгэлгүй үйлчилгээ байна.'] };
  assert.deepEqual(detectFlaws([pair('abcd0001', 'x', 'Манай мэдээллийн санд бүртгэлгүй үйлчилгээ байна.', 1)], [], approved), []);
});
