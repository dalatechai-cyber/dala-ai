import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byCodePoint, capToSingleMessage, cpLength, cpOffsets, fold, letters, nfc, scriptShare, stripSpans } from './text.ts';

test('the four ASCII constructs this module replaces really are broken on Mongolian', () => {
  // Pinned as executable evidence, not as a comment. If a future Node changed any of
  // these, the guard built on top of them would change meaning silently.
  assert.equal(/\bзасалт\b/.test('Мөнгөн засалт'), false);  // ascii-safe: demonstrating the failure
  assert.equal(/\w/.test('үс'), false);                      // ascii-safe: demonstrating the failure
  assert.equal(/[a-z]/i.test('үс'), false);                  // ascii-safe: demonstrating the failure
  assert.equal('😊'.length, 2);
  assert.equal(cpLength('😊'), 1);
});

test('Ё and Й decompose; Ө and Ү do not — the precise mechanism behind the unaccent ban', () => {
  // CLAUDE.md rule 6 bans `unaccent` because it is PARTIALLY destructive. This is why:
  // it strips combining marks, so it flattens Ё→Е while leaving Ө and Ү — the two
  // letters that most distinguish Mongolian from Russian — untouched. It therefore
  // appears to work on nine strings in ten.
  assert.equal('Ё'.normalize('NFD').length, 2, 'Ё decomposes: unaccent would flatten it');
  assert.equal('Й'.normalize('NFD').length, 2, 'Й decomposes');
  assert.equal('Ө'.normalize('NFD').length, 1, 'Ө has no combining mark to strip');
  assert.equal('Ү'.normalize('NFD').length, 1, 'Ү has no combining mark to strip');
});

test('NFC matters for exactly the words containing Ё or Й, which is why it is unconditional', () => {
  assert.equal('хүүхэд'.normalize('NFD'), 'хүүхэд'.normalize('NFC'), 'identical — the reassuring case');
  assert.notEqual('Ёлка'.normalize('NFD'), 'Ёлка'.normalize('NFC'), 'and the case that breaks a matcher');
  assert.equal(nfc('Сайн'.normalize('NFD')), 'Сайн');
});

test('folding is locale-aware and reaches the Mongolian-only letters', () => {
  assert.equal(fold('ХҮҮХЭД'), 'хүүхэд');
  assert.equal(fold('ӨНӨӨДӨР'), 'өнөөдөр');
  assert.equal(fold('Сайн'.normalize('NFD')), 'сайн', 'folding normalises first');
});

test('cpOffsets maps every UTF-16 index, including both halves of a surrogate pair', () => {
  const s = '😊а';
  const off = cpOffsets(s);
  assert.equal(off.length, s.length + 1);
  assert.equal(off[0], 0);
  assert.equal(off[1], 0, 'the low surrogate maps to the same character index');
  assert.equal(off[2], 1);
  assert.equal(off[3], 2, 'the end offset is the total character count');
});

test('letters counts Cyrillic and ignores digits, punctuation and emoji', () => {
  assert.deepEqual(letters('үс 33,000₮ 😊'), ['ү', 'с']);
});

// ---------------------------------------------------------------------------
// Script share — §6.10.3, the English-reply detector.
// ---------------------------------------------------------------------------

test('a Mongolian reply scores high and an English one scores low', () => {
  const mn = 'Эмэгтэй үс тайралтын үнэ жагсаалтад бичсэнээр байгаа бөгөөд лавлагаа авна уу';
  const en = 'Sorry, I do not have that information available right now, please call us';
  assert.equal((scriptShare(mn, 'Cyrillic') ?? 0) > 0.9, true);
  assert.equal((scriptShare(en, 'Cyrillic') ?? 1) < 0.5, true);
});

