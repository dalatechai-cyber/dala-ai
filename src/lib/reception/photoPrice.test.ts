// D-176: every branch of the photo question's step (`photoPrice.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asksPrice, hasWords, isMediaQuestion, isPhotoQuestion, PHOTO_QUESTION_ANSWER_WINDOW_MS, photoAloneStep, photoPriceStep, questionFor,
  type PhotoPriceInput,
} from './photoPrice.ts';

const Q = 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
const base: PhotoPriceInput = {
  question: Q, reelQuestion: null, media: null, previousReply: null, questionState: 'answering',
  namesService: false, namesOneService: false, fixedReply: null, gateTopic: false, asksPrice: false, hasWords: true,
};
const step = (over: Partial<PhotoPriceInput>) => photoPriceStep({ ...base, ...over });

test('no reviewed question row: nothing changes for any message (D-152 stays)', () => {
  for (const media of ['photo', 'video', 'mixed', null] as const) {
    assert.equal(step({ question: null, media, asksPrice: true }), 'off');
    assert.equal(step({ question: null, media, previousReply: Q }), 'off');
  }
});

test('a video, a reel or a link to one, with no reel row, is never this path: still the hand-off', () => {
  assert.equal(step({ media: 'video', asksPrice: true }), 'off');
  assert.equal(step({ media: 'video', hasWords: false }), 'off');
  assert.equal(step({ media: 'video', previousReply: Q }), 'off');
  assert.equal(step({ media: 'mixed', asksPrice: true }), 'off', 'a shared post, or a photo beside a video');
  assert.equal(step({ media: 'mixed', previousReply: Q }), 'off');
});

test('DONE-TEST: A PHOTO WITH «ХЭД ВЭ» IS ASKED THE QUESTION, ONCE', () => {
  assert.equal(step({ media: 'photo', asksPrice: true }), 'ask');
  assert.equal(step({ media: 'photo', hasWords: false }), 'ask', 'a photo with only a link or emoji');
  assert.equal(step({ media: 'photo', fixedReply: 'smalltalk' }), 'ask', 'a photo with a greeting');
});

test('a photo whose price ask names a service, or whose words fire an answering fixed reply, is answered', () => {
  assert.equal(step({ media: 'photo', namesService: true, asksPrice: true }), 'answer');
  assert.equal(step({ media: 'photo', fixedReply: 'content' }), 'answer', '«будаг хэд вэ» fires the dye rows');
  assert.equal(step({ media: 'photo', fixedReply: 'content', previousReply: Q }), 'answer');
});

test('review: a photo asking «can this colour be done?» stays the stylist\'s, even naming a service', () => {
  assert.equal(step({ media: 'photo' }), 'handoff');
  assert.equal(step({ media: 'photo', namesService: true }), 'handoff', '«ийм будаг хийж болох уу?» names a kind and asks no price');
  assert.equal(step({ media: 'photo', gateTopic: true }), 'handoff', 'a suitability topic on a caption is not an answer');
});

test('DONE-TEST: AFTER ONE QUESTION, A PHOTO PRICE ASK STILL NAMING NOTHING GOES TO STAFF', () => {
  assert.equal(step({ media: 'photo', asksPrice: true, previousReply: Q }), 'handoff');
});

test('DONE-TEST: A PRICE ASK WRITTEN WITH THE PHOTO, BEFORE THE QUESTION ARRIVED, GETS NOTHING MORE', () => {
  const crossed = { previousReply: Q, questionState: 'crossed' as const };
  assert.equal(step({ ...crossed, asksPrice: true }), 'wait');
  assert.equal(step({ ...crossed, hasWords: false }), 'wait');
  assert.equal(step({ ...crossed, fixedReply: 'smalltalk' }), 'wait', 'a greeting typed with the photo');
  assert.equal(step({ ...crossed, asksPrice: true, namesService: true }), 'answer', 'a caption pricing a service is answered');
  assert.equal(step({ ...crossed, fixedReply: 'content' }), 'answer', 'review: «хаяг хаана вэ?» typed with the photo gets the address');
  assert.equal(step({ ...crossed }), 'handoff', '«ийм болгож болох уу» typed with the photo');
  assert.equal(step({ ...crossed, namesService: true }), 'handoff', '«ийм будаг хийж болох уу?»: a kind, not one service');
});

