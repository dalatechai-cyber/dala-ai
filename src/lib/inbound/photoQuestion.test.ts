// D-176: the crossing read (`photoQuestion.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoQuestionState, readLastReply } from './photoQuestion.ts';

const Q = 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
const CANNED = [{ kind: 'photo_price_question', body: Q, reviewedAt: '2026-10-04' }];
const QUESTION_AT = new Date('2026-10-04T05:00:00Z');

function db(reply: { data: unknown; error: unknown }) {
  let reads = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = () => chain;
  chain['then'] = (res: (v: unknown) => unknown) => { reads += 1; return res(reply); };
  return { db: { from: () => chain } as never, reads: () => reads };
}
const row = (body: string, at: Date) => ({ data: [{ body, created_at: at.toISOString() }], error: null });
const input = (eventAt: Date, over: Record<string, unknown> = {}) => ({
  tenantId: 't', conversationId: 'c', canned: CANNED, eventAt, now: new Date(eventAt.getTime() + 1000),
  priorTurns: [{ role: 'user' as const, content: 'x' }, { role: 'assistant' as const, content: Q }], ...over,
});

test('DONE-TEST: A TEXT WRITTEN SECONDS AFTER THE PHOTO CROSSED THE QUESTION', async () => {
  const s = db(row(Q, QUESTION_AT));
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() - 2000))), 'crossed');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 5000))), 'crossed', 'typed while it arrived');
});

test('a text written well after the question is an answer to it; an hour later the question is stale', async () => {
  const s = db(row(Q, QUESTION_AT));
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 60_000))), 'burst', 'inside the 10-minute burst window');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 11 * 60_000))), 'answering');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 61 * 60_000))), 'stale');
});

test('no read at all unless the history ends on the reviewed question', async () => {
  const s = db(row(Q, QUESTION_AT));
  const t = new Date(QUESTION_AT.getTime() - 1000);
  assert.equal(await photoQuestionState(s.db, input(t, { priorTurns: [{ role: 'assistant', content: 'Сайн байна уу!' }] })), null);
  assert.equal(await photoQuestionState(s.db, input(t, { canned: [{ ...CANNED[0], reviewedAt: null }] })), null);
  assert.equal(await photoQuestionState(s.db, input(t, { canned: [] })), null);
  assert.equal(s.reads(), 0);
});

test('a later reply that is not the question means nothing crossed; a failed read says so', async () => {
  const t = new Date(QUESTION_AT.getTime() - 1000);
  assert.equal(await photoQuestionState(db(row('Үнэ', QUESTION_AT)).db, input(t)), null);
  assert.equal(await photoQuestionState(db({ data: null, error: { message: 'reset' } }).db, input(t)), 'unreadable');
  assert.equal(await readLastReply(db({ data: [], error: null }).db, 't', 'c'), null);
  assert.equal(await readLastReply(db({ data: [{ body: Q, created_at: 'nope' }], error: null }).db, 't', 'c'), 'unreadable');
});

test('D-176 reel: a text crossing the reel question is read the same way', async () => {
  const R = 'Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
  const canned = [{ kind: 'reel_price_question', body: R, reviewedAt: '2026-10-04' }];
  const priorTurns = [{ role: 'user' as const, content: 'x' }, { role: 'assistant' as const, content: R }];
  const s = db(row(R, QUESTION_AT));
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() - 2000), { canned, priorTurns })), 'crossed');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 60_000), { canned, priorTurns })), 'burst');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 20 * 60_000), { canned, priorTurns })), 'answering');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() - 2000), { priorTurns })), null,
    'the reel line is no question for a tenant with only the photo row');
});
