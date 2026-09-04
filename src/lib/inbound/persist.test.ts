import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['IDENTITY_PEPPER'] = 'test-pepper-not-a-real-one';

const {
  CONVERSATION_IDLE_MS, ensureContact, ensurePerson, identityHash,
  openConversation, readHistory, recordInbound,
} = await import('./persist.ts');

type Reply = { data?: unknown; error?: unknown };

/**
 * Each table may be given ONE reply or a SEQUENCE consumed in order.
 *
 * The sequence matters: several functions here read, then write, then read again, and a
 * stub that can only answer one way per table forces tests that assert the stub's
 * limitation instead of the code's behaviour — coverage that looks real and is not.
 */
function stubDb(over: Record<string, Reply | Reply[]> = {}) {
  // `| undefined` explicitly: exactOptionalPropertyTypes is on, so an optional property
  // and one that may hold undefined are different types.
  const ops: { table: string; op: string; patch?: Record<string, unknown> | undefined; filters: string[] }[] = [];
  const cursor: Record<string, number> = {};
  const nextReply = (k: string): Reply | undefined => {
    const v = over[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return v;
    const i = cursor[k] ?? 0;
    cursor[k] = i + 1;
    return v[Math.min(i, v.length - 1)];
  };
  const given = (k: string, fallback: unknown) => {
    const r = nextReply(k);
    return r === undefined ? fallback : r.data;
  };
  const from = (table: string) => {
    const rec = { table, op: 'select', patch: undefined as Record<string, unknown> | undefined, filters: [] as string[] };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit', 'is']) {
      chain[m] = (...a: unknown[]) => { rec.filters.push(`${m}(${a.map(String).join(',')})`); return chain; };
    }
    for (const m of ['insert', 'update', 'upsert']) {
      chain[m] = (patch: Record<string, unknown>) => { rec.op = m; rec.patch = patch; ops.push(rec); return chain; };
    }
    chain['maybeSingle'] = async () => {
      const peek = Array.isArray(over[table]) ? (over[table] as Reply[])[cursor[table] ?? 0] : over[table];
      const err = peek?.error ?? null;
      if (err !== null) { void given(table, null); return { data: null, error: err }; }
      switch (table) {
        case 'contacts': return { data: given('contacts', { id: 'c-1', person_id: null }), error: null };
        case 'persons': return { data: given('persons', { id: 'p-1' }), error: null };
        case 'conversations': return { data: given('conversations', { id: 'cv-1' }), error: null };
        case 'messages': return { data: given('messages', { id: 'm-1' }), error: null };
        default: return { data: null, error: null };
      }
    };
    chain['then'] = (res: (v: unknown) => unknown) => {
      if (rec.op === 'select' && table === 'messages') {
        const r = nextReply('messages_list');
        return res({ data: r?.data ?? [], error: r?.error ?? null });
      }
      const r = Array.isArray(over[table]) ? undefined : (over[table] as Reply | undefined);
      return res({ data: null, error: r?.error ?? null });
    };
    return chain;
  };
  return { ops, db: { from } as never };
}

const now = new Date('2026-09-04T10:00:00Z');

// ---------------------------------------------------------------------------
// The identity hash.
// ---------------------------------------------------------------------------

test('THE PSID IS KEYED, NOT MERELY HASHED', () => {
  // A Meta PSID is a ~16-digit number, so the whole space is 10^16 and a plain fast hash
  // is brute-forceable on commodity hardware. The key is what makes the stored value
  // unusable to someone who obtains the table.
  const a = identityHash('psid', '1234567890123456');
  assert.equal(a.length, 32);

  process.env['IDENTITY_PEPPER'] = 'a-different-pepper';
  const b = identityHash('psid', '1234567890123456');
  process.env['IDENTITY_PEPPER'] = 'test-pepper-not-a-real-one';
  assert.notDeepEqual(a, b, 'the same PSID under a different key must not collide');
});

test('the kind is bound into the hash, so a phone and a PSID cannot collide', () => {
  assert.notDeepEqual(identityHash('psid', '976'), identityHash('phone', '976'));
});

test('a missing pepper THROWS rather than falling back to an unkeyed hash', () => {
  const saved = process.env['IDENTITY_PEPPER'];
  delete process.env['IDENTITY_PEPPER'];
  assert.throws(() => identityHash('psid', 'x'), /IDENTITY_PEPPER/);
  process.env['IDENTITY_PEPPER'] = saved;
});

// ---------------------------------------------------------------------------
// Contacts.
// ---------------------------------------------------------------------------

