import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, draftOnce, findReplyFor, markFailed, markIndeterminate, markRefused, markSent, replyDedupKey } from './claim.ts';

/**
 * Records every write and lets each be made to fail independently, so the state machine
 * is proved one transition at a time rather than inferred from a happy path.
 */
function stubDb(opts: {
  insertError?: unknown; insertRow?: unknown;
  existingRow?: unknown; existingError?: unknown;
  claimRow?: unknown; claimError?: unknown;
  currentRow?: unknown; updateError?: unknown;
} = {}) {
  const ops: { table: string; op: string; patch?: Record<string, unknown>; filters: string[] }[] = [];
  const given = <T,>(k: string, fallback: T): T => (k in opts ? (opts as Record<string, T>)[k] as T : fallback);

  const from = (table: string) => {
    const rec: { table: string; op: string; patch?: Record<string, unknown>; filters: string[] } =
      { table, op: 'select', filters: [] };
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'in', 'or', 'select', 'lt', 'is']) {
      chain[m] = (...args: unknown[]) => { rec.filters.push(`${m}(${args.map(String).join(',')})`); return chain; };
    }
    chain['insert'] = (patch: Record<string, unknown>) => { rec.op = 'insert'; rec.patch = patch; ops.push(rec); return chain; };
    chain['update'] = (patch: Record<string, unknown>) => { rec.op = 'update'; rec.patch = patch; ops.push(rec); return chain; };
    chain['maybeSingle'] = async () => {
      if (rec.op === 'insert') {
        return { data: given('insertRow', { id: 'om-1', body: 'stored', state: 'draft', attempts: 0 } as unknown), error: opts.insertError ?? null };
      }
      if (rec.op === 'update') {
        return { data: given('claimRow', { id: 'om-1', body: 'stored', attempts: 0 } as unknown), error: opts.claimError ?? null };
      }
      // A plain read: either the existing-draft lookup or the post-claim state lookup.
      if ('currentRow' in opts) return { data: opts.currentRow, error: null };
      return { data: given('existingRow', null as unknown), error: opts.existingError ?? null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => res({ error: opts.updateError ?? null });
    return chain;
  };
  return { ops, db: { from } as never };
}

const draft = { tenantId: 't-1', kind: 'reply' as const, dedupKey: 'mid:abc', body: 'Хариулт' };
const now = new Date('2026-09-04T10:00:00Z');

// ---------------------------------------------------------------------------
// V1.md 3.5's named done-test.
// ---------------------------------------------------------------------------

test('DONE-TEST: a redelivery re-sends the STORED text, never re-generates', async () => {
  // QStash guarantees at-least-once delivery of the job; Messenger needs at-most-once
  // delivery of the reply. Those contradict unless a redelivery finds the body already
  // written — otherwise it re-enters generation: a second paid Anthropic call, a second
  // pass through the boundary gate that may answer differently, and two different replies
  // to one customer question.
  const { db } = stubDb({
    insertError: { code: '23505', message: 'duplicate key' },
    existingRow: { id: 'om-1', body: 'ХАДГАЛСАН ХАРИУЛТ', state: 'draft', attempts: 1 },
  });
  const r = await draftOnce(db, draft);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.created, false, 'it already existed');
  assert.equal(r.ok && r.row.body, 'ХАДГАЛСАН ХАРИУЛТ', 'the stored body, not a new one');
});

test('a first delivery writes the draft', async () => {
  const r = await draftOnce(stubDb().db, draft);
  assert.equal(r.ok && r.created, true);
});

test('uniqueness is the INDEX, not a check-then-insert', async () => {
  // Two workers racing on the same redelivery both attempt the insert; one wins and the
  // loser reads the winner's row. A read-then-decide-then-write lets both through.
  const { db, ops } = stubDb();
  await draftOnce(db, draft);
  assert.equal(ops[0]?.op, 'insert', 'the first database operation is the insert itself');
});

test('a draft with no dedup key is REFUSED, before touching the database', async () => {
  // The unique index is partial — `where dedup_key is not null` — so without a key every
  // redelivery inserts a fresh row and the customer is answered twice.
  const { db, ops } = stubDb();
  const r = await draftOnce(db, { ...draft, dedupKey: '' });
  assert.equal(r.ok, false);
  assert.deepEqual(ops, []);
});

test('an empty reply is refused rather than drafted', async () => {
  assert.equal((await draftOnce(stubDb().db, { ...draft, body: '   ' })).ok, false);
});

test('a unique violation with no row behind it refuses rather than writing a second reply', async () => {
  const { db } = stubDb({ insertError: { code: '23505', message: 'duplicate key' }, existingRow: null });
  const r = await draftOnce(db, draft);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.detail.includes('refusing to write a second reply'), true);
});

