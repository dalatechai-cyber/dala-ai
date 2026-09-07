import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, turnsToBookingLink, type ConversationTurn, type TurnsResult } from './turnsToIntent.ts';
import { MIN_STEM_CHARS } from '../gate/match.ts';

const URL = 'https://www.matrixecosalon.org/';
const LINK = `Та манай вэбсайтаар (${URL}) онлайнаар цаг захиалах боломжтой.`;

/** Stems are DATA — supplied here as a test would supply them, never imported from src. */
const STEMS = ['цаг авм', 'цаг захиал', 'бичүүл'];
const SPEC = { intentStems: STEMS, bookingUrl: URL };

const inbound = (body: string): ConversationTurn => ({ direction: 'inbound', body });
const outbound = (body: string): ConversationTurn => ({ direction: 'outbound', body });

// ---------------------------------------------------------------------------
// The transcript that prompted the metric
// ---------------------------------------------------------------------------

test('DONE-TEST: THE ANCESTOR\'S BOOKING CONVERSATION SCORES 4', () => {
  // Measured by hand against Matrix's live bot on 2026-09-07: gender, then tier, then a
  // price, and only then the link. This is the baseline the mirror has to beat, and the
  // number the founder can put in front of a salon.
  const r = turnsToBookingLink([
    inbound('Цаг авмаар байна'),
    outbound('Эрэгтэй эсвэл эмэгтэй тайралт уу?'),
    inbound('Эмэгтэй'),
    outbound('Мастер эсвэл 1-р зэргийн үсчин үү?'),
    inbound('Мастер'),
    outbound('Мастер үсчин 66,000₮. Урьдчилгаа 20,000₮.'),
    inbound('За'),
    outbound(LINK),
  ], SPEC);

  assert.deepEqual(r, { outcome: 'delivered', turns: 4, intentStem: 'цаг авм' });
});

test('DONE-TEST: leading with the link scores 1', () => {
  // What the fix is for. Same intent, same tenant, one reply.
  const r = turnsToBookingLink([inbound('Цаг авмаар байна'), outbound(LINK)], SPEC);
  assert.equal(r.outcome === 'delivered' && r.turns, 1);
});

test('the deposit may ride along with the link without costing a turn', () => {
  // The deposit is not the problem; asking three questions to compute it is. A reply that
  // carries both still scores 1.
  const r = turnsToBookingLink([
    inbound('Цаг захиалъя'),
    outbound(`Урьдчилгаа 10,000₮-20,000₮ хооронд, үсчнээс хамаарна. ${LINK}`),
  ], SPEC);
  assert.equal(r.outcome === 'delivered' && r.turns, 1);
});

// ---------------------------------------------------------------------------
// The three outcomes are three different facts
// ---------------------------------------------------------------------------

test('DONE-TEST: A BOT THAT NEVER SENDS THE LINK IS not_delivered, NOT A LOW SCORE', () => {
  // The way this file would lie. `turns` is null rather than a large number, so nothing
  // downstream can average the worst possible behaviour into a good headline.
  const r = turnsToBookingLink([
    inbound('Цаг авмаар байна'),
    outbound('Ямар үйлчилгээ вэ?'),
    inbound('Тайралт'),
    outbound('Утсаар холбогдоно уу.'),
  ], SPEC);
  assert.deepEqual(r, { outcome: 'not_delivered', turns: null, intentStem: 'цаг авм' });
});

test('a conversation where nobody asked to book is no_intent, not a failure', () => {
  const r = turnsToBookingLink([
    inbound('Хэдэн цагт ажилладаг вэ?'),
    outbound('Даваа-Бямба: 10:00-20:00.'),
  ], SPEC);
  assert.deepEqual(r, { outcome: 'no_intent', turns: null, intentStem: null });
});

test('AN OPENING-HOURS QUESTION IS NOT A BOOKING REQUEST', () => {
  // Ш3's own closing line says «Цагийн хуваарь хэд вэ?» is not a booking request. A three
  // character stem «цаг» would fire on it; the stems here are longer, and MIN_STEM_CHARS
  // is what stops a future one being shorter.
  for (const q of ['Цагийн хуваарь хэд вэ?', 'Хэдэн цагт нээдэг вэ?', 'Ням гарагт цагаараа ажиллана уу?']) {
    assert.equal(turnsToBookingLink([inbound(q)], SPEC).outcome, 'no_intent', q);
  }
});

// ---------------------------------------------------------------------------
// Counting rules
// ---------------------------------------------------------------------------

