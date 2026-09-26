import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSalesShadow, salesShadowEffect, type SalesShadowInput } from './shadow.ts';
import { LEAD_FLAG, NEXT_STEP_FLAG } from './nextStep.ts';

type Result = { data: unknown; error: { message: string } | null };

/**
 * A fake PostgREST client: each table answers one canned result, every call is recorded.
 * `maybeSingle` answers the first row (or null); a plain await answers the array.
 */
function fakeDb(tables: Record<string, Result>) {
  const ops: { table: string; op: string; args: unknown[] }[] = [];
  const db = {
    from(table: string) {
      const answer = (): Result => tables[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'limit']) {
        chain[op] = (...args: unknown[]) => { ops.push({ table, op, args }); return chain; };
      }
      chain['maybeSingle'] = async () => {
        const r = answer();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      };
      chain['then'] = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad);
      chain['insert'] = async (rows: unknown) => { ops.push({ table, op: 'insert', args: [rows] }); return { error: tables[`${table}:insert`]?.error ?? null }; };
      chain['update'] = () => { throw new Error(`update on ${table}`); };
      chain['delete'] = () => { throw new Error(`delete on ${table}`); };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, ops };
}

const STEPS = [
  { kind: 'booking', body: null, reviewed_at: null, link: 'https://booking.example.mn/', priority: 1, is_default: true, intent_matcher: null, enabled: true },
  { kind: 'callback', body: null, reviewed_at: null, link: null, priority: 2, is_default: false, intent_matcher: [{ mode: 'contains_stem', stems: ['дугаар'] }], enabled: true },
];

function tables(over: Record<string, Result> = {}): Record<string, Result> {
  return {
    sales_playbooks: { data: { mode: 'shadow', lead_route: 'tenant_telegram' }, error: null },
    sales_next_steps: { data: STEPS, error: null },
    service_pairings: { data: [], error: null },
    comment_rules: { data: [{ rule_key: 'complaint', verdict: 'escalate', matcher: { mode: 'contains_stem', stems: ['гомдол'] } }], error: null },
    quality_flags: { data: [], error: null },
    outbound_messages: { data: { body: 'Эмэгтэй тайралт (Мастер): 66,000₮–88,000₮' }, error: null },
    ...over,
  };
}

const INPUT: SalesShadowInput = {
  tenantId: 't-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  outboundId: 'om-1',
  customerMessage: 'Эмэгтэй тайралт хэд вэ',
  customerSentPhoto: false,
  history: [],
  refusal: false,
  threadControl: 'unknown',
  promptStable: '=== ХОЛБОО БАРИХ ===\n- Утас: 76001888, 80905498',
  canned: [{ kind: 'handoff', body: 'Уучлаарай, би хариулж чадахгүй.', reviewedAt: '2026-09-01' }],
  deterministic: [],
  spellings: [],
  now: new Date('2026-09-26T03:00:00Z'),
};

const inserts = (ops: { table: string; op: string; args: unknown[] }[]) => ops.filter((o) => o.op === 'insert');

test('no playbook row: nothing recorded, nothing written', async () => {
  const { db, ops } = fakeDb(tables({ sales_playbooks: { data: null, error: null } }));
  assert.deepEqual(await recordSalesShadow(db, INPUT), { outcome: 'off' });
  assert.equal(inserts(ops).length, 0);
});

test('mode off: nothing recorded', async () => {
  const { db, ops } = fakeDb(tables({ sales_playbooks: { data: { mode: 'off', lead_route: 'founder_telegram' }, error: null } }));
  assert.deepEqual(await recordSalesShadow(db, INPUT), { outcome: 'off' });
  assert.equal(inserts(ops).length, 0);
});

test('0051 NOT PUSHED: the shadow says unusable and writes nothing — the reply path never read it', async () => {
  const { db, ops } = fakeDb(tables({ sales_playbooks: { data: null, error: { message: 'relation "sales_playbooks" does not exist' } } }));
  const r = await recordSalesShadow(db, INPUT);
  assert.equal(r.outcome, 'unusable');
  assert.equal(inserts(ops).length, 0);
});

test('one quality_flags row per reply, on the customer message, with ids and kinds only', async () => {
  const { db, ops } = fakeDb(tables());
  const r = await recordSalesShadow(db, INPUT);
  assert.equal(r.outcome, 'recorded');
  const ins = inserts(ops);
  assert.equal(ins.length, 1);
  assert.equal(ins[0]?.table, 'quality_flags');
  const rows = ins.map((o) => o.args[0] as Record<string, unknown>);
  assert.equal(rows[0]?.['flag'], NEXT_STEP_FLAG);
  assert.equal(rows[0]?.['message_id'], 'm-1');
  assert.equal(rows[0]?.['tenant_id'], 't-1');
  assert.deepEqual(rows[0]?.['detail'], {
    verdict: 'offer', kind: 'booking', chosen_by: 'default', row: 'unwritten', outbound_id: 'om-1', mode: 'shadow',
  });
});

