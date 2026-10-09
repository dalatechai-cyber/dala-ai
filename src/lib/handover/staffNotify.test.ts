import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { inboxLink, notifyBranchStaff, staffAlertText, STAFF_REPING_AFTER_MS, tellBranchStaff, STAFF_PING_UNDELIVERED_KIND } from './staffNotify.ts';
import type { AlertInput } from '../alerts/alert.ts';

type Row = Record<string, unknown>;

/**
 * A tiny in-memory PostgREST: `select … eq … gte … limit / maybeSingle` and `insert … select`.
 * `fail` makes one table answer an error, the way an unreadable table does.
 */
function fakeDb(tables: Record<string, Row[]>, fail: Set<string> = new Set()) {
  const inserted: Record<string, Row[]> = {};
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let insertRow: Row | null = null;
    let limit = Infinity;
    const result = () => {
      if (fail.has(table)) return { data: null, error: { message: `${table} unreadable` } };
      if (insertRow !== null) {
        const row = { id: `${table}-${(inserted[table] ?? []).length + 1}`, ...insertRow };
        (inserted[table] ??= []).push(row);
        (tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit), error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      limit: (n: number) => { limit = n; return q; },
      insert: (row: Row) => { insertRow = row; return q; },
      maybeSingle: async () => {
        const r = result();
        if (r.error) return r;
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
      },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, inserted };
}

const T = 'tenant-1';
const NOW = new Date('2026-10-09T06:32:00Z'); // 14:32 in Ulaanbaatar
const base = (): Record<string, Row[]> => ({
  handoff_targets: [{ tenant_id: T, kind: 'telegram', destination: '-1001234567890', verified_at: '2026-10-09T00:00:00Z' }],
  tenants: [{ id: T, display_name: 'Tara Salon — Яармаг' }],
  conversations: [{ tenant_id: T, id: 'conv-1', contact_id: 'ct-1', channel_id: 'ch-1' }],
  contacts: [{ tenant_id: T, id: 'ct-1', external_id: '10000000000000001' }],
  tenant_channels: [{ tenant_id: T, id: 'ch-1', provider: 'facebook_page', external_id: '1520409424715591' }],
  handoffs: [],
});

function recorder(ok = true) {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    send: async (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return ok ? { ok: true as const, messageId: '77' } : { ok: false as const, detail: 'telegram 403' };
    },
  };
}

test('off by default: no target row, or a row not verified, sends nothing and writes nothing', async () => {
  for (const targets of [[], [{ tenant_id: T, kind: 'telegram', destination: '-100123', verified_at: null }]]) {
    const { db, inserted } = fakeDb({ ...base(), handoff_targets: targets });
    const r = recorder();
    const out = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r);
    assert.deepEqual(out, { outcome: 'off' });
    assert.equal(r.sent.length, 0);
    assert.deepEqual(inserted, {});
  }
});

test('another branch\'s target is never used: the row is read by THIS tenant only', async () => {
  const { db } = fakeDb({ ...base(), handoff_targets: [{ tenant_id: 'other', kind: 'telegram', destination: '-100999', verified_at: 'x' }] });
  const r = recorder();
  assert.equal((await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r)).outcome, 'off');
  assert.equal(r.sent.length, 0);
});

test('on: one ping to the branch chat with its name, the UB time and a link to the chat, recorded', async () => {
  const { db, inserted } = fakeDb(base());
  const r = recorder();
  const out = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r);
  assert.equal(out.outcome, 'sent');
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.chatId, '-1001234567890');
  assert.equal(r.sent[0]!.text, '🔔 Tara Salon — Яармаг\n📷 2026-10-09 14:32\n'
    + 'https://business.facebook.com/latest/inbox/all?asset_id=1520409424715591&selected_item_id=10000000000000001&thread_type=FB_MESSAGE');
  assert.equal(inserted['handoffs']?.length, 1);
  assert.equal(inserted['handoffs']![0]!['reason'], 'media');
  assert.deepEqual(inserted['staff_notifications']?.map((n) => [n['delivered'], n['provider_message_id'], n['target_kind']]), [[true, '77', 'telegram']]);
});

test('the same chat inside the takeover window is pinged once, whatever the reason; after it, again', async () => {
  const tables = base();
  const { db } = fakeDb(tables);
  const r = recorder();
  await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r);
  const again = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'handoff', now: new Date(NOW.getTime() + 60_000) }, r);
  assert.equal(again.outcome, 'recent');
  assert.equal(r.sent.length, 1);
  const later = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: new Date(NOW.getTime() + STAFF_REPING_AFTER_MS + 1000) }, r);
  assert.equal(later.outcome, 'sent');
  assert.equal(r.sent.length, 2);
});

