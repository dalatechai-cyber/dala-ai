/**
 * THE REPLAY HARNESS: every entry point, run twice, exactly-once effects.
 *
 * Three messages were lost on 2026-09-06 and all three violated one property:
 *
 *   > Replay any entry point with the same delivery, and the customer is answered exactly
 *   > once — never twice, and never zero times.
 *
 * Each was found in production, one at a time, after it had already cost a message:
 *
 *  1. the webhook skipped a redelivery whose first attempt never reached QStash (D-028);
 *  2. the worker skipped a redelivery whose first attempt died after persisting, because
 *     the inbound row existed (D-029);
 *  3. under both, a spend RPC that resolved against the wrong schema (D-029).
 *
 * Per-site fixes each came with per-site tests, and each test could only ever have caught
 * the bug it was written for. This file asserts the PROPERTY instead, at both entry
 * points, so the next site to get it wrong fails here without anybody predicting which
 * site that will be.
 *
 * ## What this harness is, and what it is not
 *
 * The store below is an in-process fake that enforces the three unique constraints the
 * property actually rests on — named in `UNIQUES`, each mirroring one in `0001` — plus
 * `reserve_spend`'s conditional update. It is NOT PostgREST: it cannot catch a name
 * resolved against the wrong schema, which is what bug 3 was. That class needs PostgREST
 * in CI and is proposed separately; nothing here should be read as covering it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleMetaEntry, type EntryDeps } from './webhook/entry.ts';
import { runReceptionJob, type WorkerEffects } from './worker/reception.ts';
import { draftOnce, replyDedupKey } from './outbound/claim.ts';
import type { ReceptionOutcome } from './reception/handle.ts';
import type { DeliverOutcome } from './outbound/deliver.ts';
import type { EnqueueResult } from './queue/qstash.ts';

// `ensurePerson` hashes the PSID with this. A test value, never a real one — and set here
// rather than mocked, because the hashing is part of the path being replayed.
process.env['IDENTITY_PEPPER'] = 'replay-harness-pepper-not-a-real-one';

const TENANT = '9f2b1c44-0000-4000-8000-000000000001';
const CHANNEL = '9f2b1c44-0000-4000-8000-00000000000a';
const PAGE = '863503883522801';
const PSID = '7654321098765432';
const MID = 'm_replay_1';
const NOW = new Date('2026-09-06T12:00:00Z');

type Unique = { table: string; cols: string[]; notNull: string | null };

/**
 * The uniques, READ OFF `0001` rather than transcribed.
 *
 * A fake that does not refuse a duplicate proves nothing — every bug this file exists for
 * was a caller reasoning about a row the database would have refused anyway. And a fake
 * carrying constraints somebody typed from memory is worse than none: it passes while
 * asserting the wrong thing. The first draft of this file did exactly that, keying
 * `messages` on two columns when the real index is
 * `(tenant_id, conversation_id, external_id) where external_id is not null` — and the
 * harness went green on a duplicate it should have refused.
 *
 * So the schema is the source. If an index is dropped or narrowed, this changes with it.
 */
function uniquesFromSchema(): Unique[] {
  const sql = readFileSync('supabase/migrations/0001_initial_schema.sql', 'utf8');
  const out: Unique[] = [];

  // create unique index NAME on TABLE (a, b) [where COL is not null];
  const idx = /create unique index\s+\w+\s+on\s+(\w+)\s*\(([^)]+)\)([^;]*);/gi;   // ascii-safe: SQL identifiers in a migration file, never customer text
  for (const m of sql.matchAll(idx)) {
    const notNull = /where\s+(\w+)\s+is not null/i.exec(m[3] ?? '');   // ascii-safe: a column name in SQL
    out.push({
      table: m[1] as string,
      cols: (m[2] as string).split(',').map((c) => c.trim()),
      notNull: notNull === null ? null : (notNull[1] as string),
    });
  }

  // Inline `unique (a, b)` inside each create table block.
  const tbl = /create table (\w+) \(([\s\S]*?)\n\);/g;   // ascii-safe: SQL identifiers in a migration file
  for (const m of sql.matchAll(tbl)) {
    for (const u of (m[2] as string).matchAll(/^\s*unique \(([^)]+)\)/gim)) {
      out.push({ table: m[1] as string, cols: (u[1] as string).split(',').map((c) => c.trim()), notNull: null });
    }
  }
  return out;
}

