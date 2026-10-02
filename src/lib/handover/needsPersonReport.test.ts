import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { needsPersonLine, parseNeedsPersonKey, readNeedsPersonLoop } from './needsPersonReport.ts';

/** A read-only stand-in: each table answers its rows, or an error. Filters are recorded, not applied. */
function fakeDb(tables: Record<string, unknown[] | { error: string }>): SupabaseClient {
  return {
    from(table: string) {
      const answer = tables[table] ?? [];
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'in']) b[m] = () => b;
      b['then'] = (resolve: (v: unknown) => void) => resolve(Array.isArray(answer)
        ? { data: answer, error: null } : { data: null, error: { message: answer.error } });
      return b;
    },
  } as unknown as SupabaseClient;
}

const T = '00000000-0000-0000-0000-00000000000a';
const alert = (conv: string, reason: string, at: string) => ({ tenant_id: T, dedup_key: `needs_person:${conv}:${reason}:2026-10-01`, at });

test('the key is read back exactly; anything else is not a needs-person page', () => {
  assert.deepEqual(parseNeedsPersonKey('needs_person:c1:handoff:2026-10-01'), { conversationId: 'c1', reason: 'handoff' });
  assert.equal(parseNeedsPersonKey('media:c1:2026-10-01'), null);
  assert.equal(parseNeedsPersonKey('needs_person::handoff:2026-10-01'), null);
});

test('chats are counted once each; a staff reply AFTER the first page answers it; take-backs are not counted', async () => {
  const db = fakeDb({
    alerts: [
      alert('c1', 'handoff', '2026-10-01T02:00:00Z'),
      alert('c1', 'complaint', '2026-10-01T03:00:00Z'), // same chat, second reason: one chat
      alert('c2', 'voice', '2026-10-01T04:00:00Z'),
      alert('c3', 'handoff', '2026-10-01T05:00:00Z'),
      alert('c4', 'reclaim_sent', '2026-10-01T06:00:00Z'), // the bot taking a chat back: not a waiting customer
    ],
    conversations: [
      { id: 'c1', channel_id: 'ch', thread_control: 'human', thread_control_source: 'echo', thread_control_at: '2026-10-01T02:30:00Z' }, // answered
      { id: 'c2', channel_id: 'ch', thread_control: 'human', thread_control_source: 'echo', thread_control_at: '2026-10-01T01:00:00Z' }, // before the page
      { id: 'c3', channel_id: 'ch', thread_control: 'human', thread_control_source: 'handover', thread_control_at: '2026-10-01T05:01:00Z' }, // Meta, not staff
    ],
    tenant_channels: [{ id: 'ch', delivery_mode: 'live' }],
    tenants: [{ id: T, display_name: 'Tara Salon — Яармаг' }],
  });
  const s = await readNeedsPersonLoop(db, { since: '2026-09-30T16:00:00Z', until: '2026-10-01T16:00:00Z' });
  assert.deepEqual(s, { ok: true, capped: false, byTenant: [{ tenant: 'Tara Salon — Яармаг', chats: 3, answered: 1 }] });
  assert.equal(needsPersonLine(s), 'Chats that needed a person (yesterday): Tara Salon — Яармаг 3, staff replied to 1 by report time');
});

test('an unreadable table is UNREADABLE, never zero; a clean day says none', async () => {
  const bad = await readNeedsPersonLoop(fakeDb({ alerts: { error: 'boom' } }), { since: 'a', until: 'b' });
  assert.equal(bad.ok, false);
  assert.match(needsPersonLine(bad), /UNREADABLE — alerts unreadable: boom/);
  const convBad = await readNeedsPersonLoop(fakeDb({ alerts: [alert('c1', 'handoff', '2026-10-01T02:00:00Z')], conversations: { error: 'gone' } }), { since: 'a', until: 'b' });
  assert.match(needsPersonLine(convBad), /UNREADABLE — conversations unreadable: gone/);
  const clean = await readNeedsPersonLoop(fakeDb({ alerts: [] }), { since: 'a', until: 'b' });
  assert.equal(needsPersonLine(clean), 'Chats that needed a person (yesterday): none');
});

test('a tenant name that cannot be read is printed as its id, never dropped', async () => {
  const s = await readNeedsPersonLoop(fakeDb({
    alerts: [alert('c1', 'voice', '2026-10-01T02:00:00Z')], conversations: [{ id: 'c1', channel_id: 'ch' }],
    tenant_channels: [{ id: 'ch', delivery_mode: 'live' }], tenants: { error: 'x' },
  }), { since: 'a', until: 'b' });
  assert.match(needsPersonLine(s), new RegExp(`${T} 1, staff replied to 0 by report time`, 'u'));
});

test('a chat on a channel that is not live is not counted, and the line says so', async () => {
  const s = await readNeedsPersonLoop(fakeDb({
    alerts: [alert('c1', 'handoff', '2026-10-01T02:00:00Z')], conversations: [{ id: 'c1', channel_id: 'sh' }],
    tenant_channels: [{ id: 'sh', delivery_mode: 'shadow' }],
  }), { since: 'a', until: 'b' });
  assert.equal(needsPersonLine(s), 'Chats that needed a person (yesterday): 00000000-0000-0000-0000-00000000000a 0, staff replied to 0 by report time, 1 not counted (channel not live)',
    'left out, but never silently: «none» is kept for a day with no page at all');
});
