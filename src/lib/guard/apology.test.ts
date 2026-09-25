import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalMarkerFrom, unwarrantedApology } from './apology.ts';

const R = '2026-09-18T00:00:00Z';
// Matrix's reviewed refusal rows, verbatim (2026-09-24).
const CANNED = [
  { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна.', reviewedAt: R },
  { kind: 'refusal_topic', body: 'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй.', reviewedAt: R },
  { kind: 'refusal_service_unavailable', body: 'Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна.', reviewedAt: R },
  { kind: 'refusal_no_promotion', body: 'Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй.', reviewedAt: R },
  { kind: 'booking_line', body: 'Та манай вэбсайтаар онлайнаар цаг захиалж болно.', reviewedAt: R },
];
const STEMS = ['Уучлаарай'];

test('the apology word itself is never the marker, even when every row opens with it', () => {
  const both = [CANNED[0]!, CANNED[1]!];
  assert.equal(refusalMarkerFrom(both, STEMS), 'гүй');
});

test('the refusal marker is read out of the tenant\'s own refusal rows', () => {
  assert.equal(refusalMarkerFrom(CANNED, STEMS), 'гүй');
  assert.equal(refusalMarkerFrom(CANNED.slice(0, 1), STEMS), null, 'one row says nothing about what refusals share');
});

test('DONE-TEST: A CLARIFYING QUESTION LOSES ITS APOLOGY', () => {
  // f03 and c12, real replies 2026-09-24.
  const m = refusalMarkerFrom(CANNED, STEMS);
  const a = unwarrantedApology('Уучлаарай, ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?', STEMS, m, false);
  assert.deepEqual(a, { strip: true, text: 'Ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?', removed: 'Уучлаарай,' });
  const b = unwarrantedApology('Уучлаарай, тодруулж болох уу? Та бүтэн будуулах уу?', STEMS, m, false);
  assert.ok(b.strip && b.text === 'Тодруулж болох уу? Та бүтэн будуулах уу?');
});

test('only the sentence the apology opens decides: «дэлгэрэнгүй» later on is not a refusal', () => {
  // f07, real reply 2026-09-24.
  const m = refusalMarkerFrom(CANNED, STEMS);
  const r = unwarrantedApology('Уучлаарай, тодруулъя — CICA гэдэг нь эмчилгээний хими биш, харин тусдаа эмчилгээ юм. '
    + 'Хэрэв та хими сонирхож байгаа бол хэлээрэй, дэлгэрэнгүй хэлье.', STEMS, m, false);
  assert.ok(r.strip && r.text.startsWith('Тодруулъя — CICA'));
});

test('DONE-TEST: A REFUSAL KEEPS IT', () => {
  const m = refusalMarkerFrom(CANNED, STEMS);
  // c06, real reply: refusing a stylist's personal number.
  assert.deepEqual(unwarrantedApology('Уучлаарай, ажилтны хувийн утасны дугаарыг өгөх боломжгүй.', STEMS, m, false), { strip: false });
  // A refusal rule fired: the reply is a refusal whatever its words.
  assert.deepEqual(unwarrantedApology('Уучлаарай, тодруулж болох уу?', STEMS, m, true), { strip: false });
});

test('only a whole opening word, and never when nothing would remain', () => {
  const m = refusalMarkerFrom(CANNED, STEMS);
  assert.deepEqual(unwarrantedApology('Уучлаарайгаа хэлье', STEMS, m, false), { strip: false });
  assert.deepEqual(unwarrantedApology('Уучлаарай!', STEMS, m, false), { strip: false });
  assert.deepEqual(unwarrantedApology('Сор: 120,000₮. Уучлаарай, өөр асуулт?', STEMS, m, false), { strip: false });
});

test('no shared refusal marker means the check is inert', () => {
  assert.deepEqual(unwarrantedApology('Уучлаарай, ямар үйлчилгээ вэ?', STEMS, null, false), { strip: false });
});

test('DONE-TEST (2026-09-26, s01): AN APOLOGETIC QUESTION THE REPLY ANSWERS ITSELF GOES WITH THE APOLOGY', () => {
  const m = refusalMarkerFrom(CANNED, STEMS);
  const reply = 'Уучлаарай, тодруулбал Дали гэдэг манай AI хүлээн авагчийг хэлж байна уу? '
    + 'Дали бол Facebook, Instagram, вэбсайтад ирсэн зурваст шууд хариулдаг хүлээн авагч ажилтан.';
  const r = unwarrantedApology(reply, STEMS, m, false);
  assert.equal(r.strip && r.text, 'Дали бол Facebook, Instagram, вэбсайтад ирсэн зурваст шууд хариулдаг хүлээн авагч ажилтан.');
});

test('a reply that IS the question keeps it, and a short tail is not an answer', () => {
  const m = refusalMarkerFrom(CANNED, STEMS);
  const only = unwarrantedApology('Уучлаарай, ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?', STEMS, m, false);
  assert.equal(only.strip && only.text, 'Ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ?');
  const two = unwarrantedApology('Уучлаарай, тодруулж болох уу? Та бүтэн будуулах уу?', STEMS, m, false);
  assert.equal(two.strip && two.text, 'Тодруулж болох уу? Та бүтэн будуулах уу?', 'a second question is not an answer of 40 characters');
});