const UNIQUES = uniquesFromSchema();

type Row = Record<string, unknown>;

function store() {
  const tables = new Map<string, Row[]>();
  const failures = new Map<string, { message: string; code?: string }>();
  let seq = 0;

  const rows = (t: string): Row[] => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t) as Row[];
  };
  /** The row this one would collide with, or null. */
  const conflicting = (t: string, row: Row): Row | null => {
    for (const u of UNIQUES.filter((x) => x.table === t)) {
      // A partial index does not apply when its predicate column is null — which is how
      // `messages` tolerates a delivery carrying no Meta id at all.
      if (u.notNull !== null && (row[u.notNull] ?? null) === null) continue;
      const hit = rows(t).find((existing) =>
        u.cols.every((k) => existing[k] !== undefined && row[k] !== undefined && existing[k] === row[k]));
      if (hit !== undefined) return hit;
    }
    return null;
  };

  const from = (table: string) => {
    const preds: ((r: Row) => boolean)[] = [];
    let pending: Row | null = null;
    let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let ignoreDuplicates = false;

    const answer = (): { data: unknown; error: unknown } => {
      const forced = failures.get(table);
      if (forced !== undefined) {
        failures.delete(table);
        return { data: null, error: forced };
      }
      if (op === 'insert' || op === 'upsert') {
        const row = { id: pending?.['id'] ?? ++seq, ...(pending as Row) };
        const clash = conflicting(table, row);
        if (clash !== null) {
          // INSERT loses the index — 23505, which the caller is expected to read as a
          // redelivery rather than an error. UPSERT does not: it either updates the
          // winner (ON CONFLICT DO UPDATE) or leaves it alone (`ignoreDuplicates`), and
          // returns it. Getting this wrong makes every second contact look like a fault.
          if (op === 'insert') return { data: null, error: { code: '23505', message: `duplicate key on ${table}` } };
          if (!ignoreDuplicates) Object.assign(clash, pending);
          return { data: clash, error: null };
        }
        rows(table).push(row);
        return { data: row, error: null };
      }
      if (op === 'update') {
        const hit = rows(table).filter((r) => preds.every((p) => p(r)));
        for (const r of hit) Object.assign(r, pending);
        return { data: hit[0] ?? null, error: null };
      }
      const found = rows(table).filter((r) => preds.every((p) => p(r)));
      return { data: found[0] ?? null, error: null };
    };

    const chain: Record<string, unknown> = {};
    chain['select'] = () => chain;
    chain['eq'] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) === String(v)), chain);
    chain['neq'] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) !== String(v)), chain);
    chain['is'] = (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), chain);
    chain['lt'] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) < String(v)), chain);
    chain['gte'] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) >= String(v)), chain);
    chain['in'] = (c: string, v: unknown[]) => (preds.push((r) => v.map(String).includes(String(r[c]))), chain);
    chain['or'] = () => chain;          // the platform-or-tenant reads; the seed decides
    chain['order'] = () => chain;
    chain['limit'] = () => chain;
    chain['insert'] = (patch: Row) => { op = 'insert'; pending = patch; return chain; };
    chain['update'] = (patch: Row) => { op = 'update'; pending = patch; return chain; };
    chain['upsert'] = (patch: Row, opts?: { ignoreDuplicates?: boolean }) => {
      op = 'upsert'; pending = patch; ignoreDuplicates = opts?.ignoreDuplicates === true; return chain;
    };
    chain['maybeSingle'] = async () => answer();
    chain['single'] = async () => answer();
    chain['then'] = (res: (v: unknown) => unknown) => {
      const a = answer();
      // A bare await returns the LIST for a select; maybeSingle returns one row.
      if (op === 'select' && a.error === null) {
        return res({ data: rows(table).filter((r) => preds.every((p) => p(r))), error: null });
      }
      return res(a);
    };
    return chain;
  };

  /**
   * `0016`'s all-or-nothing functions, mirrored: every target moves or none does, and a
   * ceiling refusal is an ERROR carrying 23514 rather than a `false`, because that is what
   * rolls the partial reservation back in PostgreSQL.
   */
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const targets = (args['p_targets'] ?? []) as { scope: string; scope_key: string; period_key: string }[];
    const surface = String(args['p_surface']);
    const find = (t: { scope: string; scope_key: string; period_key: string }) =>
      rows('spend_counters').find((r) =>
        r['scope'] === t.scope && r['scope_key'] === t.scope_key &&
        r['surface'] === surface && r['period_key'] === t.period_key);

    if (fn === 'reserve_spend_all') {
      const amount = Number(args['p_amount_nanousd']);
      const hit = targets.map(find);
      const fits = hit.every((c) => c !== undefined &&
        Number(c['reserved_nanousd']) + Number(c['settled_nanousd']) + amount <= Number(c['ceiling_nanousd']));
      if (!fits) return { data: null, error: { code: '23514', message: 'ceiling_reached' } };
      for (const c of hit) (c as Row)['reserved_nanousd'] = Number((c as Row)['reserved_nanousd']) + amount;
      return { data: true, error: null };
    }

    if (fn === 'release_spend') {
      const held = rows('spend_reservations').find(
        (r) => r['id'] === args['p_reservation_id'] && r['state'] === 'held');
      if (held === undefined) return { data: false, error: null };
      held['state'] = 'released';
      const amount = Number(args['p_amount_nanousd']);
      for (const t of targets) {
        const c = find(t);
        if (c !== undefined) c['reserved_nanousd'] = Math.max(0, Number(c['reserved_nanousd']) - amount);
      }
      return { data: true, error: null };
    }

    if (fn === 'settle_spend_all') {
      const hit = targets.map(find);
      if (hit.some((c) => c === undefined)) return { data: null, error: { code: '23514', message: 'settle_incomplete' } };
      for (const c of hit) {
        (c as Row)['reserved_nanousd'] = Math.max(0, Number((c as Row)['reserved_nanousd']) - Number(args['p_reserved_nanousd']));
        (c as Row)['settled_nanousd'] = Number((c as Row)['settled_nanousd']) + Number(args['p_actual_nanousd']);
      }
      return { data: true, error: null };
    }

    // Anything else is a name the runtime should not be calling — and a fake that answers
    // `true` to every RPC is exactly what hid D-029's third bug for a whole build.
    return { data: null, error: { message: `no such function ${fn}` } };
  };

  return {
    db: { from, rpc } as never,
    rows,
    count: (t: string) => rows(t).length,
    seed: (t: string, row: Row) => rows(t).push(row),
    failNext: (t: string, message: string) => failures.set(t, { message }),
  };
}