test('DONE-TEST (founder 2026-10-04): «TARA PERM УРТ» 13 S AFTER THE QUESTION IS THE ANSWER, NOT A CAPTION: PRICED, NOT STAFF', () => {
  const crossed = { previousReply: Q, questionState: 'crossed' as const };
  assert.equal(step({ ...crossed, namesService: true, namesOneService: true }), 'answer');
  // After the crossing window, as before.
  assert.equal(step({ previousReply: Q, namesService: true, namesOneService: true }), 'answer');
  // A caption on the picture itself is still the stylist's: the picture may show something else.
  assert.equal(step({ media: 'photo', namesService: true, namesOneService: true }), 'handoff');
  // With no question asked, nothing changes.
  assert.equal(step({ namesService: true, namesOneService: true }), 'off');
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
  assert.equal(step({ media: 'photo', asksPrice: true, previousReply: Q, questionState: 'stale' }), 'ask', 'a new photo is asked again');
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
  const w = 30_000;
  const go = (lastReply: { body: string; at: Date; dedupKey?: string | null } | null) =>
    photoAloneStep({ questions: [Q], lastReply, ownKey: 'pq:9:0', now, togetherMs: w });
  assert.equal(go(null), 'ask');
  assert.equal(go({ body: 'Үнэ: 1₮', at: ago(1000) }), 'ask');
  assert.equal(go({ body: Q, at: ago(5_000) }), 'suppress', 'sent together with the first');
  assert.equal(go({ body: Q, at: ago(w + 1) }), 'handoff', 'later than together: after reading the question');
  assert.equal(go({ body: Q, at: ago(PHOTO_QUESTION_ANSWER_WINDOW_MS) }), 'ask', 'review: last week\'s question, or the old image line');
  assert.equal(go({ body: Q, at: ago(40 * 60_000), dedupKey: 'pq:9:0' }), 'ask', 'review: a redelivery finds its own question');
  // Review: a redelivery whose own question is hidden behind the price it drafted after it.
  assert.equal(photoAloneStep({ questions: [Q], lastReply: { body: 'Үнэ: 1₮', at: ago(1000) }, ownKey: 'pq:9:0', now, togetherMs: w,
    recent: { at: ago(2000), isLastReply: false, customerWroteSince: true, dedupKey: 'pq:9:0' } }), 'ask');
  assert.equal(photoAloneStep({ questions: [Q], lastReply: { body: 'Үнэ: 1₮', at: ago(1000) }, ownKey: 'pq:10:0', now, togetherMs: w,
    recent: { at: ago(2000), isLastReply: false, customerWroteSince: true, dedupKey: 'pq:9:0' } }), 'handoff');
});

test('a price ask is whole words, and «хэдэн цагт» asks a time', () => {
  assert.equal(asksPrice('ene hed ve'), true);
  assert.equal(asksPrice('Энэ ямар үнэтэй вэ'), true);
  assert.equal(asksPrice('хэдийд ирэх вэ'), false);
  assert.equal(asksPrice('Хэдэн цагт ирэх вэ'), false);
  assert.equal(hasWords('https://www.instagram.com/p/abc/ 😍'), false);
  assert.equal(hasWords('ийм'), true);
});

// D-176, the reel line (founder, 2026-10-04): a video, a reel or a link to one, wired like a photo.
const R = 'Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
const reel = (over: Partial<PhotoPriceInput>) => step({ question: null, reelQuestion: R, media: 'video', ...over });

test('DONE-TEST: A REEL WITH NO WORDS, A PRICE ASK OR ONLY A GREETING IS ASKED THE REEL QUESTION, ONCE', () => {
  assert.equal(reel({ hasWords: false }), 'ask');
  assert.equal(reel({ asksPrice: true }), 'ask');
  assert.equal(reel({ fixedReply: 'smalltalk' }), 'ask');
  assert.equal(questionFor('video', { photo: Q, reel: R }), R, 'the reel line, never the photo line');
  assert.equal(questionFor('photo', { photo: Q, reel: R }), Q);
  assert.equal(questionFor('mixed', { photo: Q, reel: R }), null);
});

