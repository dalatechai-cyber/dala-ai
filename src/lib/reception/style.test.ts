import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capEmoji, countEmoji, replyStyleOf, stylePriceRows } from './style.ts';

// DalaTech's look as the founder approved it on 2026-09-26 (option A, D-133), as data.
const STYLE = replyStyleOf({ price_header: '💬 {service}', price_line: '💰 {option}: {price}', max_emoji: 1 });
const DALI = 'Дали — AI хүлээн авагч';
const SERVICES = [
  { name: DALI, rows: [`${DALI} (Сарын төлбөр): 250,000₮`, `${DALI} (Нэг удаагийн суурилуулалт): 150,000₮`] },
  { name: 'Эхо — Утасны оператор', rows: ['Эхо — Утасны оператор (Сарын төлбөр): 250,000₮'] },
  { name: 'Ухаалаг вэбсайт', rows: ['Ухаалаг вэбсайт: 750,000₮'] },
];

test('DONE-TEST: a staff member\'s price reads as the approved look — header once, one line per option', () => {
  const body = `${DALI} (Сарын төлбөр): 250,000₮\n${DALI} (Нэг удаагийн суурилуулалт): 150,000₮`;
  assert.equal(stylePriceRows(body, SERVICES, STYLE),
    `💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮\n💰 Нэг удаагийн суурилуулалт: 150,000₮`);
});

test('every digit comes from the row; a line that is not a row is left exactly as it was', () => {
  const body = `Дали сард 250,000₮.\n${DALI} (Сарын төлбөр): 250,000₮\nӨөр асуулт байна уу?`;
  assert.equal(stylePriceRows(body, SERVICES, STYLE),
    `Дали сард 250,000₮.\n💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮\nӨөр асуулт байна уу?`);
});

test('two services get two headers; a bulleted row is still a row; a row with no option is untouched', () => {
  const body = `- ${DALI} (Сарын төлбөр): 250,000₮\n- Эхо — Утасны оператор (Сарын төлбөр): 250,000₮\nУхаалаг вэбсайт: 750,000₮`;
  assert.equal(stylePriceRows(body, SERVICES, STYLE),
    `💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮\n💬 Эхо — Утасны оператор\n💰 Сарын төлбөр: 250,000₮\nУхаалаг вэбсайт: 750,000₮`);
});

test('a tenant with no look (Tara) gets exactly what it got', () => {
  const body = `${DALI} (Сарын төлбөр): 250,000₮`;
  assert.equal(stylePriceRows(body, SERVICES, null), body);
  assert.equal(capEmoji('Сайн 😊 байна 👍', null, true), 'Сайн 😊 байна 👍');
  assert.equal(replyStyleOf(null), null);
  assert.equal(replyStyleOf('x'), null);
});

test('a half-configured look styles nothing rather than losing the prices', () => {
  const s = replyStyleOf({ price_header: '💬 {service}', max_emoji: 1 });
  assert.equal(s?.priceHeader, null);
  assert.equal(stylePriceRows(`${DALI} (Сарын төлбөр): 250,000₮`, SERVICES, s), `${DALI} (Сарын төлбөр): 250,000₮`);
  // A template without its slot is not a template.
  assert.equal(replyStyleOf({ price_header: '💬', price_line: '💰 {price}' })?.priceHeader ?? null, null);
});

test('DONE-TEST: at most one emoji in the model\'s words, none on a complaint or refusal', () => {
  assert.equal(capEmoji('Тийм 😊 болно 👍 шүү 🎉', 1, false), 'Тийм 😊 болно шүү');
  assert.equal(capEmoji('Уучлаарай 🙏 бид шалгана.', 1, true), 'Уучлаарай бид шалгана.');
  assert.equal(capEmoji('Тийм 😊', 1, false), 'Тийм 😊');
  // A joined or toned emoji is one emoji, removed whole.
  assert.equal(countEmoji('👍🏽 👨‍💻 ❤️'), 3);
  assert.equal(capEmoji('А 👨‍💻 Б 👍🏽.', 0, false), 'А Б.');
});

test('DONE-TEST: the model\'s lead-in above a styled header is dropped (DalaTech website, 2026-09-26 15:17)', () => {
  // The measured reply: the facts guard kept the intro, the rows were styled, and the
  // service was named twice. The header now stands alone.
  const body = `Дали — AI хүлээн авагчийн үнэ дараах байдалтай байна:\n${DALI} (Нэг удаагийн суурилуулалт): 150,000₮\n${DALI} (Сарын төлбөр): 250,000₮`;
  assert.equal(stylePriceRows(body, SERVICES, STYLE),
    `💬 ${DALI}\n💰 Нэг удаагийн суурилуулалт: 150,000₮\n💰 Сарын төлбөр: 250,000₮`);
  // A blank line between the lead-in and the rows goes with it.
  assert.equal(stylePriceRows(`Үнийн мэдээлэл:\n\n${DALI} (Сарын төлбөр): 250,000₮`, SERVICES, STYLE),
    `💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮`);
});

test('only a lead-in is dropped: a sentence, a line with a number, or an unstyled reply keeps its line', () => {
  const row = `${DALI} (Сарын төлбөр): 250,000₮`;
  // A full sentence before the rows is content, not an introduction.
  assert.equal(stylePriceRows(`Дали 24/7 ажиллана.\n${row}`, SERVICES, STYLE),
    `Дали 24/7 ажиллана.\n💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮`);
  // A colon line that says more than one clause stays.
  assert.equal(stylePriceRows(`Тийм, боломжтой. Үнэ нь:\n${row}`, SERVICES, STYLE),
    `Тийм, боломжтой. Үнэ нь:\n💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮`);
  // A number may be a fact; it is never removed here.
  assert.equal(stylePriceRows(`2 сонголт байна:\n${row}`, SERVICES, STYLE),
    `2 сонголт байна:\n💬 ${DALI}\n💰 Сарын төлбөр: 250,000₮`);
  // No look, no header, nothing removed.
  assert.equal(stylePriceRows(`Үнэ нь:\n${row}`, SERVICES, null), `Үнэ нь:\n${row}`);
  // A lead-in to a row the style does not touch (no option) stays.
  assert.equal(stylePriceRows('Вэбсайтын үнэ:\nУхаалаг вэбсайт: 750,000₮', SERVICES, STYLE),
    'Вэбсайтын үнэ:\nУхаалаг вэбсайт: 750,000₮');
});