/** A provisioned tenant on a live channel — the state tenant #0 is actually in. */
function provisioned() {
  const s = store();
  // The identity read is a join: `channel_identity` carrying an embedded `tenant_channels`.
  // Seeding the shape PostgREST returns, because the spine — not a policy — is what proves
  // the channel belongs to the tenant, and the fake must not be looser than that.
  s.seed('channel_identity', {
    tenant_id: TENANT, channel_id: CHANNEL, provider: 'facebook_page', external_id: PAGE, active: true,
    tenant_channels: { app_slug: 'dalatech', status: 'active', delivery_mode: 'live' },
  });
  s.seed('tenants', {
    id: TENANT, default_locale: 'mn-MN', prompt_cache_mode: 'off', timezone: 'Asia/Ulaanbaatar',
    max_reply_age_minutes: 30, live_revision_id: 'rev-1',
  });
  s.seed('tenant_channels', {
    id: CHANNEL, tenant_id: TENANT, external_id: PAGE, delivery_mode: 'live',
    graph_version_override: null, comment_policy: 'none',
  });
  s.seed('config_snapshots', {
    tenant_id: TENANT, revision_id: 'rev-1', channel: 'facebook_page',
    content_hash: 'h1', prompt_stable: 'ТОГТМОЛ ХЭСЭГ', allowed_numbers: [],
  });
  s.seed('canned_responses', { tenant_id: TENANT, kind: 'handoff', body: 'Хамт олон маань хариулах болно.', reviewed_at: '2026-09-06', locale: 'mn-MN' });
  s.seed('tenant_roles', { tenant_id: TENANT, role: 'reception', state: 'active', roles: { status: 'available' } });
  s.seed('spend_counters', { scope: 'tenant', scope_key: TENANT, surface: 'reception', period_kind: 'day', period_key: '2026-09-06', ceiling_nanousd: 1_500_000_000, reserved_nanousd: 0, settled_nanousd: 0 });
  s.seed('spend_counters', { scope: 'platform', scope_key: 'platform', surface: 'reception', period_kind: 'day', period_key: '2026-09-06', ceiling_nanousd: 10_000_000_000, reserved_nanousd: 0, settled_nanousd: 0 });
  return s;
}