test('DONE-TEST: A REEL WHOSE PRICE ASK NAMES A SERVICE IS PRICED FROM THE ROWS', () => {
  assert.equal(reel({ asksPrice: true, namesService: true }), 'answer');
  assert.equal(reel({ fixedReply: 'content' }), 'answer');
  assert.equal(reel({ namesService: true }), 'handoff', '«ийм болгож болох уу?» is the stylist\'s');
});

test('DONE-TEST: AFTER THE REEL QUESTION, AN ANSWER NAMING A SERVICE IS PRICED; NAMING NOTHING GOES TO STAFF', () => {
  assert.equal(reel({ media: null, previousReply: R, namesService: true }), 'answer');
  assert.equal(reel({ media: null, previousReply: R, fixedReply: 'content' }), 'answer');
  assert.equal(reel({ media: null, previousReply: R }), 'handoff');
  assert.equal(reel({ media: null, previousReply: R, asksPrice: true }), 'handoff', '«хэд вэ» again');
  assert.equal(reel({ asksPrice: true, previousReply: R }), 'handoff', 'a second reel with «хэд вэ» after the question');
  assert.equal(reel({ media: null, previousReply: R, questionState: 'crossed', asksPrice: true }), 'wait');
  assert.equal(reel({ media: null, previousReply: R, questionState: 'stale' }), 'off');
});

test('DONE-TEST (founder 2026-10-09): A SECOND PICTURE A MINUTE AFTER THE QUESTION GOES TO A PERSON, NOT TO SILENCE', () => {
  // The 10-minute `burst` silence is gone: only a picture that crossed the question (sent with the first) gets nothing more.
  const minute = { previousReply: R, questionState: 'answering' as const };
  assert.equal(reel({ ...minute, hasWords: false }), 'handoff', 'a second reel link a minute later');
  assert.equal(reel({ ...minute, asksPrice: true }), 'handoff');
  assert.equal(reel({ ...minute, asksPrice: true, namesService: true }), 'answer');
  assert.equal(reel({ ...minute }), 'handoff', '«like this» on a second reel is the stylist\'s');
  assert.equal(reel({ ...minute, media: null, namesService: true }), 'answer');
  assert.equal(reel({ ...minute, media: null }), 'handoff', 'an answer naming nothing, even a minute later');
  assert.equal(step({ media: 'photo', asksPrice: true, previousReply: Q, questionState: 'answering' }), 'handoff', 'the same for photos');
  assert.equal(step({ media: 'photo', asksPrice: true, previousReply: Q, questionState: 'crossed' }), 'wait', 'sent together with the first: nothing more');
});

test('DONE-TEST (Парк Од, 2026-10-09 02:18): «hedve» TWICE AFTER THE PHOTO QUESTION: THE FIRST CROSSED IT, THE SECOND GOES TO A PERSON', () => {
  // 02:18:34 the question; 02:18:36 «hedve» (2.4 s: typed with the photo); 02:18:54 «hedve» again.
  // The worker reads the second as `answering` (a customer turn already follows the question).
  const hedve = { media: null, previousReply: Q, asksPrice: true } as const;
  assert.equal(step({ ...hedve, questionState: 'crossed' }), 'wait', 'the first: the question just sent already asks it');
  assert.equal(step({ ...hedve, questionState: 'answering' }), 'handoff', 'the second: the notice, and a person told');
});

test('DONE-TEST (Парк Од, 2026-10-09 02:18): A PHOTO AFTER THE QUESTION WAS ASKED AND A PRICE ANSWERED GOES TO A PERSON, NOT THE QUESTION AGAIN', () => {
  // The question at 02:18:10, «tara perm urt» priced at 02:18:24, then a captioned photo: the last
  // reply is the price, and the question was asked earlier in the hour.
  assert.equal(step({ media: 'photo', asksPrice: true, previousReply: 'Tara perm (урт): 290,000₮', askedEarlier: true }), 'handoff');
  assert.equal(step({ media: 'photo', hasWords: false, previousReply: 'Tara perm (урт): 290,000₮', askedEarlier: true }), 'handoff');
  assert.equal(step({ media: 'photo', asksPrice: true, previousReply: 'Tara perm (урт): 290,000₮' }), 'ask', 'no question in the hour: asked');
  assert.equal(step({ media: 'photo', asksPrice: true, namesService: true, askedEarlier: true }), 'answer', 'a caption naming a service is still priced');
});

