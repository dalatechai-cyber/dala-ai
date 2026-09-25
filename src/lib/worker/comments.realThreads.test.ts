/**
 * Matrix / Tara Salon's real comment threads, replayed through `runCommentJob` (D-122
 * addendum). The staff answer comments by hand from the Page; these are the threads where
 * they did, and what the bot decides about each customer in them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayComments, type ReplayRule } from './commentReplay.fixtures.ts';
import { P_REEL_0829, P_REEL_0922, STORED, type StoredComment } from '../comments/realThreads.fixtures.ts';

const RULES = (JSON.parse(readFileSync(new URL('../../../scripts/provision/templates/comment_rules.salon.json', import.meta.url), 'utf8')) as {
  rules: ReplayRule[];
}).rules;

const outcomes = async (decide: number[], evidence: 'at_decision' | 'all', stored: readonly StoredComment[] = STORED) =>
  Object.fromEntries((await replayComments({ stored, decide, rules: RULES, evidence })).map((o) => [o.eventId, o.outcome]));

test('the last two days, decided as the comments arrived: praise silent, both questions drafted', async () => {
  assert.deepEqual(await outcomes([740, 748, 749, 784], 'at_decision'), {
    740: 'comment_not_worth_reply',
    748: 'comment_not_worth_reply',
    749: 'drafted',
    784: 'drafted',
  });
});

test('the same comments re-decided with every staff reply now stored: the staff got there, the bot stays out', async () => {
  assert.deepEqual(await outcomes([740, 748, 749, 784], 'all'), {
    740: 'comment_not_worth_reply',
    748: 'comment_not_worth_reply',
    // 751 «Saruul Naran Баярлалаа💕» — a thank-you for her praise (748), and a tag of her
    // on this post. The rule cannot tell a thank-you from an answer; it is the founder's
    // rule as written, and it only binds once the thank-you exists (14:10, an hour later).
    749: 'staff_tagged_commenter',
    // 803: the Page replied under «Үнэ хаяг» at 14:19, 7.5 hours after it.
    784: 'staff_replied',
  });
});

test('25 Sept, P_REEL_0829: «Үнэ хаяг» is replied to by the Page and tagged in all five of its answers', () => {
  const pageOnPost = STORED.filter((c) => c.postId === P_REEL_0829 && c.fromId !== '28708988732064996' && c.eventId !== 784);
  assert.equal(pageOnPost.length, 5);
  assert.ok(pageOnPost.every((c) => (c.message ?? '').includes('Ooyo Oyunchimeg')));
  assert.equal(pageOnPost.filter((c) => c.parentId === '1378787287727016_1370871108161662').length, 1, 'one of them directly under her comment');
});

/** A comment that never happened, on a real thread, by a real commenter or a new one. */
function wouldBe(eventId: number, fromId: string, fromName: string, postId: string, message: string): StoredComment {
  return {
    eventId, receivedAt: '2026-09-25T14:30:00.000Z', fromId, fromName,
    commentId: `${postId.slice(postId.indexOf('_') + 1)}_9000${eventId}`, parentId: postId, postId, message, createdTime: 1790346600,
  };
}

test('25 Sept: each person the staff answered at 14:19, asking again on that post, is left to the staff', async () => {
  const again = [
    wouldBe(901, 'u901', 'Ooyo Oyunchimeg', P_REEL_0829, 'Үнэ хэд вэ?'),
    wouldBe(902, 'u902', 'Bayrsaihan Jigjiddorj', P_REEL_0829, 'Үнэ хэд вэ?'),
    wouldBe(903, 'u903', 'Оюунгэрэл Ананд', P_REEL_0829, 'Хаяг хаана вэ?'),
    wouldBe(904, 'u904', 'Намуунцэцэг Баасансүрэн', P_REEL_0829, 'Цаг авч болох уу?'),
    wouldBe(905, 'u905', 'Uuganaa Uugantsetseg', P_REEL_0829, 'une hed ve'),
    // Somebody the staff never answered, same post, same minute: the bot answers.
    wouldBe(906, 'u906', 'Bold Bat', P_REEL_0829, 'Үнэ хэд вэ?'),
    // Only half of a tagged name: not the same person.
    wouldBe(907, 'u907', 'Ooyo Bat', P_REEL_0829, 'Үнэ хэд вэ?'),
  ];
  assert.deepEqual(await outcomes([901, 902, 903, 904, 905, 906, 907], 'all', [...STORED, ...again]), {
    901: 'staff_tagged_commenter',
    902: 'staff_tagged_commenter',
    903: 'staff_tagged_commenter',
    904: 'staff_tagged_commenter',
    905: 'staff_tagged_commenter',
    906: 'drafted',
    907: 'drafted',
  });
});

test('earlier real threads on P_REEL_0922: every question the staff answered is refused now, with the right proof', async () => {
  assert.deepEqual(await outcomes([412, 492, 705, 706], 'all'), {
    412: 'staff_replied', // 415 under it, 98 s later
    492: 'staff_replied', // 508 under it, «Т. Од vip center 2 давхарт…»
    705: 'staff_replied', // 711 under it, 5.5 h later
    706: 'staff_tagged_commenter', // her second comment; 711 tagged «Анхбаяр Пүрэвсүрэн» on the post
  });
});

test('a personal account thanking someone is not the Page, and silences nobody', async () => {
  // Webhook 484: «Enkhnasan Nasandalai Баярлалаа💕» from a stylist's own account.
  const ask = wouldBe(910, 'u910', 'Enkhnasan Nasandalai', P_REEL_0922, 'Хаяг хаана вэ?');
  assert.deepEqual(await outcomes([910], 'all', [...STORED, ask]), { 910: 'drafted' });
});