test('the contact is UPSERTED on (tenant, channel, external_id), not read-then-written', () => {
  // A PSID is Page-scoped, so the channel is part of the key: two tenants can see the
  // same numeric id and it means different people. Two workers racing a first message
  // would both read "absent" and both insert.
  const { db, ops } = stubDb();
  return ensureContact(db, { tenantId: 't-1', channelId: 'ch-1', externalId: '123', now }).then((r) => {
    assert.equal(r.ok && r.value.contactId, 'c-1');
    assert.equal(ops[0]?.op, 'upsert');
    assert.equal(ops[0]?.patch?.['external_id'], '123');
  });
});

test('a display name is NFC-normalised, and an absent one is not written at all', async () => {
  const { db, ops } = stubDb();
  await ensureContact(db, { tenantId: 't-1', channelId: 'ch-1', externalId: '1', displayName: 'Ёлка'.normalize('NFD'), now });
  assert.equal(ops[0]?.patch?.['display_name'], 'Ёлка');

  const bare = stubDb();
  await ensureContact(bare.db, { tenantId: 't-1', channelId: 'ch-1', externalId: '1', now });
  assert.equal('display_name' in (bare.ops[0]?.patch ?? {}), false, 'never overwrite a name with null');
});

test('an empty external id is refused before any write', async () => {
  const { db, ops } = stubDb();
  const r = await ensureContact(db, { tenantId: 't-1', channelId: 'ch-1', externalId: '', now });
  assert.equal(r.ok, false);
  assert.deepEqual(ops, []);
});

test('an upsert failure refuses; it never invents a contact id', async () => {
  const { db } = stubDb({ contacts: { error: { message: 'deadlock' } } });
  assert.equal((await ensureContact(db, { tenantId: 't-1', channelId: 'ch-1', externalId: '1', now })).ok, false);
});

// ---------------------------------------------------------------------------
// Persons.
// ---------------------------------------------------------------------------

test('linking a person NEVER steals a contact that already has one', async () => {
  const { db, ops } = stubDb();
  await ensurePerson(db, { tenantId: 't-1', contactId: 'c-1', kind: 'psid', externalId: '123' });
  const link = ops.find((o) => o.table === 'contacts' && o.op === 'update');
  assert.equal((link?.filters ?? []).join(' ').includes('is(person_id,null)'), true, 'the CAS is in the WHERE clause');
});

test('the identity row stores the keyed hash, never the PSID itself', async () => {
  const { db, ops } = stubDb();
  await ensurePerson(db, { tenantId: 't-1', contactId: 'c-1', kind: 'psid', externalId: '1234567890123456' });
  const identity = ops.find((o) => o.table === 'person_identities');
  assert.equal(Buffer.isBuffer(identity?.patch?.['value_hash']), true);
  assert.equal(JSON.stringify(identity?.patch).includes('1234567890123456'), false, 'the raw PSID must not be written');
});

// ---------------------------------------------------------------------------
// Conversations.
// ---------------------------------------------------------------------------

test('a recent open conversation is reused and touched, not duplicated', async () => {
  const { db, ops } = stubDb();
  const r = await openConversation(db, { tenantId: 't-1', contactId: 'c-1', channelId: 'ch-1', now });
  assert.equal(r.ok && r.value.created, false);
  assert.equal(ops[0]?.op, 'update');
  assert.equal(ops[0]?.patch?.['last_message_at'], now.toISOString());
});

test('a conversation idle past the window starts a NEW one', async () => {
  // Read finds nothing (everything is older than the cutoff), then the insert succeeds.
  const { db, ops } = stubDb({ conversations: [{ data: null }, { data: { id: 'cv-2' } }] });
  const r = await openConversation(db, { tenantId: 't-1', contactId: 'c-1', channelId: 'ch-1', now });
  assert.equal(r.ok && r.value.created, true);
  assert.equal(r.ok && r.value.conversationId, 'cv-2');
  assert.equal(ops[0]?.op, 'insert');
  assert.equal(ops[0]?.patch?.['state'], 'active');
});

test('the idle cutoff is 24h, and it is the unit Reception is SOLD in', async () => {
  // D-015's 400-conversation band counts these rows: a shorter window sells fewer
  // conversations for the same traffic and a longer one sells more. Changing it is a
  // pricing change wearing a code change's clothes.
  assert.equal(CONVERSATION_IDLE_MS, 24 * 60 * 60 * 1000);
});

test('a failed conversation insert refuses rather than returning a bare id', async () => {
  const { db } = stubDb({ conversations: [{ data: null }, { error: { message: 'fk violation' } }] });
  assert.equal((await openConversation(db, { tenantId: 't-1', contactId: 'c-1', channelId: 'ch-1', now })).ok, false);
});

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

