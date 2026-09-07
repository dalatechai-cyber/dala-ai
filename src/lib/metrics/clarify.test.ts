import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findClarifications, type ClarifyVerdict } from './clarify.ts';
import type { ConversationTurn } from './turnsToIntent.ts';

const URL = 'https://www.matrixecosalon.org/';
const LINK = `Та манай вэбсайтаар (${URL}) онлайнаар цаг захиалах боломжтой.`;

/** Tenant data, supplied as a caller would supply it — never imported from src. */
const STEMS = ['цаг авм', 'цаг захиал', 'бичүүл'];
const INTENT = { intentStems: STEMS, bookingUrl: URL };
const CONFIGURED = ['Та цаг захиалах гэж байна уу, эсвэл ажиллах цагийг асууж байна уу?'];

const inbound = (body: string): ConversationTurn => ({ direction: 'inbound', body });
const outbound = (body: string): ConversationTurn => ({ direction: 'outbound', body });

// ---------------------------------------------------------------------------
// The founder's «цаг», caught with no model at all
// ---------------------------------------------------------------------------

test('DONE-TEST: «цаг» IS CAUGHT STRUCTURALLY — no classifier, no configured row', () => {
  // Measured on Matrix 2026-09-07: a customer writes «цаг», which is genuinely ambiguous
  // between opening hours and booking; the bot asks which. Correct behaviour, and a turn
  // spent every time. Nothing in the system could see it before this.
  const found = findClarifications([
    inbound('цаг'),
    outbound('Та цаг захиалах гэж байна уу, эсвэл ажиллах цагийг асууж байна уу?'),
    inbound('цаг захиалъя'),
    outbound(LINK),
  ], { intent: INTENT });

  assert.equal(found.length, 1);
  assert.equal(found[0]!.via, 'structural');
  assert.equal(found[0]!.replyIndex, 1);
  assert.equal(found[0]!.triggerText, 'цаг', 'the ambiguous term is what a cluster is built from');
});

test('a reply that leads with the link is not a clarification', () => {
  const found = findClarifications([inbound('цаг авмаар байна'), outbound(LINK)], { intent: INTENT });
  assert.deepEqual(found, []);
});

test('the ancestor\'s four-turn booking yields three clarifications', () => {
  // D-042's transcript. Three replies asked something before the fourth delivered the link.
  const found = findClarifications([
    inbound('Цаг авмаар байна'),
    outbound('Эрэгтэй эсвэл эмэгтэй тайралт уу?'),
    inbound('Эмэгтэй'),
    outbound('Мастер эсвэл 1-р зэргийн үсчин үү?'),
    inbound('Мастер'),
    outbound('Мастер үсчин 66,000₮. Урьдчилгаа 20,000₮.'),
    inbound('За'),
    outbound(LINK),
  ], { intent: INTENT });
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((f) => f.via), ['structural', 'structural', 'structural']);
});

test('THE COUNT STARTS AT THE ASKING — a link volunteered earlier is not in scope', () => {
  // Kept in step with turnsToIntent.ts on purpose: if the two disagree about where
  // counting starts, the report and the metric it cites disagree too.
  const found = findClarifications([
    inbound('Сайн байна уу'),
    outbound(LINK),                       // volunteered before any intent — not a clarification
    inbound('Цаг захиалъя'),
    outbound('Аль үсчин бэ?'),
    inbound('Уянга'),
    outbound(LINK),
  ], { intent: INTENT });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.replyIndex, 3, 'only the reply between the asking and the link');
});

// ---------------------------------------------------------------------------
// The three sources, and their precedence
// ---------------------------------------------------------------------------

test('a configured clarify question is recognised with no model and no intent spec', () => {
  const found = findClarifications([
    inbound('цаг'),
    outbound('Та цаг захиалах гэж байна уу, эсвэл ажиллах цагийг асууж байна уу?'),
  ], { configuredQuestions: CONFIGURED });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.via, 'configured');
});

test('configured beats the classifier, which beats structural', () => {
  const never = () => 'answering' as ClarifyVerdict;
  const found = findClarifications([
    inbound('цаг'),
    outbound('Та цаг захиалах гэж байна уу, эсвэл ажиллах цагийг асууж байна уу?'),
    inbound('цаг захиалъя'),
    outbound(LINK),
  ], { configuredQuestions: CONFIGURED, classify: never, intent: INTENT });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.via, 'configured', 'certain evidence outranks a judgement');
});

test('a classifier saying `answering` OVERRIDES the structural guess', () => {
  // The structural source is an inference: a reply before the link did not deliver it, but
  // it may have answered something else entirely. A classifier that has read the text
  // knows better, and must be allowed to say so — otherwise adding the model makes the
  // number worse.
  const found = findClarifications([
    inbound('цаг'),
    outbound('Ажиллах цаг: Даваа-Бямба 10:00-20:00.'),
    inbound('цаг захиалъя'),
    outbound(LINK),
  ], { classify: () => 'answering', intent: INTENT });
  assert.deepEqual(found, [], 'a real answer to a different question is not a clarification');
});

test('DONE-TEST: `unknown` IS NOT A CLARIFICATION', () => {
  // The way this file would lie. If an undecided classifier counted as a clarification,
  // the report would measure the classifier's confidence rather than what customers hit —
  // and it would get WORSE as the classifier got less certain.
  const found = findClarifications([
    inbound('цаг'),
    outbound('Тодруулж хэлнэ үү.'),
  ], { classify: () => 'unknown', configuredQuestions: [] });
  assert.deepEqual(found, []);
});

test('`unknown` falls through to structural rather than discarding it', () => {
  // The classifier declining to judge should not lose evidence we already had.
  const found = findClarifications([
    inbound('цаг'),
    outbound('Тодруулна уу?'),
    inbound('цаг захиалъя'),
    outbound(LINK),
  ], { classify: () => 'unknown', intent: INTENT });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.via, 'structural');
});

// ---------------------------------------------------------------------------
// It never calls anything, and it never proposes anything
// ---------------------------------------------------------------------------

test('with no spec at all it finds nothing rather than guessing', () => {
  assert.deepEqual(findClarifications([inbound('цаг'), outbound('Аль нь вэ?')]), []);
});

test('a reply with no customer turn before it is not a clarification', () => {
  // A proactive message answers nobody, so there is nothing it could have clarified.
  assert.deepEqual(
    findClarifications([outbound('Сайн байна уу!'), inbound('за')], { classify: () => 'clarifying' }),
    [],
  );
});

test('the finding carries the customer term and nothing it invented', () => {
  const found = findClarifications([
    inbound('өнгө'),
    outbound('Ямар өнгө вэ?'),
  ], { classify: () => 'clarifying' });
  assert.deepEqual(Object.keys(found[0]!).sort(), ['replyIndex', 'triggerText', 'via']);
  assert.equal(found[0]!.triggerText, 'өнгө', 'the customer\'s word, not a proposed question');
});

test('an unanswered conversation produces no structural findings', () => {
  // not_delivered carries no turn count, so there is no "before the link" to point at.
  const found = findClarifications([
    inbound('цаг авмаар байна'),
    outbound('Утсаар холбогдоно уу.'),
  ], { intent: INTENT });
  assert.deepEqual(found, [], 'a gap, but not a CLARIFICATION gap — the flag layer sees it');
});