const entry = (mid = MID) => ({
  id: PAGE,
  messaging: [{
    sender: { id: PSID }, recipient: { id: PAGE },
    timestamp: NOW.getTime() - 60_000,
    message: { mid, text: 'Сайн байна уу' },
  }],
});

/** The webhook entry point, driven directly. `enqueue` is the seam a test steers. */
function webhook(s: ReturnType<typeof store>, enqueue: EntryDeps['enqueue']) {
  const calls: string[] = [];
  const deps: EntryDeps = {
    db: s.db,
    enqueue: async (job) => { calls.push(job.dedupKey); return enqueue(job); },
    log: () => {},
  };
  return {
    calls,
    run: () => handleMetaEntry(deps, { provider: 'facebook_page', entry: entry(), index: 0, bodyBytes: 311, matchedAppSlug: 'dalatech' }),
  };
}

/** The worker entry point. The model is a stub; the DRAFT is real, so the index bites. */
function worker(s: ReturnType<typeof store>, eventId: number) {
  const sends: string[] = [];
  const generated: string[] = [];
  // Collected and shown on failure: a replay assertion that fails without saying which
  // step refused sends the reader back to the same guessing this file exists to end.
  const logs: string[] = [];
  const fx: WorkerEffects = {
    db: s.db,
    now: NOW,
    verifySignature: async () => true,
    alertStandby: async () => {},
    graphVersionDefault: () => 'v21.0',
    generateReply: async (a) => {
      generated.push(a.inboundExternalId ?? MID);
      const drafted = await draftOnce(s.db, {
        tenantId: TENANT, kind: 'reply', dedupKey: replyDedupKey(MID),
        body: 'Хариулт', channelId: CHANNEL, conversationId: 'conv-1',
      });
      return (drafted.ok
        ? { kind: 'drafted', outboundId: drafted.row.id, answeredBy: 'model' }
        : { kind: 'retry', detail: drafted.detail }) satisfies ReceptionOutcome;
    },
    deliver: async (a) => {
      sends.push(String(a.outboundId));
      return { outcome: 'sent', providerMessageId: 'mid.1' } satisfies DeliverOutcome;
    },
    flagQuality: async () => {},
    replyToComment: async () => { throw new Error('the DM path must never reach the comment surface'); },
    log: (level, event, fields) => { logs.push(`${level}:${event} ${JSON.stringify(fields ?? {})}`); },
  };
  return {
    sends, generated, logs,
    run: () => runReceptionJob(fx, {
      rawBody: JSON.stringify({ eventId, tenantId: TENANT, channelId: CHANNEL }),
      signature: 'sig',
    }),
  };
}

const ok: EnqueueResult = { ok: true, messageId: 'q-1' };

// ---------------------------------------------------------------------------

test('DONE-TEST: THE PROPERTY — both entry points replayed, the customer answered once', async () => {
  const s = provisioned();

  const w1 = webhook(s, async () => ok);
  const first = await w1.run();
  assert.equal(first.outcome, 'queued');
  const eventId = first.outcome === 'queued' ? first.eventId : 0;

  const j1 = worker(s, eventId);
  assert.equal((await j1.run()).status, 200, j1.logs.join(' | '));

  // The replay: Meta redelivers, QStash redelivers.
  const w2 = webhook(s, async () => ok);
  assert.equal((await w2.run()).outcome, 'already_queued');
  const j2 = worker(s, eventId);
  assert.equal((await j2.run()).status, 200, j2.logs.join(' | '));

  assert.equal(s.count('webhook_events'), 1, 'one event');
  assert.equal(s.count('messages'), 1, 'one inbound message');
  assert.equal(s.count('outbound_messages'), 1, 'ONE reply');
  assert.equal(j1.sends.length + j2.sends.length, 1, 'ONE send');
});