test('a redelivery finds the STORED message rather than inserting a second copy', async () => {
  // A duplicate would then appear twice in the history the model is shown.
  const { db } = stubDb({ messages: [{ error: { code: '23505', message: 'dup' } }, { data: { id: 'm-existing' } }] });
  const r = await recordInbound(db, { tenantId: 't-1', conversationId: 'cv-1', externalId: 'mid.1', body: 'Сайн уу', now });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value.duplicate, true);
  assert.equal(r.ok && r.value.messageId, 'm-existing');
});

test('a NON-uniqueness insert error is a real failure, not a redelivery', async () => {
  const { db } = stubDb({ messages: [{ error: { code: '42501', message: 'permission denied' } }] });
  assert.equal((await recordInbound(db, { tenantId: 't-1', conversationId: 'cv-1', externalId: 'm', body: 'x', now })).ok, false);
});

test('a unique violation with no row behind it refuses rather than guessing an id', async () => {
  const { db } = stubDb({ messages: [{ error: { code: '23505', message: 'dup' } }, { data: null }] });
  assert.equal((await recordInbound(db, { tenantId: 't-1', conversationId: 'cv-1', externalId: 'm', body: 'x', now })).ok, false);
});

test('the body is NFC-normalised — the column has a `is normalized` CHECK', async () => {
  const { db, ops } = stubDb();
  await recordInbound(db, { tenantId: 't-1', conversationId: 'cv-1', externalId: 'mid.1', body: 'Ёлка'.normalize('NFD'), now });
  assert.equal(ops[0]?.patch?.['body'], 'Ёлка');
});

test('an empty inbound message is refused, not stored as a blank row', async () => {
  // `redacted_or_present`: a retained message either has a body or has been redacted.
  const { db, ops } = stubDb();
  const r = await recordInbound(db, { tenantId: 't-1', conversationId: 'cv-1', externalId: 'm', body: '   ', now });
  assert.equal(r.ok, false);
  assert.deepEqual(ops, []);
});

test('an absent external id is stored as NULL, so the partial unique index does not apply', async () => {
  const { db, ops } = stubDb();
  await recordInbound(db, { tenantId: 't-1', conversationId: 'cv-1', externalId: '', body: 'x', now });
  assert.equal(ops[0]?.patch?.['external_id'], null);
});

// ---------------------------------------------------------------------------
// History. The distinction the ancestor carries and a rewrite loses.
// ---------------------------------------------------------------------------

test('AN UNREADABLE HISTORY IS AN ERROR, NEVER AN EMPTY ONE', async () => {
  // The ancestor's getHistory returns null when Redis is unreachable and [] only when it
  // genuinely answered "no turns". Without that distinction a hiccup makes the bot greet
  // an existing customer from scratch.
  const { db } = stubDb({ messages_list: { error: { message: 'timeout' } } });
  const r = await readHistory(db, { tenantId: 't-1', conversationId: 'cv-1', limit: 10 });
  assert.equal(r.ok, false);
});

test('a genuinely empty conversation returns an empty history, and that is a success', async () => {
  const r = await readHistory(stubDb().db, { tenantId: 't-1', conversationId: 'cv-1', limit: 10 });
  assert.deepEqual(r, { ok: true, value: [] });
});

test('turns come back oldest-first with inbound as user and outbound as assistant', async () => {
  const { db } = stubDb({ messages_list: { data: [
    { direction: 'outbound', body: 'Хоёр дахь', at: '2026-09-04T09:01:00Z' },
    { direction: 'inbound',  body: 'Нэг дэх',  at: '2026-09-04T09:00:00Z' },
  ] } });
  const r = await readHistory(db, { tenantId: 't-1', conversationId: 'cv-1', limit: 10 });
  assert.deepEqual(r.ok && r.value, [
    { role: 'user', content: 'Нэг дэх' },
    { role: 'assistant', content: 'Хоёр дахь' },
  ]);
});

test('a redacted message is SKIPPED, not sent to the model as a blank turn', async () => {
  const { db } = stubDb({ messages_list: { data: [
    { direction: 'inbound', body: null, at: '2026-09-04T09:00:00Z' },
    { direction: 'inbound', body: 'Байгаа', at: '2026-09-04T09:01:00Z' },
  ] } });
  const r = await readHistory(db, { tenantId: 't-1', conversationId: 'cv-1', limit: 10 });
  assert.deepEqual(r.ok && r.value, [{ role: 'user', content: 'Байгаа' }]);
});
