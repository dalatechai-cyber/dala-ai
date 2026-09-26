import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertWebHandoff, handoffNotice, MAX_ALERTS_PER_CONVERSATION, WEB_HANDOFF_FLAG } from './handoffAlert.ts';
import type { Playbook } from '../sales/nextStep.ts';

const NOW = new Date('2026-09-26T16:00:00.000Z');
const PLAYBOOK = { mode: 'live', leadRoute: 'founder_telegram', steps: [], pairings: [] } as unknown as Playbook;

/** quality_flags only: `prior` rows already there, every insert recorded in order. */
function db(over: { prior?: number; readError?: string; insertError?: string } = {}) {
  const trace: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const from = (table: string) => {
    assert.equal(table, 'quality_flags');
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain['limit'] = async () => {
      trace.push('read');
      return over.readError !== undefined
        ? { data: null, error: { message: over.readError } }
        : { data: Array.from({ length: over.prior ?? 0 }, () => ({ flag: WEB_HANDOFF_FLAG })), error: null };
    };
    chain['insert'] = async (row: Record<string, unknown>) => {
      trace.push('insert'); inserts.push(row);
      return { error: over.insertError === undefined ? null : { message: over.insertError } };
    };
    return chain;
  };
  return { trace, inserts, client: { from } as never };
}
const input = (over: Record<string, unknown> = {}) => ({
  tenantId: 't0', conversationId: 'conv-9', messageId: 'm-1', question: 'Excel холбогдох уу?', playbook: PLAYBOOK, now: NOW, ...over,
});

test('DONE-TEST: the founder gets the visitor\'s question; the row is written first and carries no words', async () => {
  const d = db();
  const sent: string[] = [];
  const r = await alertWebHandoff(d.client, input(), async (t) => { d.trace.push('notify'); sent.push(t); return { ok: true }; });
  assert.deepEqual(r, { outcome: 'sent' });
  assert.deepEqual(d.trace, ['read', 'insert', 'notify']);
  assert.match(sent[0] ?? '', /«Excel холбогдох уу\?»/u);
  assert.match(sent[0] ?? '', /conv-9/u);
  assert.equal(d.inserts[0]?.['flag'], WEB_HANDOFF_FLAG);
  assert.ok(!JSON.stringify(d.inserts[0]).includes('Excel'), 'quality_flags outlives the purge: no customer text');
});

test('only where the tenant\'s leads go to the founder\'s chat: no playbook or another route sends nothing', async () => {
  for (const playbook of [null, { ...PLAYBOOK, leadRoute: 'none' }]) {
    const d = db();
    let sent = 0;
    const r = await alertWebHandoff(d.client, input({ playbook }), async () => { sent += 1; return { ok: true }; });
    assert.deepEqual(r, { outcome: 'off' });
    assert.equal(sent, 0);
    assert.deepEqual(d.trace, []);
  }
});

test('at most three alerts per conversation', async () => {
  const d = db({ prior: MAX_ALERTS_PER_CONVERSATION });
  let sent = 0;
  const r = await alertWebHandoff(d.client, input(), async () => { sent += 1; return { ok: true }; });
  assert.deepEqual(r, { outcome: 'capped' });
  assert.equal(sent, 0);
  assert.deepEqual(d.trace, ['read']);
});

test('every failure is a value, never a throw — and an unreadable count sends nothing', async () => {
  let sent = 0;
  const notify = async () => { sent += 1; return { ok: true }; };
  assert.equal((await alertWebHandoff(db({ readError: 'x' }).client, input(), notify)).outcome, 'unusable');
  assert.equal((await alertWebHandoff(db({ insertError: 'x' }).client, input(), notify)).outcome, 'unusable');
  assert.equal(sent, 0);
  assert.equal((await alertWebHandoff(db().client, input(), async () => ({ ok: false, detail: '429' }))).outcome, 'unusable');
  assert.equal((await alertWebHandoff(db().client, input(), async () => { throw new Error('down'); })).outcome, 'unusable');
});

test('a long question is cut by code points, whole emoji and Cyrillic intact', () => {
  const long = 'Ө'.repeat(400);
  const n = handoffNotice(long, 'c');
  const inside = n.slice(n.indexOf('«') + 1, n.indexOf('»'));
  assert.equal([...inside].length, 300);
  assert.ok(inside.endsWith('…'));
});
