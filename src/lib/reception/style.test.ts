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