test('a short reply returns null, not a score — three words are not evidence of a language', () => {
  // Returning 0 here would refuse every short Mongolian reply; returning 1 would pass
  // every short English one. Forcing the caller to handle "not enough evidence" is what
  // stops it being silently scored either way.
  assert.equal(scriptShare('Тийм ээ', 'Cyrillic'), null);
  assert.equal(typeof scriptShare('Тийм ээ', 'Cyrillic', { minLetters: 3 }), 'number');
});

test('allow-listed service names and links are excluded before the share is computed', () => {
  // A legitimate reply can be mostly a URL plus a brand name. Counting those Latin
  // letters against the tenant would refuse a perfectly good Mongolian answer.
  const reply = 'CICA Омбре үйлчилгээний талаар https://www.matrixecosalon.org/ хаягаас үзнэ үү';
  const naive = scriptShare(reply, 'Cyrillic') ?? 0;
  const fair = scriptShare(reply, 'Cyrillic', { exclude: ['CICA', 'https://www.matrixecosalon.org/'] }) ?? 0;
  assert.equal(fair > naive, true, 'excluding the allow-listed spans raises the score');
  assert.equal(fair > 0.9, true);
});

test('the script is CONFIG — a Russian-speaking tenant is a row, not a branch', () => {
  const ru = 'Здравствуйте, стоимость стрижки указана в нашем прайс листе на сайте';
  assert.equal((scriptShare(ru, 'Cyrillic') ?? 0) > 0.9, true);
  assert.equal((scriptShare('Hello there, how may I help you with your appointment', 'Latin') ?? 0) > 0.9, true);
});

test('an unknown script THROWS rather than silently scoring 0 or 1', () => {
  // A silent 0 refuses the whole tenant; a silent 1 passes an English reply. Neither is
  // a thing to discover in production, so the caller is made to handle it.
  assert.throws(() => scriptShare('a'.repeat(30), 'Klingon'), /Unknown Unicode script/);
  assert.throws(() => scriptShare('a'.repeat(30), 'Cyrillic); drop table'), /Not a Unicode script name/);
});

test('stripSpans removes the longest span first, so a substring cannot fragment it', () => {
  assert.equal(stripSpans('CICA CICA Deluxe', ['CICA', 'CICA Deluxe']).includes('Deluxe'), false);
});

// ---------------------------------------------------------------------------
// Length capping — §6.10.2.
// ---------------------------------------------------------------------------

const SUFFIX = ' …';

test('a reply within the limit is returned untouched', () => {
  const r = capToSingleMessage('Богино хариулт.', 1900, SUFFIX);
  assert.deepEqual(r, { text: 'Богино хариулт.', truncated: false });
});

test('an over-long reply is cut at a SENTENCE boundary, never mid-word', () => {
  const text = 'Нэгдүгээр өгүүлбэр. Хоёрдугаар өгүүлбэр. Гуравдугаар өгүүлбэр маш урт байна.';
  const r = capToSingleMessage(text, 45, SUFFIX);
  assert.notEqual(r, null);
  assert.equal(r?.truncated, true);
  assert.equal(r?.text, 'Нэгдүгээр өгүүлбэр. Хоёрдугаар өгүүлбэр. …');
  assert.equal(cpLength(r?.text ?? '') <= 45, true);
});

test('a reply with no sentence boundary in reach returns null rather than a half-sentence', () => {
  // §6.10.1: a truncated Mongolian half-sentence must not be sent. The caller falls back
  // to the tenant's pinned handoff line instead.
  assert.equal(capToSingleMessage('үг '.repeat(200), 100, SUFFIX), null);
});

test('the cap counts CODE POINTS, so an emoji-heavy reply is not silently over the wire limit', () => {
  const text = `${'😊'.repeat(30)} Дууссан. ${'😊'.repeat(30)} Дараагийнх нь.`;
  // 30 emoji, then « Дууссан.» — the sentence end sits at character 38, which is inside a
  // 45-character budget but at UTF-16 index 68, well outside it. Counting units instead of
  // characters would find no boundary here and throw the whole reply away.
  assert.equal(text.length > 45, true, 'precondition: it overflows in UTF-16 units');
  const r = capToSingleMessage(text, 45, SUFFIX);
  assert.notEqual(r, null);
  assert.equal(cpLength(r?.text ?? '') <= 45, true);
  assert.equal(Array.from(r?.text ?? '').every((c) => c !== '�'), true, 'no surrogate was split');
});