test('a phone number adds a lead row, MASKED; the tenant own number never does', async () => {
  const { db, ops } = fakeDb(tables());
  await recordSalesShadow(db, { ...INPUT, customerMessage: 'Бат байна. 9911 2233 руу залгаарай, 76001888 авсангүй' });
  const rows = inserts(ops).map((o) => o.args[0] as Record<string, unknown>);
  assert.deepEqual(rows.map((r) => r['flag']), [NEXT_STEP_FLAG, LEAD_FLAG]);
  const text = JSON.stringify(rows);
  assert.ok(text.includes('9911****'));
  assert.ok(!text.includes('99112233') && !text.includes('9911 2233') && !text.includes('7600'), text);
  assert.ok(!text.includes('Бат'), 'no customer words in the record');
});

test('an earlier offer in the conversation, read from the flags, makes it once per conversation', async () => {
  const { db } = fakeDb(tables({ quality_flags: { data: [{ flag: NEXT_STEP_FLAG, detail: { verdict: 'offer', kind: 'booking' } }], error: null } }));
  const r = await recordSalesShadow(db, INPUT);
  assert.equal(r.outcome === 'recorded' && r.decision.nextStep.verdict, 'skip');
  assert.deepEqual(r.outcome === 'recorded' && r.decision.nextStep, { verdict: 'skip', reason: 'already_offered' });
});

test('the reply it classifies is the STORED body: a stored handoff is a refusal', async () => {
  const { db } = fakeDb(tables({ outbound_messages: { data: { body: 'Уучлаарай, би хариулж чадахгүй.' }, error: null } }));
  const r = await recordSalesShadow(db, INPUT);
  assert.deepEqual(r.outcome === 'recorded' && r.decision.nextStep, { verdict: 'skip', reason: 'refusal_or_handoff' });
});

test('the reply carrying the step link is in_reply', async () => {
  const { db } = fakeDb(tables({ outbound_messages: { data: { body: 'Цагаа https://booking.example.mn/ хаягаар захиална уу.' }, error: null } }));
  const r = await recordSalesShadow(db, INPUT);
  assert.deepEqual(r.outcome === 'recorded' && r.decision.nextStep, { verdict: 'in_reply' });
});

test('its only write is quality_flags: never outbound_messages, never an alert', async () => {
  const { db, ops } = fakeDb(tables());
  await recordSalesShadow(db, { ...INPUT, customerMessage: 'Миний утас 88112233' });
  assert.deepEqual([...new Set(inserts(ops).map((o) => o.table))], ['quality_flags']);
  assert.ok(!ops.some((o) => o.table === 'alerts'));
});

test('a failed insert is reported, not thrown', async () => {
  const { db } = fakeDb(tables({ 'quality_flags:insert': { data: null, error: { message: 'boom' } } }));
  const r = await recordSalesShadow(db, INPUT);
  assert.equal(r.outcome, 'unusable');
});

test('the worker effect never rejects, whatever the database does', async () => {
  const db = { from: () => { throw new Error('socket closed'); } } as unknown as SupabaseClient;
  await assert.doesNotReject(salesShadowEffect(db, INPUT));
});

test('D-132: a live playbook sends a NEW lead to the founder\'s Telegram with the digits; shadow, a repeat, or no route sends nothing', async () => {
  const { leadNotice } = await import('./shadow.ts');
  const { decide, parsePlaybook } = await import('./nextStep.ts');
  const pb = (mode: string, route: string) => {
    const p = parsePlaybook({ mode, lead_route: route, steps: [], pairings: [] });
    if (!p.ok) throw new Error(p.detail);
    return p.playbook;
  };
  const decision = (playbook: ReturnType<typeof pb>, message: string, earlier: string[] = []) => decide({
    playbook, customerMessage: message, customerSentPhoto: false, earlierCustomerMessages: earlier,
    reply: { exists: true, cannedKinds: [], refusal: false, asksQuestion: false, smallTalk: false, carriesStepLink: false },
    threadControl: 'unknown', offeredBefore: false, leadBefore: false, complaintRules: [], ownNumbers: [], serviceNames: [],
  });
  const live = pb('live', 'founder_telegram');
  const n = leadNotice({ decision: decision(live, 'Бат 99112233'), playbook: live, customerMessage: 'Бат 99112233', conversationId: 'c-1' });
  assert.match(n ?? '', /New lead: 99112233/);
  assert.match(n ?? '', /Conversation c-1/);
  // An Instagram lead says so, so the founder opens the right inbox (D-141).
  const ig = leadNotice({ decision: decision(live, 'Бат 99112233'), playbook: live, customerMessage: 'Бат 99112233', conversationId: 'c-2', channelLabel: 'Instagram' });
  assert.match(ig ?? '', /^📞 New lead \(Instagram\): 99112233/);
  const shadow = pb('shadow', 'founder_telegram');
  assert.equal(leadNotice({ decision: decision(shadow, 'Бат 99112233'), playbook: shadow, customerMessage: 'x', conversationId: 'c' }), null);
  assert.equal(leadNotice({ decision: decision(live, '99112233', ['99112233']), playbook: live, customerMessage: 'x', conversationId: 'c' }), null);
  const none = pb('live', 'none');
  assert.equal(leadNotice({ decision: decision(none, '99112233'), playbook: none, customerMessage: 'x', conversationId: 'c' }), null);
});
