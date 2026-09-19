import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractComments } from './comments.ts';

const PAGE = '100000000000001';
const CREATED = 1_756_900_000; // seconds

function change(over: Record<string, unknown> = {}, field = 'feed') {
  return {
    field,
    value: {
      item: 'comment',
      verb: 'add',
      comment_id: `${PAGE}_c1`,
      post_id: `${PAGE}_p1`,
      from: { id: 'customer_1', name: 'Болормаа' },
      message: 'Үнэ хэд вэ?',
      created_time: CREATED,
      ...over,
    },
  };
}

const entry = (changes: unknown[]) => ({ id: PAGE, time: CREATED * 1000, changes });
const one = (over: Record<string, unknown> = {}) => extractComments(entry([change(over)]), PAGE);

test('a customer comment is extracted with its thread root', () => {
  const { comments, skipped } = one();
  assert.equal(skipped.length, 0);
  assert.equal(comments.length, 1);
  const c = comments[0];
  assert.equal(c?.commentId, `${PAGE}_c1`);
  assert.equal(c?.postId, `${PAGE}_p1`);
  assert.equal(c?.fromId, 'customer_1');
  assert.equal(c?.fromName, 'Болормаа');
  assert.equal(c?.text, 'Үнэ хэд вэ?');
  // A top-level comment is its own thread root.
  assert.equal(c?.threadId, `${PAGE}_c1`);
});

test('created_time is SECONDS, not milliseconds', () => {
  // Off by 1000 in one direction puts every comment in 1970 and the age check refuses
  // everything — comments silently never work. In the other it puts them in the year
  // 57000 and the age check passes the spam on a four-year-old post.
  const c = one().comments[0];
  assert.equal(c?.createdAt.getTime(), CREATED * 1000);
  assert.equal(c?.createdAt.getUTCFullYear(), 2025);
});

test('a reply to another comment takes the PARENT as its thread root', () => {
  // parent_id is the post id for a top-level comment and the parent COMMENT's id for a
  // reply. Comparing against post_id separates them without parsing Facebook's
  // {owner}_{object} id structure, which is undocumented and has changed before.
  const c = one({ comment_id: `${PAGE}_c2`, parent_id: `${PAGE}_c1` }).comments[0];
  assert.equal(c?.threadId, `${PAGE}_c1`, 'the reply joins its parent thread');
});

test('a top-level comment whose parent_id IS the post stays its own root', () => {
  const c = one({ parent_id: `${PAGE}_p1` }).comments[0];
  assert.equal(c?.threadId, `${PAGE}_c1`);
});

// ---------------------------------------------------------------------------
// Loop prevention, at the earliest possible point
// ---------------------------------------------------------------------------

test('DONE-TEST: the Page commenting on its own post is skipped', () => {
  const { comments, skipped } = one({ from: { id: PAGE, name: 'Matrix Eco Salon' } });
  assert.equal(comments.length, 0);
  assert.deepEqual(skipped, ['comment_self']);
});

// ---------------------------------------------------------------------------
// `feed` is a firehose
// ---------------------------------------------------------------------------

test('everything on the feed field that is not a comment is skipped and reported', () => {
  const { comments, skipped } = extractComments(
    entry([
      change({ item: 'post' }),
      change({ item: 'reaction' }),
      change({ item: 'share' }),
      change({ item: 'like' }),
      change({ item: 'status' }),
    ]),
    PAGE,
  );
  assert.equal(comments.length, 0);
  assert.deepEqual(skipped, Array(5).fill('not_a_comment'));
});

test('only `add` is answered — an edit or a removal is not', () => {
  for (const verb of ['edited', 'remove', 'hide', 'unhide']) {
    const { comments, skipped } = one({ verb });
    assert.equal(comments.length, 0, verb);
    assert.deepEqual(skipped, ['not_an_add'], verb);
  }
});

test('a hidden comment is left hidden — a public reply would drag it back into view', () => {
  const { comments, skipped } = one({ is_hidden: true });
  assert.equal(comments.length, 0);
  assert.deepEqual(skipped, ['hidden']);
});

test('DONE-TEST: a comment with NO TEXT is returned, not skipped', () => {
  // It used to push `no_text` into a `string[]` carrying no comment_id, no post_id and no
  // author — so a photograph under the salon's own post became the word "no_text" in a
  // counter and was unfindable. D-070, on the surface where it costs most: a customer
  // posting a picture of the colour they want is the most valuable comment a salon gets,
  // and it looked identical to a thumbs-up.
  //
  // Returned with an empty `text`, it reaches the classifier, fires no matcher, comes back
  // `unclassified` — silent, and RECORDED with its ids.
  for (const message of ['', '   ', undefined]) {
    const { comments, skipped } = one({ message });
    assert.equal(comments.length, 1, JSON.stringify(message));
    assert.equal(comments[0]?.text.trim(), '');
    assert.equal(comments[0]?.commentId, `${PAGE}_c1`, 'the ids survive — that is the whole point');
    assert.deepEqual(skipped, [], 'nothing is dropped, so nothing needs reporting');
  }
});

test('a field that is not `feed` is not ours', () => {
  const { comments, skipped } = extractComments(entry([change({}, 'messages')]), PAGE);
  assert.equal(comments.length, 0);
  assert.deepEqual(skipped, ['not_a_comment']);
});

test('a missing id is reported, never guessed at', () => {
  for (const over of [{ comment_id: undefined }, { post_id: undefined }, { from: {} }, { from: undefined }]) {
    const { comments, skipped } = one(over);
    assert.equal(comments.length, 0, JSON.stringify(over));
    assert.deepEqual(skipped, ['malformed'], JSON.stringify(over));
  }
});

test('a messaging entry yields nothing rather than throwing', () => {
  // The same stored row shape reaches both extractors. A DM entry has `messaging` and no
  // `changes`; this must be a quiet zero, not an exception in the worker.
  const { comments, skipped } = extractComments({ id: PAGE, messaging: [{ sender: { id: 'x' } }] }, PAGE);
  assert.equal(comments.length, 0);
  assert.equal(skipped.length, 0);
});

test('junk in, nothing out', () => {
  for (const junk of [null, undefined, 42, 'entry', [], { changes: 'not an array' }]) {
    assert.deepEqual(extractComments(junk, PAGE), { comments: [], skipped: [] }, JSON.stringify(junk));
  }
});

test('Mongolian Cyrillic is NFC-normalised on the way in', () => {
  // Rule 6. The composed and decomposed forms of Ё look identical and are different
  // strings; normalising at the boundary is what stops that becoming a matching bug later.
  const decomposed = 'Ёлка'.normalize('NFD');
  const c = one({ message: decomposed, from: { id: 'customer_1', name: decomposed } }).comments[0];
  assert.equal(c?.text, 'Ёлка'.normalize('NFC'));
  assert.equal(c?.fromName, 'Ёлка'.normalize('NFC'));
});

test('several comments in one entry are all returned', () => {
  const { comments } = extractComments(
    entry([
      change({ comment_id: 'a', message: 'нэг' }),
      change({ comment_id: 'b', message: 'хоёр' }),
      change({ item: 'reaction' }),
    ]),
    PAGE,
  );
  assert.deepEqual(comments.map((c) => c.commentId), ['a', 'b']);
});
