import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLike, isLikeSticker, LIKE_TEXT, likeIsOwedReply, likeRowFor } from './like.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';

const row = (over: Partial<DeterministicRule>): DeterministicRule => ({
  intent: 'x', body: 'b', enabled: true, matchMode: 'whole_message', stems: ['like'], coverWords: [],
  placement: 'replace', quoteServices: [], requiresEmptyHistory: false, provenance: 'tenant_confirmed', ...over,
} as DeterministicRule);

test('only the like, alone, is a like: keyed on sticker_id, never on type', () => {
  assert.equal(isLikeSticker(['sticker'], ['369239263222822']), true);
  assert.equal(isLikeSticker(['sticker'], ['369239343222814', '369239383222810']), true);
  assert.equal(isLikeSticker(['sticker'], ['126361874215276']), false, 'another sticker');
  assert.equal(isLikeSticker(['sticker', 'image'], ['369239263222822']), false, 'a like beside a photograph');
  assert.equal(isLikeSticker(['image'], []), false);
  assert.equal(isLike(LIKE_TEXT), true);
  assert.equal(isLike(`${LIKE_TEXT} `), true);
  assert.equal(isLike('like'), false, 'a typed word is answered by the rows as any other text');
});

test('a like is owed a reply on an empty history, or right after Дали answered something that was not a like', () => {
  const u = (content: string) => ({ role: 'user', content });
  const a = (content: string) => ({ role: 'assistant', content });
  assert.equal(likeIsOwedReply([]), true);
  assert.equal(likeIsOwedReply([u('Хаяг хаана вэ'), a('Хаяг: …')]), true);
  assert.equal(likeIsOwedReply([u('Хими хэд вэ')]), false, 'before the answer it reacts to');
  assert.equal(likeIsOwedReply([u(LIKE_TEXT), a('Сайн байна уу!')]), false, 'Дали already answered a like');
  assert.equal(likeIsOwedReply([u(LIKE_TEXT), a('Сайн байна уу!'), u(LIKE_TEXT)]), false, 'a third like after an unanswered one');
});

test('a tenant answers a like only with an enabled, confirmed whole_message row matching it on this history', () => {
  assert.equal(likeRowFor([], null), false);
  assert.equal(likeRowFor([row({})], null), true);
  assert.equal(likeRowFor([row({ stems: ['ok'] })], null), false);
  assert.equal(likeRowFor([row({ enabled: false })], null), false);
  assert.equal(likeRowFor([row({ provenance: 'seeded' })], null), false);
  assert.equal(likeRowFor([row({ placement: 'append' })], null), false);
  assert.equal(likeRowFor([row({ matchMode: 'covers_message' })], null), false);
  assert.equal(likeRowFor([row({ requiresEmptyHistory: true })], false), false, 'the welcome row does not answer mid-conversation');
  assert.equal(likeRowFor([row({ requiresEmptyHistory: true })], true), true);
  assert.equal(likeRowFor([row({ requiresEmptyHistory: true })], null), true, 'unknown history: the tenant has a like row');
});