test('two alerts for one message at the same moment (media + needs-person) make one ping', async () => {
  const { db } = fakeDb(base());
  const r = recorder();
  const [a, b] = await Promise.all([
    notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r),
    notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'handoff', now: NOW }, r),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['recent', 'sent']);
  assert.equal(r.sent.length, 1);
});

test('unreadable details never silence the ping; an unreadable record pings anyway', async () => {
  const { db } = fakeDb(base(), new Set(['conversations', 'tenants', 'handoffs']));
  const r = recorder();
  const out = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'complaint', now: NOW }, r);
  assert.equal(out.outcome, 'sent');
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /^🔔 tenant-1\n⚠️ 2026-10-09 14:32\nMessenger \/ Page inbox$/);
  assert.equal(staffAlertText({ branch: 'B', reason: 'media', at: NOW, link: null, provider: 'instagram' }), '🔔 B\n📷 2026-10-09 14:32\nInstagram inbox');
});

test('an unreadable target table is a failure, said, and nothing is sent', async () => {
  const { db } = fakeDb(base(), new Set(['handoff_targets']));
  const r = recorder();
  assert.deepEqual(await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r),
    { outcome: 'failed', detail: 'handoff_targets unreadable' });
  assert.equal(r.sent.length, 0);
});

test('Telegram refusing is recorded undelivered and reported, never thrown', async () => {
  const { db, inserted } = fakeDb(base());
  const out = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'voice', now: NOW }, recorder(false));
  assert.deepEqual(out, { outcome: 'undelivered', detail: 'telegram 403' });
  assert.deepEqual(inserted['staff_notifications']?.map((n) => n['delivered']), [false]);
  const boom = await notifyBranchStaff(fakeDb(base()).db, { tenantId: T, conversationId: 'conv-2', reason: 'media', now: NOW },
    { send: async () => { throw new Error('network down'); } });
  assert.deepEqual(boom, { outcome: 'failed', detail: 'network down' });
});

test('a malformed chat id is not a target', async () => {
  const { db } = fakeDb({ ...base(), handoff_targets: [{ tenant_id: T, kind: 'telegram', destination: '@tara_staff', verified_at: 'x' }] });
  const r = recorder();
  assert.equal((await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, r)).outcome, 'off');
  assert.equal(r.sent.length, 0);
});

test('the link is built only for Messenger and only from numeric Meta ids', () => {
  assert.equal(inboxLink('instagram', '1520409424715591', '123456789'), null);
  assert.equal(inboxLink('web', '1', '2'), null);
  assert.equal(inboxLink('facebook_page', 'me', '10000000000000001'), null);
  assert.equal(inboxLink('facebook_page', '1520409424715591', '10000000000000001&x=1'), null);
  assert.match(inboxLink('facebook_page', '108583528037449', '10000000000000002')!, /asset_id=108583528037449&selected_item_id=10000000000000002/);
  assert.equal(staffAlertText({ branch: 'B', reason: 'reclaim_sent', at: new Date('2026-10-09T23:30:00Z'), link: null }), '🔔 B\n⏰ 2026-10-10 07:30\nMessenger / Page inbox');
});

test('a ping Telegram refused does not hold the next one back: the window counts delivered pings only', async () => {
  const { db } = fakeDb(base());
  const bad = recorder(false);
  assert.equal((await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, bad)).outcome, 'undelivered');
  const good = recorder();
  const next = await notifyBranchStaff(db, { tenantId: T, conversationId: 'conv-1', reason: 'complaint', now: new Date(NOW.getTime() + 5 * 60_000) }, good);
  assert.equal(next.outcome, 'sent');
  assert.equal(good.sent.length, 1);
});

test('tellBranchStaff tells the founder once a day per branch when a ping fails, never when off', async () => {
  const alerts: AlertInput[] = [];
  const alert = async (a: AlertInput) => { alerts.push(a); return { outcome: 'sent' as const }; };
  await tellBranchStaff(fakeDb({ ...base(), handoff_targets: [] }).db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, { ...recorder(), alert });
  assert.equal(alerts.length, 0);
  await tellBranchStaff(fakeDb(base()).db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW }, { ...recorder(false), alert });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, STAFF_PING_UNDELIVERED_KIND);
  assert.equal(alerts[0]!.dedupKey, `staff_ping:${T}:2026-10-09`);
  assert.equal(alerts[0]!.repeat, 'daily');
  assert.doesNotMatch(alerts[0]!.body, /10000000000000001/);
  // An alert that throws is swallowed: the worker's after() never rejects.
  const out = await tellBranchStaff(fakeDb(base()).db, { tenantId: T, conversationId: 'conv-1', reason: 'media', now: NOW },
    { ...recorder(false), alert: async () => { throw new Error('alerts down'); } });
  assert.equal(out.outcome, 'undelivered');
});
