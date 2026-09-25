import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesPerson, pageCommentsIn, staffHandled, type PageComment } from './staff.ts';

const PAGE = '100000000000001';
const POST = `${PAGE}_p1`;

// ---------------------------------------------------------------------------
// namesPerson — whole names, whole words, Unicode-defined
// ---------------------------------------------------------------------------

test('a tag at the start of a staff reply names the person, Latin and Cyrillic', () => {
  assert.equal(namesPerson('Ogi Oyunaa 📍 Яармаг салбар', 'Ogi Oyunaa'), true);
  assert.equal(namesPerson('Дорж Бат Хуучиндаа . Манай салбар', 'Дорж Бат'), true);
  assert.equal(namesPerson('Saran Tuul Баярлалаа💕', 'Saran Tuul'), true);
});

test('a name further in — a copy-pasted answer carrying an earlier tag — names the person too', () => {
  const pasted = 'Khongor Battulga Ogi Oyunaa 📍 Яармаг салбар';
  assert.equal(namesPerson(pasted, 'Ogi Oyunaa'), true);
  assert.equal(namesPerson(pasted, 'Khongor Battulga'), true);
});

test('an emoji or punctuation glued to the name does not hide it', () => {
  assert.equal(namesPerson('Ogi Oyunaa📍 Яармаг', 'Ogi Oyunaa'), true);
  assert.equal(namesPerson('Сарнай С. Баярлалаа💕', 'Сарнай С.'), true);
  assert.equal(namesPerson('Б. Нар vip center 2 давхарт', 'Б. Нар'), true);
});

test('case and normalisation do not matter; the name is folded like every matcher', () => {
  assert.equal(namesPerson('OGI OYUNAA баярлалаа', 'Ogi Oyunaa'), true);
  assert.equal(namesPerson('САРАН ТУУЛ баярлалаа', 'Саран Туул'), true);
  // «й» typed decomposed (и + U+0306) against the composed form.
  assert.equal(namesPerson('Золбаяр Ганбой баярлалаа', 'Золбаяр Ганбой'), true);
});

test('a name is matched WHOLE: one part of it, or a word that merely starts with it, is not the person', () => {
  assert.equal(namesPerson('Ogi 📍 Яармаг салбар', 'Ogi Oyunaa'), false, 'a shortened tag is not recognised — stated in staff.ts');
  assert.equal(namesPerson('Одгэрэл баярлалаа', 'Од'), false, '«Од» is not a prefix match inside «Одгэрэл»');
  assert.equal(namesPerson('Б. Наргэрэл баярлалаа', 'Б. Нар'), false);
  assert.equal(namesPerson('Oyunaa Ogi баярлалаа', 'Ogi Oyunaa'), false, 'the words in order');
  assert.equal(namesPerson('Saran Tuulbaatar баярлалаа', 'Saran Tuul'), false);
});

test('a name that reduces to nothing names nobody', () => {
  assert.equal(namesPerson('💕 баярлалаа', '💕'), false);
  assert.equal(namesPerson('баярлалаа', ''), false);
});

// ---------------------------------------------------------------------------
// pageCommentsIn — only the Page, only comments, edits applied, removals withdrawn
// ---------------------------------------------------------------------------

const change = (value: Record<string, unknown>) => ({ field: 'feed', value: { item: 'comment', verb: 'add', post_id: POST, ...value } });
const entry = (...changes: unknown[]) => ({ id: PAGE, changes });

test('only the Page’s own comments are staff evidence — a stylist’s personal account is not the Page', () => {
  const got = pageCommentsIn([
    entry(change({ comment_id: 'a', parent_id: 'c1', from: { id: PAGE, name: 'Salon' }, message: 'Bold Bat баярлалаа' })),
    entry(change({ comment_id: 'b', parent_id: 'c2', from: { id: '90000000000000000', name: 'Stylist Account' }, message: 'Khulan Erdene Баярлалаа💕' })),
    entry({ field: 'feed', value: { item: 'reaction', verb: 'add', post_id: POST, comment_id: 'c3', from: { id: PAGE } } }),
  ], PAGE);
  assert.deepEqual(got.map((c) => c.commentId), ['a']);
  assert.equal(got[0]?.parentId, 'c1');
});

