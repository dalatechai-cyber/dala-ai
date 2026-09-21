import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingApology, renderBookingAnswer, apologyStemsFrom } from './bookingApology.ts';

const BOOKING = 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, '
  + 'урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
const CANNED = [
  { kind: 'handoff', body: 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Та 76001888 руу залгана уу.' },
  { kind: 'booking_line', body: BOOKING },
];
const STEMS = apologyStemsFrom(CANNED);
const DEPOSITS = ['Мастер үсчин: 20,000₮', '1-р зэргийн үсчин: 10,000₮'];

test('DONE-TEST: THE MEASURED APOLOGY IS CAUGHT', () => {
  // Verbatim shape from «tsag zahialah», three times in five runs WITH the draft that says
  // «УУЧЛАЛТ БҮҮ ГУЙ» active in the prompt.
  const reply = `Уучлаарай, би цаг захиалгыг өөрөө хийж чадахгүй. Мастер үсчинд урьдчилгаа 20,000₮.\n\n${BOOKING}`;
  const v = bookingApology(reply, BOOKING, STEMS);
  assert.equal(v.apologises, true);
  assert.equal(v.apologises && v.opening, 'Уучлаарай, би цаг захиалгыг өөрөө хийж чадахгүй');
});

test('DONE-TEST: the derived stem is the tenant\'s own word, not a literal in src/', () => {
  assert.deepEqual(STEMS, ['Уучлаарай']);
  assert.deepEqual(apologyStemsFrom([]), [], 'no handoff row, no stem, check inert');
  assert.deepEqual(apologyStemsFrom([{ kind: 'handoff', body: 'Hi there.' }]), [],
    'a two-letter opening is too short to be a stem');
});

test('DONE-TEST: THE SERVED ANSWER IS THE DEPOSIT THEN THE LINK', () => {
  assert.equal(renderBookingAnswer(DEPOSITS, BOOKING),
    `Мастер үсчин: 20,000₮\n1-р зэргийн үсчин: 10,000₮\n\n${BOOKING}`);
});

test('a booking reply with no apology is left alone', () => {
  assert.deepEqual(bookingApology(`Урьдчилгаа 20,000₮.\n\n${BOOKING}`, BOOKING, STEMS), { apologises: false });
});

test('an apology that is NOT in the opening sentence is left alone', () => {
  // This is about the first thing a customer reads, which is what the founder objected to.
  const reply = `Урьдчилгаа 20,000₮. ${BOOKING} Уучлаарай, өөр зүйл мэдэхгүй.`;
  assert.deepEqual(bookingApology(reply, BOOKING, STEMS), { apologises: false });
});

test('a REFUSAL that opens with the apology is untouched — it carries no booking line', () => {
  const refusal = 'Уучлаарай, энэ үйлчилгээний үнэ надад байхгүй байна.';
  assert.deepEqual(bookingApology(refusal, BOOKING, STEMS), { apologises: false });
});

test('the booking line is recognised when the model wraps prose around it', () => {
  const wrapped = `Уучлаарай, би чадахгүй. Гэхдээ ${BOOKING} Баярлалаа.`;
  assert.equal(bookingApology(wrapped, BOOKING, STEMS).apologises, true);
});

test('no booking line means nothing to serve, and nothing is claimed', () => {
  assert.deepEqual(bookingApology('Уучлаарай, юу ч мэдэхгүй.', null, STEMS), { apologises: false });
  assert.equal(renderBookingAnswer(DEPOSITS, null), null);
  assert.equal(renderBookingAnswer(DEPOSITS, '   '), null);
});

test('a tenant with no deposit rows still gets the link', () => {
  assert.equal(renderBookingAnswer([], BOOKING), BOOKING);
});
