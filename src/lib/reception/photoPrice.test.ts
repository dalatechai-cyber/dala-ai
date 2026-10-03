// D-176: every branch of the photo question's step (`photoPrice.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asksPrice, hasWords, isPhotoQuestion, PHOTO_QUESTION_ANSWER_WINDOW_MS, photoAloneStep, photoPriceStep, type PhotoPriceInput,
} from './photoPrice.ts';

const Q = 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
const base: PhotoPriceInput = {
  question: Q, photo: false, otherMedia: false, previousReply: null, questionState: 'answering',
  namesService: false, fixedReply: null, gateTopic: false, asksPrice: false, hasWords: true,
};
const step = (over: Partial<PhotoPriceInput>) => photoPriceStep({ ...base, ...over });

test('no reviewed question row: nothing changes for any message (D-152 stays)', () => {
  for (const photo of [true, false]) {
    assert.equal(step({ question: null, photo, asksPrice: true }), 'off');
    assert.equal(step({ question: null, photo, previousReply: Q }), 'off');
  }
});

test('a video, a reel or a link to one is never this path: still the hand-off', () => {
  assert.equal(step({ photo: true, otherMedia: true, asksPrice: true }), 'off');
  assert.equal(step({ otherMedia: true, previousReply: Q }), 'off');
});

test('DONE-TEST: A PHOTO WITH «ХЭД ВЭ» IS ASKED THE QUESTION, ONCE', () => {
  assert.equal(step({ photo: true, asksPrice: true }), 'ask');
  assert.equal(step({ photo: true, hasWords: false }), 'ask', 'a photo with only a link or emoji');
  assert.equal(step({ photo: true, fixedReply: 'smalltalk' }), 'ask', 'a photo with a greeting');
});

test('a photo whose price ask names a service, or whose words fire an answering fixed reply, is answered', () => {
  assert.equal(step({ photo: true, namesService: true, asksPrice: true }), 'answer');
  assert.equal(step({ photo: true, fixedReply: 'content' }), 'answer', '«будаг хэд вэ» fires the dye rows');
  assert.equal(step({ photo: true, fixedReply: 'content', previousReply: Q }), 'answer');
});

test('review: a photo asking «can this colour be done?» stays the stylist\'s, even naming a service', () => {
  assert.equal(step({ photo: true }), 'handoff');
  assert.equal(step({ photo: true, namesService: true }), 'handoff', '«ийм будаг хийж болох уу?» names a kind and asks no price');
  assert.equal(step({ photo: true, gateTopic: true }), 'handoff', 'a suitability topic on a caption is not an answer');
});

test('DONE-TEST: AFTER ONE QUESTION, A PHOTO PRICE ASK STILL NAMING NOTHING GOES TO STAFF', () => {
  assert.equal(step({ photo: true, asksPrice: true, previousReply: Q }), 'handoff');
});

test('DONE-TEST: A PRICE ASK WRITTEN WITH THE PHOTO, BEFORE THE QUESTION ARRIVED, GETS NOTHING MORE', () => {
  const crossed = { previousReply: Q, questionState: 'crossed' as const };
  assert.equal(step({ ...crossed, asksPrice: true }), 'wait');
  assert.equal(step({ ...crossed, hasWords: false }), 'wait');
  assert.equal(step({ ...crossed, fixedReply: 'smalltalk' }), 'wait', 'a greeting typed with the photo');
  assert.equal(step({ ...crossed, asksPrice: true, namesService: true }), 'answer', 'a caption pricing a service is answered');
  assert.equal(step({ ...crossed, fixedReply: 'content' }), 'answer', 'review: «хаяг хаана вэ?» typed with the photo gets the address');
  assert.equal(step({ ...crossed }), 'handoff', '«ийм болгож болох уу» typed with the photo');
});

test('DONE-TEST: THE ANSWER TO THE QUESTION GETS ITS PRICE; AN ANSWER NAMING NOTHING GOES TO STAFF', () => {
  assert.equal(step({ namesService: true, previousReply: Q }), 'answer');
  assert.equal(step({ fixedReply: 'content', previousReply: Q }), 'answer', 'the customer moved on («хаяг хаана вэ?»)');
  assert.equal(step({ fixedReply: 'smalltalk', previousReply: Q }), 'answer', '«за баярлалаа» gets its row');
  assert.equal(step({ gateTopic: true, previousReply: Q }), 'answer');
  assert.equal(step({ previousReply: Q }), 'handoff');
  assert.equal(step({ asksPrice: true, previousReply: Q }), 'handoff', '«хэд вэ» again, after reading the question');
});

test('review: a question from another hour or day is not the one being answered', () => {
  assert.equal(step({ previousReply: Q, questionState: 'stale' }), 'off', 'a later message is answered as usual');
  assert.equal(step({ photo: true, asksPrice: true, previousReply: Q, questionState: 'stale' }), 'ask', 'a new photo is asked again');
});

test('the question is recognised exactly, never by similarity', () => {
  assert.equal(step({ previousReply: `${Q} 😊` }), 'off');
  assert.equal(step({ previousReply: `  ${Q}\n` }), 'handoff');
  assert.equal(isPhotoQuestion(Q, ''), false, 'an empty row is never the question');
  assert.equal(step({ previousReply: 'Сайн байна уу!' }), 'off');
});

test('an ordinary text is untouched', () => {
  assert.equal(step({ asksPrice: true }), 'off');
  assert.equal(step({ namesService: true }), 'off');
});

test('photo alone: ask, then nothing to a burst, then the hand-off; a stale question is asked again', () => {
  const now = new Date('2026-10-04T05:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const w = 10 * 60_000;
  const go = (lastReply: { body: string; at: Date; dedupKey?: string | null } | null) =>
    photoAloneStep({ question: Q, lastReply, ownKey: 'pq:9:0', now, burstWindowMs: w });
  assert.equal(go(null), 'ask');
  assert.equal(go({ body: 'Үнэ: 1₮', at: ago(1000) }), 'ask');
  assert.equal(go({ body: Q, at: ago(30_000) }), 'suppress');
  assert.equal(go({ body: Q, at: ago(w + 1) }), 'handoff');
  assert.equal(go({ body: Q, at: ago(PHOTO_QUESTION_ANSWER_WINDOW_MS) }), 'ask', 'review: last week\'s question, or the old image line');
  assert.equal(go({ body: Q, at: ago(40 * 60_000), dedupKey: 'pq:9:0' }), 'ask', 'review: a redelivery finds its own question');
});

test('a price ask is whole words, and «хэдэн цагт» asks a time', () => {
  assert.equal(asksPrice('ene hed ve'), true);
  assert.equal(asksPrice('Энэ ямар үнэтэй вэ'), true);
  assert.equal(asksPrice('хэдийд ирэх вэ'), false);
  assert.equal(asksPrice('Хэдэн цагт ирэх вэ'), false);
  assert.equal(hasWords('https://www.instagram.com/p/abc/ 😍'), false);
  assert.equal(hasWords('ийм'), true);
});
