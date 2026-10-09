import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatCanonical, chatKind, matchingText, PLATFORM_SPELLINGS } from './chat.ts';

// Founder, 2026-09-27: «bnu» got «Уучлаарай, ойлгосонгүй». Customers write greetings, thanks and
// short questions in Latin letters and in Cyrillic shorthand; every tenant reads them as it
// reads the full Cyrillic.
const GREETINGS = [
  'bnu', 'Bnu?', 'bnuu', 'bnuuu', 'bna uu', 'baina uu', 'sn bnu', 'sn bnuu', 'SN BNU!!', 'sain bnu', 'sain bnu uu',
  'sain baina uu', 'sain bna uu', 'sainuu', 'sain uu', 'snu', 'hi', 'Hello 👋',
  'бну', 'бнуу', 'байна уу', 'бна уу', 'сн бну', 'сайн бну', 'Сайн байна уу?', 'сайн уу', 'мэнд',
];
const THANKS = ['bayrlalaa', 'bayarlalaa', 'Bayrllaa!', 'ih bayrlalaa', 'za bayarlalaa', 'thx', 'thank you',
  'баярлалаа', 'баярллаа', 'их баярлалаа', 'Баярлалаа 🙏', 'bayrla', 'баярла', 'ok баярлалаа', 'OK баярлалаа!', 'баярлалаа ок'];
const ACKS = ['ok', 'OK', 'okey', 'oki', 'za', 'zaa', 'за', 'ок', 'заа'];

test('DONE-TEST: EVERY COMMON GREETING, THANKS AND «OK» — LATIN OR SHORTHAND — READS AS ITS CYRILLIC FORM', () => {
  for (const g of GREETINGS) assert.equal(chatCanonical(g), 'сайн байна уу', g);
  for (const t of THANKS) assert.equal(chatCanonical(t), 'баярлалаа', t);
  for (const a of ACKS) assert.equal(chatCanonical(a), 'за', a);
});

test('only a WHOLE greeting is canonical: a greeting with a question in it is not', () => {
  for (const m of ['bnu une hed ve', 'sain bnu hayag haana ve', 'Сайн байна уу, хэдэн цагт нээх вэ', 'bnutaa', 'обну']) {
    assert.equal(chatKind(m), null, m);
  }
});

test('short questions in Latin letters are matched as their Cyrillic words', () => {
  assert.equal(matchingText('une hed ve', []), 'үнэ хэд вэ');
  assert.equal(matchingText('Sn bnu, une hed ve?', []), 'сайн байна уу, үнэ хэд вэ?');
  assert.equal(matchingText('hayag haana ve', []), 'хаяг хаана вэ');
  assert.equal(matchingText('tsag avya', []), 'цаг авъя');
});

test("the tenant's own spelling wins over the platform's on the same word", () => {
  assert.equal(matchingText('une', [{ latin: 'une', cyrillic: 'үнэтэй' }]), 'үнэтэй');
});

test('a message already in full Cyrillic gives no second text; a canonical greeting gives the canonical', () => {
  assert.equal(matchingText('сайн байна уу', []), null);
  assert.equal(matchingText('Сайн байна уу!', []), null, 'the words themselves already match');
  assert.equal(matchingText('sn bnu', []), 'сайн байна уу');
  assert.equal(matchingText('бну', []), 'сайн байна уу');
  assert.equal(matchingText('Эмэгтэй тайралт хэд вэ', []), null);
});

test('every platform spelling is one lower-case Latin word to Cyrillic, with no duplicate keys', () => {
  const keys = PLATFORM_SPELLINGS.map((s) => s.latin);
  assert.equal(new Set(keys).size, keys.length);
  for (const s of PLATFORM_SPELLINGS) {
    assert.ok(/^\p{Script=Latin}+$/u.test(s.latin) && s.latin === s.latin.toLowerCase(), s.latin);
    assert.ok(/^[\p{Script=Cyrillic} ]+$/u.test(s.cyrillic), s.cyrillic);
  }
});

test('DONE-TEST (founder, 2026-10-09): THANKS AS CUSTOMERS TYPE IT IS THANKS, BY ITS SHAPE', () => {
  // Парк Од, 02:19:21: «bayrlala» reached the model, which answered «Тавтай морилно уу!».
  // Яармаг's history: «Za bayrlaa», «zaa bayrlala», «ok bayrllaa», «bayrllaa».
  for (const t of ['bayrlala', 'Za bayrlaa', 'zaa bayrlala', 'ok bayrllaa', 'bayrllaa', 'bairlalaa', 'Их баярлалаа 😊']) {
    assert.equal(chatKind(t), 'thanks', t);
    assert.equal(chatCanonical(t), 'баярлалаа', t);
  }
  // Not thanks: goodbye, a question beside the thanks, a sentence that goes on, a bare «ok».
  for (const t of ['bayartai', 'Баярлалаа, хэд вэ?', 'ok mash ih bayrlalaa hiicheed heliy', 'баярлах болно', 'Bayrlalaa margaash ochno', 'bayr']) {
    assert.notEqual(chatKind(t), 'thanks', t);
  }
  assert.equal(chatKind('ok'), 'ack');
});