test('DONE-TEST: an enqueue that failed is re-queued on redelivery, not skipped', async () => {
  // D-028. The row exists and says `failed`; skipping it is what ended the only chance to
  // queue the first real customer message.
  const s = provisioned();
  const w1 = webhook(s, async () => ({ ok: false, detail: 'QStash refused' }));
  assert.equal((await w1.run()).outcome, 'enqueue_failed');
  assert.equal(s.rows('webhook_events')[0]?.['state'], 'failed');

  const w2 = webhook(s, async () => ok);
  const second = await w2.run();
  assert.equal(second.outcome, 'queued');
  assert.equal(second.outcome === 'queued' && second.redelivery, true);
  assert.equal(s.count('webhook_events'), 1, 'still one event, re-driven not duplicated');
});

test('DONE-TEST: a worker that died after persisting answers on the retry', async () => {
  // D-029. The inbound row exists because the FIRST attempt wrote it and then failed at
  // the spend guard. Reading that row as "already answered" is what made the second real
  // message permanently unanswerable.
  const s = provisioned();
  const first = await webhook(s, async () => ok).run();
  const eventId = first.outcome === 'queued' ? first.eventId : 0;

  const j1 = worker(s, eventId);
  s.failNext('tenant_roles', 'permission denied');        // the guard cannot determine
  assert.equal((await j1.run()).status, 503);
  assert.equal(s.count('messages'), 1, 'the customer message was persisted');
  assert.equal(s.count('outbound_messages'), 0, 'and nothing was drafted');

  const j2 = worker(s, eventId);
  assert.equal((await j2.run()).status, 200);
  assert.equal(j2.sends.length, 1, 'the retry ANSWERS');
  assert.equal(s.count('outbound_messages'), 1);
  assert.equal(s.count('messages'), 1, 'and does not double-persist');
});

test('a third and fourth delivery change nothing — the property holds under repetition', async () => {
  const s = provisioned();
  const first = await webhook(s, async () => ok).run();
  const eventId = first.outcome === 'queued' ? first.eventId : 0;
  let sends = 0;
  for (let i = 0; i < 4; i += 1) {
    await webhook(s, async () => ok).run();
    const j = worker(s, eventId);
    await j.run();
    sends += j.sends.length;
  }
  assert.equal(s.count('webhook_events'), 1);
  assert.equal(s.count('outbound_messages'), 1);
  assert.equal(sends, 1, 'exactly one send across five deliveries');
});

test('DONE-TEST: two workers racing one reply collapse at the INDEX, not in a read', async () => {
  // `findReplyFor` closes the window it can see. The window it cannot see is two workers
  // reading `absent` at the same instant — and the only thing standing there is
  // `outbound_messages_dedup`. A mutation that makes `draftOnce` treat the unique
  // violation as an error instead of reading the winner survived every other test in this
  // file, because the sequential replays never reach it.
  const s = provisioned();
  const draft = () => draftOnce(s.db, {
    tenantId: TENANT, kind: 'reply', dedupKey: replyDedupKey(MID),
    body: 'Хариулт', channelId: CHANNEL, conversationId: 'conv-1',
  });

  const first = await draft();
  const second = await draft();
  assert.equal(first.ok && first.created, true, 'the winner wrote it');
  assert.equal(second.ok && second.created, false, JSON.stringify(second));
  assert.equal(first.ok && second.ok && first.row.id === second.row.id, true, 'and the loser reads the SAME reply');
  assert.equal(s.count('outbound_messages'), 1, 'one reply, not two');
});

test('DONE-TEST: the fake carries the schema\'s own uniques, not remembered ones', () => {
  const named = (t: string) => UNIQUES.filter((u) => u.table === t).map((u) => u.cols.join('+'));
  assert.ok(named('webhook_events').includes('provider+dedup_key'), JSON.stringify(named('webhook_events')));
  assert.ok(named('messages').includes('tenant_id+conversation_id+external_id'), JSON.stringify(named('messages')));
  assert.ok(named('outbound_messages').includes('tenant_id+kind+dedup_key'), JSON.stringify(named('outbound_messages')));
  // And the partial ones stay partial: a message with no Meta id must still be storable.
  assert.equal(UNIQUES.find((u) => u.table === 'messages' && u.cols.length === 3)?.notNull, 'external_id');
});
