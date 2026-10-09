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
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 60_000))), 'answering', 'a minute later: an answer (no 10-minute burst since 2026-10-09)');
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
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 60_000), { canned, priorTurns })), 'answering');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() + 20 * 60_000), { canned, priorTurns })), 'answering');
  assert.equal(await photoQuestionState(s.db, input(new Date(QUESTION_AT.getTime() - 2000), { priorTurns })), null,
    'the reel line is no question for a tenant with only the photo row');
});

test('DONE-TEST (Парк Од, 2026-10-09 02:18): ONE TEXT CAN CROSS THE QUESTION, NEVER TWO', async () => {
  // The question's row at 02:18:33.8; «hedve» at 02:18:36.9 crossed it; «hedve» at 02:18:54.9
  // follows a customer turn already after the question: it is an answer.
  const at = new Date('2026-10-09T02:18:33.796Z');
  const s = db(row(Q, at));
  const turns = [{ role: 'user' as const, content: 'tara perm urt' }, { role: 'assistant' as const, content: Q }];
  const first = { eventAt: new Date('2026-10-09T02:18:36.876Z'), now: new Date('2026-10-09T02:18:37.5Z'), priorTurns: turns };
  assert.equal(await photoQuestionState(s.db, input(first.eventAt, first)), 'crossed');
  const second = { eventAt: new Date('2026-10-09T02:18:54.888Z'), now: new Date('2026-10-09T02:18:55.5Z'),
    priorTurns: [...turns, { role: 'user' as const, content: 'hedve' }] };
  assert.equal(await photoQuestionState(s.db, input(second.eventAt, second)), 'answering');
  // Without the first «hedve», the one at 02:18:54.9 alone (21 s after the question) is an answer
  // too: a crossing takes seconds, and a text held as crossed gets nothing more.
  const alone = { eventAt: second.eventAt, now: second.now, priorTurns: turns };
  assert.equal(await photoQuestionState(s.db, input(alone.eventAt, alone)), 'answering');
});

test('the latest media question in the hour: whether it is the last reply, and whether the customer wrote since', async () => {
  const { readRecentMediaQuestion } = await import('./photoQuestion.ts');
  const now = new Date('2026-10-09T02:18:33Z');
  const seq = (replies: { data: unknown; error: unknown }[]) => {
    let i = 0;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'gt', 'order', 'limit']) chain[m] = () => chain;
    chain['then'] = (res: (v: unknown) => unknown) => res(replies[Math.min(i++, replies.length - 1)]);
    return { from: () => chain } as never;
  };
  const replies = { data: [{ body: 'Tara perm (урт): 290,000₮', created_at: '2026-10-09T02:18:23.757Z' }, { body: Q, created_at: '2026-10-09T02:18:09.506Z' }], error: null };
  const r = await readRecentMediaQuestion(seq([replies, { data: [{ id: 'm' }], error: null }]), { tenantId: 't', conversationId: 'c', questions: [Q], now });
  assert.deepEqual(r, { at: new Date('2026-10-09T02:18:09.506Z'), isLastReply: false, customerWroteSince: true, dedupKey: null });
  assert.equal(await readRecentMediaQuestion(seq([{ data: [{ body: 'x', created_at: '2026-10-09T02:18:00Z' }], error: null }]), { tenantId: 't', conversationId: 'c', questions: [Q], now }), null);
  assert.equal(await readRecentMediaQuestion(seq([{ data: null, error: { message: 'reset' } }]), { tenantId: 't', conversationId: 'c', questions: [Q], now }), 'unreadable');
  const unreadableSince = await readRecentMediaQuestion(seq([replies, { data: null, error: { message: 'reset' } }]), { tenantId: 't', conversationId: 'c', questions: [Q], now });
  assert.equal(unreadableSince !== null && unreadableSince !== 'unreadable' && unreadableSince.customerWroteSince, true, 'unreadable reads as written: a person, never silence');
});