test('THE COUNT STARTS AT THE ASKING, so a link sent earlier does not pay for it', () => {
  // The bot volunteers the link, the customer later asks to book, and the bot then takes
  // three replies to send it again. That is three, not zero.
  const r = turnsToBookingLink([
    inbound('Сайн байна уу'),
    outbound(LINK),
    inbound('Цаг захиалъя'),
    outbound('Аль үсчин бэ?'),
    inbound('Уянга'),
    outbound('Уянга 1-р зэрэг. Урьдчилгаа 10,000₮.'),
    inbound('За'),
    outbound(LINK),
  ], SPEC);
  assert.equal(r.outcome === 'delivered' && r.turns, 3);
});

test('the customer\'s own turns are not counted — only replies are', () => {
  const r = turnsToBookingLink([
    inbound('Бичүүлье'),
    inbound('Маргааш'),
    inbound('Өглөө'),
    outbound(LINK),
  ], SPEC);
  assert.equal(r.outcome === 'delivered' && r.turns, 1);
});

test('a trailing slash and letter case are not differences', () => {
  const noSlash = 'https://www.matrixecosalon.org';
  for (const written of [noSlash, `${noSlash}/`, noSlash.toUpperCase()]) {
    const r = turnsToBookingLink([inbound('Цаг авмаар байна'), outbound(`Энд: ${written}`)], SPEC);
    assert.equal(r.outcome, 'delivered', written);
  }
});

// ---------------------------------------------------------------------------
// A misconfigured metric refuses rather than reporting a number
// ---------------------------------------------------------------------------

test('DONE-TEST: an empty bookingUrl THROWS, because it would score every bot 1', () => {
  // An empty needle is in every reply. Silently, the metric would report that a bot which
  // said nothing useful delivered the link immediately, every time.
  assert.throws(() => turnsToBookingLink([inbound('Цаг авмаар байна'), outbound('юу ч биш')],
    { intentStems: STEMS, bookingUrl: '' }), /bookingUrl is empty/);
});

test('a stem shorter than MIN_STEM_CHARS throws rather than being skipped', () => {
  assert.ok(MIN_STEM_CHARS > 3, 'the floor is what makes «цаг» refusable');
  assert.throws(
    () => turnsToBookingLink([inbound('Цаг авмаар байна')], { intentStems: ['цаг'], bookingUrl: URL }),
    /shorter than MIN_STEM_CHARS/,
  );
});

test('no stems at all throws, rather than reporting every conversation as no_intent', () => {
  assert.throws(() => turnsToBookingLink([inbound('Цаг авмаар байна')],
    { intentStems: [], bookingUrl: URL }), /no intent stems/);
});

// ---------------------------------------------------------------------------
// The summary keeps the failure modes out of the average
// ---------------------------------------------------------------------------

const delivered = (turns: number): TurnsResult => ({ outcome: 'delivered', turns, intentStem: 'цаг авм' });
const missed: TurnsResult = { outcome: 'not_delivered', turns: null, intentStem: 'цаг авм' };
const none: TurnsResult = { outcome: 'no_intent', turns: null, intentStem: null };

test('DONE-TEST: NOT-DELIVERED IS COUNTED BESIDE THE MEDIAN, NEVER INSIDE IT', () => {
  // Four one-reply bookings and four abandoned ones. A metric that folded the abandoned
  // into the average would report something between; this reports a median of 1 and, right
  // next to it, that half the customers who asked never got the link.
  const s = summarise([delivered(1), delivered(1), delivered(1), delivered(1), missed, missed, missed, missed]);
  assert.equal(s.median, 1);
  assert.equal(s.notDelivered, 4);
  assert.equal(s.delivered, 4);
  assert.equal(s.withIntent, 8, 'the denominator is everyone who asked');
});

test('no_intent conversations stay out of the denominator', () => {
  const s = summarise([delivered(2), none, none, none]);
  assert.equal(s.withIntent, 1);
  assert.equal(s.conversations, 4);
});

test('the median is a median, and the worst case is carried separately', () => {
  const s = summarise([delivered(1), delivered(1), delivered(4), delivered(9)]);
  assert.equal(s.median, 2.5);
  assert.equal(s.worst, 9, 'the number a salon reacts to');
  assert.deepEqual(s.counts, [1, 1, 4, 9]);
});

test('an empty run reports nulls rather than zero', () => {
  // Zero turns would read as "instant", which is the opposite of "we measured nothing".
  const s = summarise([]);
  assert.equal(s.median, null);
  assert.equal(s.worst, null);
  assert.equal(s.withIntent, 0);
});
