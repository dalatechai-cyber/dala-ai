import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelDepositRow, rosterFromPrefix, stylistNamedReply, type StylistNamedInput } from './stylistNamed.ts';
import { ASKS_PRICE } from './photoPrice.ts';
import { hasWord } from '../mn/match.ts';

const asksPrice = (t: string): boolean => hasWord(t, ASKS_PRICE);

const PREFIX = [
  '=== БАГИЙН ЖАГСААЛТ ===',
  '- Badamaa · Эмэгтэй үсчид · Мастер үсчин',
  '- Oyunaa · Эмэгтэй үсчид · SPECIAL үсчин',
  '- Uyanga · Эмэгтэй үсчид · 1-р зэргийн үсчин',
  '- Anand · Эрэгтэй үсчид · Мастер үсчин',
  '',
  '=== ҮНИЙН ЖАГСААЛТ ===',
].join('\n');
const ROSTER = rosterFromPrefix(PREFIX, 'БАГИЙН ЖАГСААЛТ');
const BOOKING = 'Та манай вэбсайтаар (https://www.tarasalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
const DEPOSITS = ['Урьдчилгаа төлбөр — 1-р зэргийн үсчин: 10,000₮', 'Урьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮', 'Урьдчилгаа төлбөр — Мастер үсчин: 20,000₮'];
const SERVICES = [
  { name: 'Эмэгтэй тайралт', prices: ['120000', '99000', '66000'], rows: ['Эмэгтэй тайралт (SPECIAL): 120,000₮', 'Эмэгтэй тайралт (Мастер): 99,000₮', 'Эмэгтэй тайралт (1-р зэрэг): 66,000₮'] },
  { name: 'Эрэгтэй тайралт', prices: ['69000', '89000'], rows: ['Эрэгтэй тайралт: 69,000₮', 'Эрэгтэй тайралт (Мастер): 79,000₮'] },
  { name: 'Хэлбэржүүлэлт', prices: ['50000'], rows: ['Хэлбэржүүлэлт (Мастер): 50,000₮'] },
];
const base = (msg: string, over: Partial<StylistNamedInput> = {}): StylistNamedInput => ({
  customerMessage: msg, roster: ROSTER, spellings: [{ latin: 'oyunaa', cyrillic: 'оюунаа' }, { latin: 'oyuna', cyrillic: 'оюунаа' }],
  serviceNames: SERVICES, depositRows: DEPOSITS, bookingLine: BOOKING, asksPrice, ...over,
});

test('the roster is read as the prefix renders it', () => {
  assert.deepEqual(ROSTER[1], { name: 'Oyunaa', shortName: null, group: 'Эмэгтэй үсчид', tier: 'SPECIAL үсчин' });
  assert.deepEqual(rosterFromPrefix('=== Б ===\n- Long Name (Short) · G · T', 'Б')[0], { name: 'Long Name', shortName: 'Short', group: 'G', tier: 'T' });
});

test('«Оюунаа» alone: her level, her level\'s services, her deposit, the booking line — no other level', () => {
  for (const msg of ['Оюунаа', 'оюунаа?', 'Oyunaa', 'OYUNAA 🙂']) {
    const r = stylistNamedReply(base(msg));
    assert.equal(r?.intent, 'bare', msg);
    assert.equal(r?.body, `Oyunaa — SPECIAL үсчин\nЭмэгтэй тайралт (SPECIAL): 120,000₮\nУрьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮\n\n${BOOKING}`, msg);
  }
});

test('«Оюунаад цаг авч болох уу?»: names her and her 20,000₮ deposit only', () => {
  for (const msg of ['Оюунаад цаг авч болох уу?', 'Oyunaad tsag avch boloh uu', 'Оюунаагаар цаг захиалъя']) {
    const r = stylistNamedReply(base(msg));
    assert.equal(r?.intent, 'booking', msg);
    assert.equal(r?.body, `Oyunaa — SPECIAL үсчин\nУрьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮\n\n${BOOKING}`, msg);
    assert.doesNotMatch(r?.body ?? '', /10,000/u);
  }
});

test('a men\'s hairdresser is never offered a women\'s level row, nor the other way round', () => {
  const anand = stylistNamedReply(base('Anand'));
  assert.match(anand?.body ?? '', /^Anand — Мастер үсчин\nЭрэгтэй тайралт \(Мастер\): 79,000₮\nХэлбэржүүлэлт \(Мастер\): 50,000₮\nУрьдчилгаа төлбөр — Мастер үсчин: 20,000₮/u);
  assert.doesNotMatch(anand?.body ?? '', /Эмэгтэй/u);
  const badamaa = stylistNamedReply(base('Badamaa'));
  assert.doesNotMatch(badamaa?.body ?? '', /Эрэгтэй/u);
  assert.match(badamaa?.body ?? '', /Эмэгтэй тайралт \(Мастер\): 99,000₮/u);
});

test('anything else goes on as before: other words, a price ask, two names, an unknown name, missing rows', () => {
  for (const msg of ['Оюунаа хэдэн цагаас ажилладаг вэ?', 'Oyunaa bnu', 'Оюунаад цаг авах үнэ хэд вэ', 'Oyunaa Badamaa', 'Болор', 'цаг авъя', '']) {
    assert.equal(stylistNamedReply(base(msg)), null, msg);
  }
  assert.equal(stylistNamedReply(base('Oyunaa', { bookingLine: null })), null);
  assert.equal(stylistNamedReply(base('Oyunaa', { depositRows: [] })), null);
  // No spelling row for the Cyrillic form: the Latin name only (Парк Од today).
  assert.equal(stylistNamedReply(base('Оюунаа', { spellings: [] })), null);
  assert.equal(stylistNamedReply(base('Oyunaa', { spellings: [] }))?.intent, 'bare');
});

test('one row for two levels is found for either (Парк Од: «SPECIAL болон Мастер үсчин: 20,000₮»)', () => {
  const rows = ['Урьдчилгаа төлбөр: SPECIAL болон Мастер үсчин: 20,000₮'];
  assert.equal(levelDepositRow(ROSTER[1]!, rows), rows[0]);
  assert.equal(levelDepositRow(ROSTER[0]!, rows), rows[0]);
  assert.equal(levelDepositRow(ROSTER[2]!, rows), null);
});

test('a name is a name only with a known ending: «saraas» (from the month), «tomoohon» (big) are not hairdressers', () => {
  const roster = rosterFromPrefix('=== Б ===\n- Saraa · Эмэгтэй үсчид · Мастер үсчин\n- Tomoo · Эмэгтэй үсчид · Мастер үсчин', 'Б');
  const input = (msg: string): StylistNamedInput => ({ ...base(msg), roster, spellings: [] });
  for (const msg of ['Daraa saraas tsag avch boloh uu?', 'Ene saraa tsag avmaar baina', 'Tomoohon zahialga avna uu', 'Bi Saraa, margaash tsag avmaar baina']) {
    assert.equal(stylistNamedReply(input(msg)), null, msg);
  }
  assert.equal(stylistNamedReply(input('Saraa-d tsag avmaar baina'))?.intent, 'booking');
  assert.equal(stylistNamedReply(input('Saraagaas tsag avch boloh uu'))?.intent, 'booking');
});