test('an edit replaces the text (it may add a tag); a removal withdraws the comment', () => {
  const got = pageCommentsIn([
    entry(change({ comment_id: 'a', parent_id: 'c1', from: { id: PAGE }, message: 'баярлалаа' })),
    entry(change({ comment_id: 'a', verb: 'edited', parent_id: 'c1', from: { id: PAGE }, message: 'Bold Bat баярлалаа' })),
    entry(change({ comment_id: 'b', parent_id: 'c2', from: { id: PAGE }, message: 'Saraa баярлалаа' })),
    entry(change({ comment_id: 'b', verb: 'remove', parent_id: 'c2', from: { id: PAGE } })),
  ], PAGE);
  assert.deepEqual(got, [{ commentId: 'a', postId: POST, parentId: 'c1', text: 'Bold Bat баярлалаа' }]);
});

// ---------------------------------------------------------------------------
// staffHandled — (a) replied under it, (b) tagged the person on the post
// ---------------------------------------------------------------------------

const pc = (over: Partial<PageComment>): PageComment => ({ commentId: 's1', postId: POST, parentId: POST, text: '', ...over });
const customer = { commentId: 'c1', postId: POST, fromName: 'Ogi Oyunaa' };

test('(a) the Page replied under this comment', () => {
  const r = staffHandled({ comment: customer, pageComments: [pc({ parentId: 'c1', text: 'Мэдээлэл 📍' })], ours: new Set() });
  assert.deepEqual(r, { handled: true, how: 'replied', staffCommentId: 's1' });
});

test('(b) the Page tagged this commenter on the same post, under someone else’s comment', () => {
  const r = staffHandled({
    comment: customer,
    pageComments: [pc({ commentId: 's2', parentId: 'c9', text: 'Khongor Battulga Ogi Oyunaa 📍 Яармаг' })],
    ours: new Set(),
  });
  assert.deepEqual(r, { handled: true, how: 'tagged', staffCommentId: 's2' });
});

test('(a) wins over (b): the more specific proof is the one recorded', () => {
  const r = staffHandled({
    comment: customer,
    pageComments: [pc({ commentId: 's2', parentId: 'c9', text: 'Ogi Oyunaa 📍' }), pc({ commentId: 's3', parentId: 'c1', text: 'Ogi Oyunaa 📍' })],
    ours: new Set(),
  });
  assert.equal(r.handled === true && r.staffCommentId, 's3');
});

test('the Page answering SOMEONE ELSE in the same thread is not an answer to this person', () => {
  // Webhook 749: a reply inside a thread the Page had answered for Дорж Бат two days
  // earlier. The founder wants it answered.
  const r = staffHandled({
    comment: { commentId: 'c749', postId: POST, fromName: 'Saran Tuul' },
    pageComments: [pc({ parentId: 'c412', text: 'Дорж Бат Хуучиндаа . Манай салбар удахгүй' })],
    ours: new Set(),
  });
  assert.deepEqual(r, { handled: false });
});

test('another post’s staff activity does not count', () => {
  const r = staffHandled({
    comment: customer,
    pageComments: [pc({ postId: `${PAGE}_p2`, parentId: 'c1', text: 'Ogi Oyunaa 📍' })],
    ours: new Set(),
  });
  assert.deepEqual(r, { handled: false });
});

test('OUR OWN reply is a Page comment too, and is not staff', () => {
  const r = staffHandled({ comment: customer, pageComments: [pc({ parentId: 'c1' })], ours: new Set(['s1']) });
  assert.deepEqual(r, { handled: false });
});

test('no commenter name: (b) cannot be asked, and unknown refuses', () => {
  const r = staffHandled({ comment: { ...customer, fromName: null }, pageComments: [], ours: new Set() });
  assert.equal(r.handled, null);
  // (a) still decides when it can: a reply under the comment needs no name.
  const a = staffHandled({ comment: { ...customer, fromName: null }, pageComments: [pc({ parentId: 'c1' })], ours: new Set() });
  assert.equal(a.handled, true);
});