test('each kind is its own switch; the two questions are one question', () => {
  assert.equal(step({ reelQuestion: R, media: 'photo', asksPrice: true }), 'ask', 'the photo row still asks a photo');
  assert.equal(step({ question: null, reelQuestion: R, media: 'photo', asksPrice: true }), 'off', 'no photo row: D-152 for photos');
  assert.equal(step({ reelQuestion: R, media: 'video', asksPrice: true, previousReply: Q }), 'handoff', 'a reel after the photo question');
  assert.equal(step({ reelQuestion: R, media: 'photo', asksPrice: true, previousReply: R }), 'handoff', 'a photo after the reel question');
  assert.equal(step({ question: null, reelQuestion: R, previousReply: Q }), 'off', 'the photo line is no question for a tenant without the photo row');
  assert.equal(isMediaQuestion(R, [null, R]), true);
  assert.equal(isMediaQuestion(`${R} 😊`, [Q, R]), false);
});

test('reel alone: ask, then nothing to a burst, then the hand-off; either question counts', () => {
  const now = new Date('2026-10-04T05:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const w = 30_000;
  const go = (lastReply: { body: string; at: Date } | null) =>
    photoAloneStep({ questions: [Q, R], lastReply, ownKey: 'pq:9:0', now, togetherMs: w });
  assert.equal(go(null), 'ask');
  assert.equal(go({ body: R, at: ago(5_000) }), 'suppress');
  assert.equal(go({ body: R, at: ago(11 * 60_000) }), 'handoff', 'another reel 10 to 60 minutes later');
  assert.equal(go({ body: Q, at: ago(11 * 60_000) }), 'handoff', 'a reel after the photo question');
  assert.equal(go({ body: R, at: ago(PHOTO_QUESTION_ANSWER_WINDOW_MS) }), 'ask');
  assert.equal(photoAloneStep({ questions: [Q], lastReply: { body: R, at: ago(11 * 60_000) }, ownKey: 'k', now, togetherMs: w }), 'ask',
    'a tenant whose reel row is gone does not read the reel line as a question');
});

test('DONE-TEST (Парк Од, 2026-10-09 02:18:32): A SECOND PHOTO AFTER THE QUESTION AND A PRICED ANSWER IS HANDED TO A PERSON', () => {
  const now = new Date('2026-10-09T02:18:33Z');
  const question = { at: new Date('2026-10-09T02:18:09.5Z'), isLastReply: false, customerWroteSince: true };
  const last = { body: 'Tara perm (урт): 290,000₮', at: new Date('2026-10-09T02:18:23.7Z') };
  assert.equal(photoAloneStep({ questions: [Q], lastReply: last, recent: question, ownKey: 'pq:2:0', now, togetherMs: 30_000 }), 'handoff');
  // Before: the last reply alone decided, and the price is no question, so it was asked again.
  assert.equal(photoAloneStep({ questions: [Q], lastReply: last, ownKey: 'pq:2:0', now, togetherMs: 30_000 }), 'ask');
});

test('a picture right after the question, but after the customer wrote, goes to a person; with nothing in between it is one burst', () => {
  const now = new Date('2026-10-09T02:18:40Z');
  const at = new Date('2026-10-09T02:18:34Z');
  const last = { body: Q, at };
  const go = (customerWroteSince: boolean) =>
    photoAloneStep({ questions: [Q], lastReply: last, recent: { at, isLastReply: true, customerWroteSince }, ownKey: 'k', now, togetherMs: 30_000 });
  assert.equal(go(false), 'suppress');
  assert.equal(go(true), 'handoff');
  assert.equal(photoAloneStep({ questions: [Q], lastReply: null, recent: null, ownKey: 'k', now, togetherMs: 30_000 }), 'ask');
});