test('the pinned suffix is a PARAMETER — a customer-visible sentence is never a constant here', () => {
  // Every customer-facing Mongolian string is tenant data behind a `reviewed_at` gate.
  // A library file that hardcoded one would route around that review.
  const a = capToSingleMessage('Эхний. Хоёр дахь өгүүлбэр урт.', 20, 'X');
  const b = capToSingleMessage('Эхний. Хоёр дахь өгүүлбэр урт.', 20, 'YY');
  assert.equal(a?.text.endsWith('X'), true);
  assert.equal(b?.text.endsWith('YY'), true);
});

test('a suffix longer than the whole limit returns null instead of a negative slice', () => {
  assert.equal(capToSingleMessage('урт '.repeat(50), 3, 'ХАРИУЛТ'), null);
});

// ---------------------------------------------------------------------------
// byCodePoint — the ordering the prompt cache depends on
// ---------------------------------------------------------------------------

/** The exact strings measured against both databases on 2026-09-05. */
const MEASURED = ['Үс засалт', 'үс будалт', 'Үс-засалт', 'ҮС ЗАСАЛТ', 'Чёлк тайралт', 'Челк тайралт'];

test('DONE-TEST: sorting is by code point, matching neither database collation by accident', () => {
  // Measured, not assumed:
  //   CI   (C.UTF-8)     Челк | Чёлк | ҮС ЗАСАЛТ | Үс засалт | Үс-засалт | үс будалт
  //   Real (en_US.UTF-8) үс будалт | Үс засалт | ҮС ЗАСАЛТ | Үс-засалт | Челк | Чёлк
  //
  // Code point order equals the C.UTF-8 order, because C.UTF-8 IS code point order. The
  // point is not that we match CI — it is that we no longer ask a database at all, so the
  // answer cannot change when the server does.
  assert.deepEqual([...MEASURED].sort(byCodePoint), [
    'Челк тайралт', 'Чёлк тайралт', 'ҮС ЗАСАЛТ', 'Үс засалт', 'Үс-засалт', 'үс будалт',
  ]);
});

test('and it disagrees with localeCompare, which is why localeCompare is not used', () => {
  // If these agreed, the test above would prove nothing about locale-independence.
  const byLocale = [...MEASURED].sort((a, b) => a.localeCompare(b));
  assert.notDeepEqual([...MEASURED].sort(byCodePoint), byLocale);
});

test('case is code-point case: uppercase sorts before lowercase, always', () => {
  // en_US.UTF-8 gives a|B|c; code point gives B|a|c. A locale-sensitive sort would put
  // «үс» and «Үс» adjacent; this does not, and that is the deterministic answer.
  assert.deepEqual(['a', 'B', 'c'].sort(byCodePoint), ['B', 'a', 'c']);
});

test('astral characters sort by code point, not by surrogate half', () => {
  // '\u{1F600}' (U+1F600) is above '\uFFFD' by code point, but its leading surrogate
  // (0xD83D) is BELOW it as a UTF-16 unit. A naive `a < b` gets this backwards.
  const emoji = '\u{1F600}';
  const replacement = '\uFFFD';
  assert.equal(byCodePoint(emoji, replacement) > 0, true, 'U+1F600 sorts after U+FFFD');
  assert.equal(emoji < replacement, true, 'and a raw UTF-16 comparison disagrees');
});

test('it is a total order: reflexive, antisymmetric, and stable on equals', () => {
  assert.equal(byCodePoint('үс', 'үс'), 0);
  assert.equal(byCodePoint('үс', 'үсэн') < 0, true, 'a prefix sorts before its extension');
  assert.equal(byCodePoint('үсэн', 'үс') > 0, true);
});
