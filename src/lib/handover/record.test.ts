import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyThreadControl, recordHandover } from './record.ts';

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

// ---------------------------------------------------------------------------
// Testers on a shadow channel (D-141), and echoes with no app id
// ---------------------------------------------------------------------------

/** Per-table answers; records every update. `outbound_messages` answers the mid AND the text read. */
function tablesDb(sends: { body: string }[]) {
  const updates: { table: string; u: Update }[] = [];
  const answer: Record<string, unknown> = {
    contacts: { id: 'contact-1' },
    conversations: { id: 'conv-1', thread_control: 'unknown', thread_control_at: null },
    outbound_messages: null,
  };
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) chain[m] = () => chain;
      chain['update'] = (u: Update) => { updates.push({ table, u }); return chain; };
      chain['maybeSingle'] = async () => ({ data: answer[table] ?? null, error: null });
      chain['then'] = (res: (v: unknown) => unknown) =>
        res({ data: table === 'outbound_messages' ? sends : null, error: null });
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const INBOX = '263902037430900';
const echo = (psid: string, appId: string | null, text = 'Сайн байна уу, би хариулъя') =>
  ({ mid: `m_${psid}`, psid, appId, text });

test('DONE-TEST: on a SHADOW channel only a listed tester\'s inbox reply moves control', async () => {
  const listed = tablesDb([]);
  const a = await recordHandover(listed.db, {
    tenantId: 'T', channelId: 'C', ourAppId: '1562862634970492', entry: {},
    echoes: [echo('tester', INBOX)], deliveryMode: 'shadow', liveFor: new Set(['tester']), now: AT,
  });
  assert.equal(a.echoTakeovers, 1);
  assert.ok(listed.updates.some((x) => x.u['thread_control'] === 'human'));

  const other = tablesDb([]);
  const b = await recordHandover(other.db, {
    tenantId: 'T', channelId: 'C', ourAppId: '1562862634970492', entry: {},
    echoes: [echo('stranger', INBOX)], deliveryMode: 'shadow', liveFor: new Set(['tester']), now: AT,
  });
  assert.equal(b.echoTakeovers, 0);
  assert.equal(other.updates.length, 0);
});

test('DONE-TEST: AN ECHO WITH NO APP ID THAT IS OUR OWN REPLY NEVER SILENCES THE BOT', async () => {
  const reply = 'Дали бол AI хүлээн авагч. Таны асуултад 24/7 хариулна.';
  const ours = tablesDb([{ body: reply }]);
  const r = await recordHandover(ours.db, {
    tenantId: 'T', channelId: 'C', ourAppId: '1562862634970492', entry: {},
    echoes: [echo('psid', null, reply)], deliveryMode: 'live', now: AT,
  });
  assert.equal(r.echoTakeovers, 0);
  assert.equal(ours.updates.length, 0);

  // A person typing, with no app id either, still takes the thread.
  const person = tablesDb([{ body: reply }]);
  const p = await recordHandover(person.db, {
    tenantId: 'T', channelId: 'C', ourAppId: '1562862634970492', entry: {},
    echoes: [echo('psid', null, 'Би өөрөө хариулъя')], deliveryMode: 'live', now: AT,
  });
  assert.equal(p.echoTakeovers, 1);
});
