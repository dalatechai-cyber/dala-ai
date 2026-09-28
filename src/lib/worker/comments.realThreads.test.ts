/**
 * Matrix / Tara Salon's real comment threads, replayed through `runCommentJob` (D-122
 * addendum). The staff answer comments by hand from the Page; these are the threads where
 * they did, and what the bot decides about each customer in them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayComments, type ReplayRule } from './commentReplay.fixtures.ts';
import { P_REEL_0829, P_REEL_0922, SELLER_ADVERTS, SELLER_ID, STORED, ZES_QUESTION, type StoredComment } from '../comments/realThreads.fixtures.ts';

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
    // 751 «Saran Tuul Баярлалаа💕» — a thank-you for her praise (748), and a tag of her
    // on this post. The rule cannot tell a thank-you from an answer; it is the founder's
    // rule as written, and it only binds once the thank-you exists (14:10, an hour later).
    749: 'staff_tagged_commenter',
    // 803: the Page replied under «Үнэ хаяг» at 14:19, 7.5 hours after it.
    784: 'staff_replied',
  });
});

test('25 Sept, P_REEL_0829: «Үнэ хаяг» is replied to by the Page and tagged in all five of its answers', () => {
  const pageOnPost = STORED.filter((c) => c.postId === P_REEL_0829 && c.fromId !== '90000000000000003' && c.eventId !== 784);
  assert.equal(pageOnPost.length, 5);
  assert.ok(pageOnPost.every((c) => (c.message ?? '').includes('Ogi Oyunaa')));
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
    wouldBe(901, 'u901', 'Ogi Oyunaa', P_REEL_0829, 'Үнэ хэд вэ?'),
    wouldBe(902, 'u902', 'Khongor Battulga', P_REEL_0829, 'Үнэ хэд вэ?'),
    wouldBe(903, 'u903', 'Цэцэгмаа Дорж', P_REEL_0829, 'Хаяг хаана вэ?'),
    wouldBe(904, 'u904', 'Ундрах Ганбаатар', P_REEL_0829, 'Цаг авч болох уу?'),
    wouldBe(905, 'u905', 'Erdene Erdenechimeg', P_REEL_0829, 'une hed ve'),
    // Somebody the staff never answered, same post, same minute: the bot answers.
    wouldBe(906, 'u906', 'Bold Bat', P_REEL_0829, 'Үнэ хэд вэ?'),
    // Only half of a tagged name: not the same person.
    wouldBe(907, 'u907', 'Ogi Bat', P_REEL_0829, 'Үнэ хэд вэ?'),
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
    492: 'staff_replied', // 508 under it, «Б. Нар vip center 2 давхарт…»
    705: 'staff_replied', // 711 under it, 5.5 h later
    706: 'staff_tagged_commenter', // her second comment; 711 tagged «Батзориг Намсрай» on the post
  });
});

test('a personal account thanking someone is not the Page, and silences nobody', async () => {
  // Webhook 484: «Khulan Erdene Баярлалаа💕» from a stylist's own account.
  const ask = wouldBe(910, 'u910', 'Khulan Erdene', P_REEL_0922, 'Хаяг хаана вэ?');
  assert.deepEqual(await outcomes([910], 'all', [...STORED, ask]), { 910: 'drafted' });
});

// DalaTech's Page, 2026-09-26: Meta's auto comment reply «chat bicnuu», created in the same
// second as the comment it answers, is the Page but not staff (D-126 addendum).
test('DONE-TEST (live, 2026-09-26): META\'S AUTO COMMENT REPLY IS NOT STAFF ANSWERING', async () => {
  const post = P_REEL_0829;
  const customer: StoredComment = {
    eventId: 9001, receivedAt: '2026-09-25T19:19:50.500Z', fromId: '90000000000000099', fromName: 'Test Person',
    commentId: '1378787287727016_900', parentId: post, postId: post, message: 'Үнэ хэд вэ?', createdTime: 1790363976,
  };
  const auto: StoredComment = {
    eventId: 9002, receivedAt: '2026-09-25T19:19:51.168Z', fromId: STORED.find((c) => c.eventId === 803)!.fromId,
    fromName: 'Page', commentId: '1378787287727016_901', parentId: customer.commentId, postId: post,
    message: 'chat bicnuu', createdTime: 1790363976,
  };
  const rules = RULES;
  const [withoutRows] = await replayComments({ stored: [customer, auto], decide: [9001], rules, evidence: 'all' });
  assert.equal(withoutRows?.outcome, 'staff_replied', 'without the row the automation reads as staff');
  const [withRows] = await replayComments({
    stored: [customer, auto], decide: [9001], rules, evidence: 'all', automationTexts: ['chat bicnuu'],
  });
  assert.equal(withRows?.outcome, 'drafted');
});

// ---------------------------------------------------------------------------
// 2026-09-28: a seller's advert answered, a customer's question missed (P_REEL_0829)
// ---------------------------------------------------------------------------

test('27 Sept: the seller’s advert, posted three times, gets NOTHING — no public line, no private message', async () => {
  // The first copy was answered live on 2026-09-27: «үнэ» fired the `price` rule. Every copy
  // is now an advert, decided on its own words before the rules' verdict can post anything.
  const replay = await replayComments({
    stored: [...STORED, ...SELLER_ADVERTS], decide: [1094, 1095, 1096], rules: RULES, evidence: 'at_decision',
  });
  assert.deepEqual(Object.fromEntries(replay.map((o) => [o.eventId, o.outcome])), {
    1094: 'comment_advert', 1095: 'comment_advert', 1096: 'comment_advert',
  });
  for (const o of replay) {
    assert.equal(o.result.drafted, 0);
    assert.equal(o.result.privateDrafted, 0);
  }
});

test('20 Sept: «Зэсэн улаан туяа арилдагуу» is answered by today’s template, on the post it was asked on', async () => {
  // Missed on the day because the rule that answers it did not exist until 2026-09-25.
  assert.deepEqual(await outcomes([219], 'at_decision', [...STORED, ZES_QUESTION]), { 219: 'drafted' });
});

test('the same customer question beside the seller’s adverts is still answered', async () => {
  const q = { ...ZES_QUESTION, eventId: 1100, receivedAt: '2026-09-27T14:32:00.000Z', commentId: '1378787287727016_9001100', createdTime: 1790519520 };
  assert.deepEqual(await outcomes([1094, 1100], 'at_decision', [...STORED, ...SELLER_ADVERTS, q]), {
    1094: 'comment_advert', 1100: 'drafted',
  });
});

test('an advert with no phone, price or seller word is caught the SECOND time it is pasted, on another post', async () => {
  // Stated limit: the words alone do not make this an advert, so the first copy is answered.
  // The copy pasted under the next post is the same account's same comment, and is refused.
  const text = 'Японоос ирсэн үсний маск байна, үнэ нь маш боломжийн шүү, инбоксоор ороорой';
  const first = wouldBe(1101, SELLER_ID, 'Seller Page', P_REEL_0829, text);
  const second = wouldBe(1102, SELLER_ID, 'Seller Page', P_REEL_0922, text);
  assert.deepEqual(await outcomes([1101, 1102], 'at_decision', [...STORED, first, second]), {
    1101: 'drafted', 1102: 'comment_advert',
  });
});

test('a customer asking the same short question twice is not a pasted advert', async () => {
  const a = wouldBe(1103, 'u1103', 'Bold Bat', P_REEL_0829, 'Үнэ хэд вэ?');
  const b = wouldBe(1104, 'u1103', 'Bold Bat', P_REEL_0922, 'Үнэ хэд вэ?');
  assert.deepEqual(await outcomes([1103, 1104], 'at_decision', [...STORED, a, b]), { 1103: 'drafted', 1104: 'drafted' });
});
