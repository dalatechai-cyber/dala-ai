import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyThreadControl } from './record.ts';

type Row = { thread_control: string; thread_control_at: string | null };
type Update = Record<string, unknown>;

/**
 * The narrowest fake that can tell a refresh from a change: it records what was UPDATED,
 * which is the whole question here. A fake returning only ok/not-ok would pass whether the
 * code wrote `thread_control_at` or wrote nothing.
 */
function fakeDb(row: Row | null, opts: { updateFails?: boolean } = {}) {
  const updates: Update[] = [];
  const db = {
    from() {
      const chain = {
        select: () => chain,
        update: (u: Update) => { updates.push(u); return chain; },
        eq: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
        then: (res: (v: { error: { message: string } | null }) => unknown) =>
          res({ error: opts.updateFails === true ? { message: 'write refused' } : null }),
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const AT = new Date('2026-09-19T12:00:00Z');
const base = { tenantId: 'T', conversationId: 'C', at: AT };

test('control actually changing hands writes all three columns and reports a change', async () => {
  const { db, updates } = fakeDb({ thread_control: 'unknown', thread_control_at: null });
  const r = await applyThreadControl(db, { ...base, control: 'human', source: 'echo' });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0] ?? {}).sort(),
    ['thread_control', 'thread_control_at', 'thread_control_source']);
});

test('A STAFF REPLY RESETS THE CLOCK: same control, echo, human -> refresh only', async () => {
  const { db, updates } = fakeDb({ thread_control: 'human', thread_control_at: '2026-09-19T11:00:00Z' });
  const r = await applyThreadControl(db, { ...base, control: 'human', source: 'echo' });
  assert.deepEqual(r, { ok: true, changed: false, refreshed: true });
  assert.equal(updates.length, 1);
  // ONLY the timestamp. Rewriting thread_control_source on a refresh would relabel how
  // control was learned, and it was not learned again.
  assert.deepEqual(updates[0], { thread_control_at: AT.toISOString() });
});

test('changed stays FALSE on a refresh — recordHandover counts changed as takeovers', async () => {
  const { db } = fakeDb({ thread_control: 'human', thread_control_at: '2026-09-19T11:00:00Z' });
  const r = await applyThreadControl(db, { ...base, control: 'human', source: 'echo' });
  assert.equal(r.ok === true && r.changed, false);
});

test('a handover event re-asserting human is Meta repeating itself, not a new turn', async () => {
  const { db, updates } = fakeDb({ thread_control: 'human', thread_control_at: '2026-09-19T11:00:00Z' });
  const r = await applyThreadControl(db, { ...base, control: 'human', source: 'handover' });
  assert.deepEqual(r, { ok: true, changed: false });
  assert.equal(updates.length, 0, 'a redelivered webhook must not hold a thread open for ever');
});

test('only human refreshes: an echo re-asserting bot writes nothing', async () => {
  const { db, updates } = fakeDb({ thread_control: 'bot', thread_control_at: '2026-09-19T11:00:00Z' });
  const r = await applyThreadControl(db, { ...base, control: 'bot', source: 'echo' });
  assert.deepEqual(r, { ok: true, changed: false });
  assert.equal(updates.length, 0);
});

test('a refresh that fails to write is reported, never swallowed as "no change"', async () => {
  const { db } = fakeDb({ thread_control: 'human', thread_control_at: '2026-09-19T11:00:00Z' }, { updateFails: true });
  const r = await applyThreadControl(db, { ...base, control: 'human', source: 'echo' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.detail : '', 'write refused');
});

test('an unreadable conversation refuses before deciding anything', async () => {
  const { db, updates } = fakeDb(null);
  const r = await applyThreadControl(db, { ...base, control: 'human', source: 'echo' });
  assert.equal(r.ok, false);
  assert.equal(updates.length, 0);
});