test('a non-uniqueness insert error is a real failure, not a redelivery', async () => {
  const r = await draftOnce(stubDb({ insertError: { code: '42501', message: 'permission denied' } }).db, draft);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// The claim. The CAS is in the WHERE clause.
// ---------------------------------------------------------------------------

test('claiming is one conditional UPDATE — the check cannot interleave with the claim', async () => {
  const { db, ops } = stubDb();
  const r = await claim(db, { id: 'om-1', tenantId: 't-1', now });
  assert.equal(r.outcome, 'claimed');
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.op, 'update');
  const filters = (ops[0]?.filters ?? []).join(' ');
  assert.equal(filters.includes('draft,failed'), true, 'the state CAS is in the WHERE clause');
  assert.equal(filters.includes('lease_until'), true, 'so is the lease check');
});

test('the lease is set on the claim, so a crashed worker releases it by expiry', async () => {
  const { db, ops } = stubDb();
  await claim(db, { id: 'om-1', tenantId: 't-1', now, leaseMs: 30_000 });
  assert.equal(ops[0]?.patch?.['lease_until'], '2026-09-04T10:00:30.000Z');
  assert.equal(ops[0]?.patch?.['state'], 'sending');
});

test('a message already SENT reports already_sent — the customer has their reply', async () => {
  const { db } = stubDb({ claimRow: null, currentRow: { state: 'sent' } });
  assert.deepEqual(await claim(db, { id: 'om-1', tenantId: 't-1', now }), { outcome: 'already_sent' });
});

test('a message another worker holds reports not_ours, with the state that explains why', async () => {
  const { db } = stubDb({ claimRow: null, currentRow: { state: 'sending' } });
  const r = await claim(db, { id: 'om-1', tenantId: 't-1', now });
  assert.equal(r.outcome === 'not_ours' && r.state, 'sending');
});

test('AN INDETERMINATE MESSAGE IS NEVER AUTO-CLAIMED', async () => {
  // Retrying a send that may have been delivered replies to the customer twice; marking
  // it failed loses a reply that may never have arrived. It is neither — it is parked.
  const { db } = stubDb({ claimRow: null, currentRow: { state: 'indeterminate' } });
  const r = await claim(db, { id: 'om-1', tenantId: 't-1', now });
  assert.equal(r.outcome === 'not_ours' && r.state, 'indeterminate');
});

test('a claim error is unavailable — never silently read as "someone else has it"', async () => {
  const { db } = stubDb({ claimError: { message: 'connection reset' } });
  assert.equal((await claim(db, { id: 'om-1', tenantId: 't-1', now })).outcome, 'unavailable');
});

test('a message belonging to another tenant is not found', async () => {
  const { db } = stubDb({ claimRow: null, currentRow: null });
  assert.equal((await claim(db, { id: 'om-1', tenantId: 't-1', now })).outcome, 'unavailable');
});

// ---------------------------------------------------------------------------
// Terminal transitions.
// ---------------------------------------------------------------------------

test('marking sent carries the cost, because the schema will not accept it otherwise', async () => {
  // `sent_has_a_cost`: a send whose cost we cannot state is a send we did not meter.
  const { db, ops } = stubDb();
  await markSent(db, { id: 'om-1', tenantId: 't-1', providerMessageId: 'mid.x', unitCost: 1_500n, now });
  // toDb() returns a JSON-safe NUMBER and throws above 2^53 rather than silently losing
  // precision, so the ledger and this row agree on what a nano-USD is.
  assert.equal(ops[0]?.patch?.['unit_cost_nanousd'], 1500);
  assert.equal(ops[0]?.patch?.['state'], 'sent');
  assert.equal((ops[0]?.filters ?? []).join(' ').includes('state,sending'), true, 'only a message we hold may be marked sent');
});

test('every terminal transition releases the lease', async () => {
  const cases: [string, (db: never) => Promise<unknown>][] = [
    ['failed', (db) => markFailed(db, { id: 'om-1', tenantId: 't-1', attempts: 0, reason: 'r' })],
    ['indeterminate', (db) => markIndeterminate(db, { id: 'om-1', tenantId: 't-1', reason: 'r' })],
    ['refused', (db) => markRefused(db, { id: 'om-1', tenantId: 't-1', reason: 'r' })],
  ];
  for (const [name, fn] of cases) {
    const { db, ops } = stubDb();
    await fn(db);
    assert.equal(ops[0]?.patch?.['lease_until'], null, `${name} must release the lease`);
  }
});

test('failure increments attempts; indeterminate does NOT — it is not a retry candidate', async () => {
  const { db: dbF, ops: opsF } = stubDb();
  await markFailed(dbF, { id: 'om-1', tenantId: 't-1', attempts: 2, reason: 'http 500' });
  assert.equal(opsF[0]?.patch?.['attempts'], 3);

  const { db: dbI, ops: opsI } = stubDb();
  await markIndeterminate(dbI, { id: 'om-1', tenantId: 't-1', reason: 'timeout after the request left' });
  assert.equal('attempts' in (opsI[0]?.patch ?? {}), false);
});

test('a guard refusal is RECORDED, not deleted — the Quality layer reads these', async () => {
  const { db, ops } = stubDb();
  await markRefused(db, { id: 'om-1', tenantId: 't-1', reason: 'outbound_price' });
  assert.equal(ops[0]?.patch?.['state'], 'refused');
  assert.equal(ops[0]?.patch?.['refused_reason'], 'outbound_price');
});

test('a refusal may catch a message in draft OR sending, but never one already sent', async () => {
  const { db, ops } = stubDb();
  await markRefused(db, { id: 'om-1', tenantId: 't-1', reason: 'outbound_url' });
  const filters = (ops[0]?.filters ?? []).join(' ');
  assert.equal(filters.includes('draft,sending'), true);
  assert.equal(filters.includes('in(state,sent'), false);
});

// ---------------------------------------------------------------------------
// findReplyFor — "has this customer message been answered?"
//
// The question `worker/reception.ts` used to answer from the wrong row. Every case below
// is one the old `if (stored.value.duplicate) continue;` got wrong or could not express.

test('the dedup key has ONE definition, and the draft path uses it', () => {
  assert.equal(replyDedupKey('m_abc123'), 'in:m_abc123');
});

test('DONE-TEST: a duplicate inbound with NO reply row is `absent`, not "already answered"', async () => {
  // The 2026-09-06 loss exactly: attempt one persisted the message and died at the spend
  // guard, so the inbound row exists and no reply does. Reading this as "answered" is what
  // made the message permanently unanswerable.
  const { db } = stubDb({ existingRow: null });
  const r = await findReplyFor(db, { tenantId: 't-1', kind: 'reply', dedupKey: 'in:m_1' });
  assert.deepEqual(r, { outcome: 'absent' });
});

test('an existing reply row is `answered`, and carries which one and what state', async () => {
  const { db } = stubDb({ existingRow: { id: 'om-9', state: 'sent' } });
  const r = await findReplyFor(db, { tenantId: 't-1', kind: 'reply', dedupKey: 'in:m_1' });
  assert.deepEqual(r, { outcome: 'answered', outboundId: 'om-9', state: 'sent' });
});

test('a DRAFT counts as answered — the reply exists and something else owns sending it', async () => {
  const { db } = stubDb({ existingRow: { id: 'om-9', state: 'draft' } });
  const r = await findReplyFor(db, { tenantId: 't-1', kind: 'reply', dedupKey: 'in:m_1' });
  assert.equal(r.outcome, 'answered');
});

test('DONE-TEST: an unreadable lookup is `unavailable` — never absent, never answered', async () => {
  // Both wrong answers cost something: `absent` double-replies, `answered` drops the
  // customer. A 503 costs a redelivery.
  const { db } = stubDb({ existingError: { message: 'connection reset' } });
  const r = await findReplyFor(db, { tenantId: 't-1', kind: 'reply', dedupKey: 'in:m_1' });
  assert.equal(r.outcome, 'unavailable');
  assert.match(r.outcome === 'unavailable' ? r.detail : '', /outbound_messages unreadable: connection reset/);
});

test('an empty dedup key refuses rather than guessing', async () => {
  // The unique index is partial on a non-empty key, so an empty one proves nothing.
  const { db, ops } = stubDb({});
  const r = await findReplyFor(db, { tenantId: 't-1', kind: 'reply', dedupKey: '' });
  assert.equal(r.outcome, 'unavailable');
  assert.equal(ops.length, 0, 'and it does not even ask the database');
});

test('the lookup is scoped to the tenant AND the kind, not the key alone', async () => {
  // `dedup_key` is unique per (tenant, kind, key). Asking on the key alone would let one
  // tenant\'s comment reply answer another tenant\'s DM.
  const { db } = stubDb({ existingRow: null });
  await findReplyFor(db, { tenantId: 't-1', kind: 'reply', dedupKey: 'in:m_1' });
  // stubDb records filters only for write ops; assert via a read-recording stub instead.
  const seen: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = (...a: unknown[]) => (seen.push(`${m}(${a.join(',')})`), chain);
  chain['maybeSingle'] = async () => ({ data: null, error: null });
  await findReplyFor({ from: () => chain } as never, { tenantId: 't-1', kind: 'reply', dedupKey: 'in:m_1' });
  assert.ok(seen.includes('eq(tenant_id,t-1)'), seen.join(' '));
  assert.ok(seen.includes('eq(kind,reply)'), seen.join(' '));
  assert.ok(seen.includes('eq(dedup_key,in:m_1)'), seen.join(' '));
});
