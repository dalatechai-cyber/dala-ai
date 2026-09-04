import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReceptionJob, type DeliverArgs, type GenerateArgs, type WorkerEffects } from './reception.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';

const TENANT = 't-1';
const CHANNEL = 'c-1';
const EVENT_ID = 4242;
const PSID = '7654321098765432';
const MID = 'm_abc';

/** Meta's own timestamp, and `now`, close enough together to be fresh. */
const NOW = new Date('2026-09-04T12:00:00Z');
const SENT_AT = new Date('2026-09-04T11:58:00Z');

/**
 * ONE ENTRY, not the whole webhook envelope.
 *
 * `webhook_events.raw_payload` holds `entry` — the webhook route stores one row per entry
 * because one POST can carry two tenants — and `extractInboundMessages` reads
 * `entry.messaging` directly. A fixture shaped like the envelope extracts zero messages
 * and the job answers 200 "nothing_to_answer", which looks exactly like a quiet success.
 * That is what the first draft of this file did.
 */
function payload(over: { mid?: string; text?: string; ts?: number } = {}) {
  return {
    id: '100000000000001',
    time: NOW.getTime(),
    messaging: [
      {
        sender: { id: PSID },
        recipient: { id: '100000000000001' },
        timestamp: over.ts ?? SENT_AT.getTime(),
        message: { mid: over.mid ?? MID, text: over.text ?? 'Сайн байна уу, үнэ хэд вэ?' },
      },
    ],
  };
}

const job = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ eventId: EVENT_ID, tenantId: TENANT, channelId: CHANNEL, ...over });

/**
 * A table-driven Supabase stub: each table serves a queue of replies, so a test can make
 * exactly one read fail without touching the others.
 */
type Reply = { data?: unknown; error?: unknown };

function stubDb(over: Record<string, Reply | Reply[]> = {}) {
  const ops: { table: string; op: string; patch?: Record<string, unknown> }[] = [];
  const queues = new Map<string, Reply[]>();
  queues.set('tenants', [...TENANTS_QUEUE]);
  for (const [table, v] of Object.entries(over)) queues.set(table, Array.isArray(v) ? [...v] : [v]);

  const next = (table: string): Reply => {
    const q = queues.get(table);
    if (q === undefined || q.length === 0) return DEFAULTS[table] ?? { data: null, error: null };
    return q.length === 1 ? (q[0] as Reply) : (q.shift() as Reply);
  };

  const from = (table: string) => {
    const rec = { table, op: 'select' } as (typeof ops)[number];
    ops.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'or', 'lt', 'gte', 'order', 'limit']) {
      chain[m] = () => chain;
    }
    for (const m of ['insert', 'update', 'upsert'] as const) {
      chain[m] = (patch: Record<string, unknown>) => {
        rec.op = m;
        rec.patch = patch;
        return chain;
      };
    }
    chain['maybeSingle'] = async () => next(table);
    chain['single'] = async () => next(table);
    chain['then'] = (res: (v: unknown) => unknown) => res(next(table));
    return chain;
  };
  // `reserve_spend` is an RPC, not a table: the CAS on the counter has to be one statement.
  return { ops, db: { from, rpc: async () => ({ data: true, error: null }) } as never };
}

/**
 * A provisioned tenant on a live channel, answering one fresh message.
 *
 * Every table a happy path touches is here, because the alternative is each test
 * assembling its own and none of them agreeing. A test overrides exactly the table it is
 * about; everything else stays healthy.
 *
 * `tenants` is a QUEUE of two because it is read twice with different columns: once by the
 * job for the tenant's settings, and again inside `loadLiveSnapshot` for the pointer.
 */
const TENANT_SETTINGS = {
  default_locale: 'mn-MN',
  prompt_cache_mode: '1h',
  timezone: 'Asia/Ulaanbaatar',
  max_reply_age_minutes: 30,
};

const DEFAULTS: Record<string, Reply> = {
  webhook_events: { data: { raw_payload: payload() }, error: null },
  tenant_channels: {
    data: { external_id: '100000000000001', delivery_mode: 'live', graph_version_override: null },
    error: null,
  },
  config_snapshots: {
    data: { content_hash: 'h1', prompt_stable: 'ТОГТМОЛ ХЭСЭГ', allowed_numbers: ['7741-7777'] },
    error: null,
  },
  canned_responses: { data: [{ kind: 'handoff', body: 'Утсаар холбогдоно уу.', reviewed_at: '2026-09-01' }], error: null },
  contacts: { data: { id: 'contact-1', person_id: 'person-1' }, error: null },
  conversations: { data: { id: 'conv-1' }, error: null },
  messages: { data: { id: 'msg-1' }, error: null },
  tenant_roles: { data: { state: 'active', roles: { status: 'available' } }, error: null },
  spend_reservations: { data: { id: 'res-1' }, error: null },
  outbound_messages: { data: { id: 'om-1', body: 'ХАРИУЛТ', attempts: 0 }, error: null },
};

/** Read twice, with different columns, so it is a queue rather than one answer. */
const TENANTS_QUEUE: Reply[] = [
  { data: TENANT_SETTINGS, error: null },
  { data: { live_revision_id: 'rev-1' }, error: null },
];

/**
 * The reception context and the chokepoint are stubbed at the module boundary they already
 * have: `loadReceptionContext` and `withTenantRole` both read through `db`, so a test
 * steers them by what the tables answer. Everything else is an injected effect.
 */
function stubEffects(over: Partial<WorkerEffects> & { tables?: Record<string, Reply | Reply[]> } = {}) {
  const { tables, ...rest } = over;
  const { db, ops } = stubDb(tables ?? {});
  const logs: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const generated: GenerateArgs[] = [];
  const delivered: DeliverArgs[] = [];
  const flags: { tenantId: string; conversationId: string; code: string; detail: string }[] = [];

  const fx: WorkerEffects = {
    db,
    now: NOW,
    verifySignature: async () => true,
    graphVersionDefault: () => 'v21.0',
    generateReply: async (a) => {
      generated.push(a);
      return { kind: 'drafted', outboundId: 'om-1', answeredBy: 'model' } satisfies ReceptionOutcome;
    },
    deliver: async (a) => {
      delivered.push(a);
      return { outcome: 'sent', providerMessageId: 'mid.1' } satisfies DeliverOutcome;
    },
    flagQuality: async (a) => {
      flags.push(a);
    },
    // The comment surface. Defaults to a stub that would fail loudly if a DM-path test
    // ever reached it: a `messages` entry carries no `changes`, so it must not.
    replyToComment: async () => {
      throw new Error('the DM path must never reach the comment surface');
    },
    log: (level, event, fields) => {
      logs.push(fields === undefined ? { level, event } : { level, event, fields });
    },
    ...rest,
  };
  return { fx, ops, logs, generated, delivered, flags };
}

const run = (fx: WorkerEffects, rawBody = job(), signature: string | null = 'sig') =>
  runReceptionJob(fx, { rawBody, signature });

const reasons = (logs: { event: string }[]) => logs.map((l) => l.event);

// ---------------------------------------------------------------------------
// The signature, and the two shapes of a job we published wrong
// ---------------------------------------------------------------------------

test('an unsigned or wrongly signed job is 401 and touches nothing', async () => {
  const { fx, ops } = stubEffects({ verifySignature: async () => false });
  const r = await run(fx);
  assert.equal(r.status, 401);
  assert.equal(r.body['error'], 'worker.signature_invalid');
  assert.equal(ops.length, 0, 'not one query may run for an unverified job');
});

test('a malformed job after a VALID signature is 200, not a retry loop', async () => {
  // We published it wrong. QStash retrying cannot fix our own bug, and a 503 would loop
  // against it until the queue gives up.
  const { fx, logs } = stubEffects();
  const r = await run(fx, 'not json at all');
  assert.equal(r.status, 200);
  assert.equal(r.body['dropped'], 'job_not_json');
  assert.deepEqual(reasons(logs), ['job_not_json']);
});

test('a job missing any of the three ids is 200 and named', async () => {
  for (const bad of [{ eventId: 'not-a-number' }, { tenantId: null }, { channelId: 42 }]) {
    const { fx } = stubEffects();
    const r = await run(fx, job(bad));
    assert.equal(r.status, 200, JSON.stringify(bad));
    assert.equal(r.body['dropped'], 'job_missing_fields');
  }
});

test('the tenant is never taken from the job when the job does not carry one', async () => {
  // CLAUDE.md rule 1: no `?? DEFAULT_TENANT`, not even for local testing. A job with no
  // tenant is dropped rather than resolved to some default.
  const { fx, ops } = stubEffects();
  const r = await run(fx, JSON.stringify({ eventId: EVENT_ID, channelId: CHANNEL }));
  assert.equal(r.body['dropped'], 'job_missing_fields');
  assert.equal(ops.length, 0);
});

// ---------------------------------------------------------------------------
// 503 versus 200 — the contract with QStash
// ---------------------------------------------------------------------------

test('THE ASYMMETRY: an unreadable read is 503, a missing row is 200', async () => {
  const cases: [string, Record<string, Reply>, number, string][] = [
    ['event', { webhook_events: { error: { message: 'reset' } } }, 503, 'worker.event_unreadable'],
    ['event', { webhook_events: { data: null } }, 200, 'event_missing'],
    ['tenant', { tenants: { error: { message: 'reset' } } }, 503, 'worker.tenant_unreadable'],
    ['tenant', { tenants: { data: null } }, 503, 'worker.tenant_unreadable'],
    ['channel', { tenant_channels: { error: { message: 'reset' } } }, 503, 'worker.channel_unreadable'],
    ['channel', { tenant_channels: { data: null } }, 200, 'channel_missing'],
  ];
  for (const [what, tables, status, marker] of cases) {
    const { fx } = stubEffects({ tables });
    const r = await run(fx);
    assert.equal(r.status, status, `${what}: ${marker}`);
    assert.equal(r.body['error'] ?? r.body['dropped'], marker);
  }
});

test('a missing channel is dropped rather than retried — the job named a bad binding', async () => {
  // A channel that does not belong to this tenant cannot start belonging to it on a
  // retry. 503 here would be an infinite loop against a fact.
  const { fx, logs } = stubEffects({ tables: { tenant_channels: { data: null } } });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.ok(reasons(logs).includes('channel_missing'));
});

test('an entry with nothing answerable is processed, not dropped silently', async () => {
  const { fx, logs, ops } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: { id: '1', messaging: [] } } } },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.ok(reasons(logs).includes('nothing_to_answer'));
  // Seen and declined is a different fact from vanished: the event is marked processed.
  assert.ok(ops.some((o) => o.table === 'webhook_events' && o.op === 'update'));
});

// ---------------------------------------------------------------------------
// Freshness — §3.9 check 7, and the founder's 30 minutes
// ---------------------------------------------------------------------------

test('DONE-TEST: an hour-old message is persisted, flagged, and never answered', async () => {
  const { fx, generated, delivered, flags, logs } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: payload({ ts: NOW.getTime() - 60 * 60_000 }) } } },
  });
  const r = await run(fx);

  assert.equal(r.status, 200);
  assert.equal(r.body['stale'], 1);
  assert.equal(r.body['drafted'], 0);
  assert.equal(generated.length, 0, 'no model call');
  assert.equal(delivered.length, 0, 'no send');
  assert.ok(reasons(logs).includes('reply_too_late'));

  // Persisted first, and visible to the Quality layer as a question nobody answered.
  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.code, 'reply_too_late');
  assert.equal(flags[0]?.tenantId, TENANT, 'quality_flags.tenant_id is NOT NULL');
  assert.match(flags[0]?.detail ?? '', /60 minutes old/);
});

test('the customer message is stored BEFORE the freshness refusal', async () => {
  // §3.4.5: persist everything, generate nothing. Losing the message would cost the
  // Quality layer the only record that somebody asked and got nothing.
  const { fx, ops } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: payload({ ts: NOW.getTime() - 90 * 60_000 }) } } },
  });
  await run(fx);
  const tables = ops.map((o) => o.table);
  for (const t of ['contacts', 'conversations', 'messages']) {
    assert.ok(tables.includes(t), `${t} must be written before the refusal`);
  }
  // And nothing that costs money.
  assert.ok(!tables.includes('spend_reservations'), 'no reservation for a message we refuse');
});

test("the tenant's own limit is what decides, not the platform's", async () => {
  const eightyMinutesAgo = { webhook_events: { data: { raw_payload: payload({ ts: NOW.getTime() - 80 * 60_000 }) } } };

  const strict = stubEffects({ tables: eightyMinutesAgo });
  assert.equal((await run(strict.fx)).body['stale'], 1);

  const garage = stubEffects({
    tables: {
      ...eightyMinutesAgo,
      // Both reads, because overriding the table replaces the whole queue.
      tenants: [
        { data: { ...TENANT_SETTINGS, max_reply_age_minutes: 120 }, error: null },
        { data: { live_revision_id: 'rev-1' }, error: null },
      ],
    },
  });
  const r = await run(garage.fx);
  assert.equal(r.body['stale'], 0);
  assert.equal(r.body['drafted'], 1, 'GS Auto Center answers what Matrix would not');
});

test('a message with no usable timestamp is treated as now, not as 1970', async () => {
  const { fx, generated } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: payload({ ts: Number.NaN }) } } },
  });
  const r = await run(fx);
  assert.equal(r.body['stale'], 0);
  assert.equal(generated.length, 1);
  assert.equal(generated[0]?.eventAt.getTime(), NOW.getTime());
});

// ---------------------------------------------------------------------------
// The happy path, and what it passes down
// ---------------------------------------------------------------------------

test('a fresh message is drafted and delivered on the tenant\'s own channel', async () => {
  const { fx, generated, delivered } = stubEffects();
  const r = await run(fx);

  assert.equal(r.status, 200);
  assert.equal(r.body['drafted'], 1);
  assert.equal(r.body['sent'], 1);

  assert.equal(generated[0]?.tenantId, TENANT);
  assert.equal(generated[0]?.customerMessage, 'Сайн байна уу, үнэ хэд вэ?');
  assert.equal(generated[0]?.inboundExternalId, MID);

  assert.equal(delivered[0]?.pageId, '100000000000001');
  assert.equal(delivered[0]?.recipientId, PSID);
  assert.equal(delivered[0]?.graphVersion, 'v21.0');
});

test("a channel's graph version override wins over the platform default", async () => {
  const { fx, delivered } = stubEffects({
    tables: {
      tenant_channels: {
        data: { external_id: '100000000000001', delivery_mode: 'live', graph_version_override: 'v19.0' },
      },
    },
  });
  await run(fx);
  assert.equal(delivered[0]?.graphVersion, 'v19.0');
});

test('the STORED body is what gets sent, never the freshly generated one', async () => {
  // `claim` returns what was written the first time. That is what makes a redelivery a
  // re-send rather than a second answer, and this asserts the worker uses it.
  const { fx, delivered } = stubEffects({
    tables: { outbound_messages: [{ data: { id: 'om-1', body: 'ХАДГАЛСАН ХАРИУЛТ', attempts: 2 } }] },
  });
  await run(fx);
  assert.equal(delivered[0]?.body, 'ХАДГАЛСАН ХАРИУЛТ');
  assert.equal(delivered[0]?.attempts, 2);
});

// ---------------------------------------------------------------------------
// The two gates in front of the send
// ---------------------------------------------------------------------------

test('DONE-TEST: a shadow channel drafts and does NOT send', async () => {
  // Track 4's 14-day mirror. Meta delivers the identical event to every subscribed app,
  // so a shadow channel that sent would give every Matrix customer two replies from one
  // salon for two weeks.
  const { fx, delivered, logs } = stubEffects({
    tables: {
      tenant_channels: { data: { external_id: '100000000000001', delivery_mode: 'shadow', graph_version_override: null } },
    },
  });
  const r = await run(fx);
  assert.equal(r.body['drafted'], 1, 'the reply is still generated');
  assert.equal(r.body['sent'], 0);
  assert.equal(delivered.length, 0);
  assert.ok(reasons(logs).includes('not_delivering'));
});

test('every non-live mode refuses to deliver', async () => {
  for (const mode of ['off', 'shadow_routing', 'shadow', 'unrecognised']) {
    const { fx, delivered } = stubEffects({
      tables: {
        tenant_channels: { data: { external_id: '1', delivery_mode: mode, graph_version_override: null } },
      },
    });
    await run(fx);
    assert.equal(delivered.length, 0, mode);
  }
});

// ---------------------------------------------------------------------------
// What each send outcome does to the response
// ---------------------------------------------------------------------------

test('an indeterminate send is 200 — no automatic retry may touch that row', async () => {
  const { fx, logs } = stubEffects({
    deliver: async () => ({ outcome: 'indeterminate', detail: 'send did not complete (timeout)' }),
  });
  const r = await run(fx);
  assert.equal(r.status, 200, 'a 503 here would re-send a message that may have arrived');
  assert.equal(r.body['sent'], 0);
  assert.ok(reasons(logs).includes('send_indeterminate'));
});

test('a retryable send failure is 503 so the stored text is re-sent', async () => {
  const { fx } = stubEffects({
    deliver: async () => ({ outcome: 'failed', failure: 'rate_limited', retryable: true, detail: 'graph 429' }),
  });
  const r = await run(fx);
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'worker.send_rate_limited');
});

test('a terminal send failure is 200 — retrying a 190 bans the shared app', async () => {
  const { fx, logs } = stubEffects({
    deliver: async () => ({ outcome: 'failed', failure: 'token_revoked', retryable: false, detail: 'graph 400 code=190' }),
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.ok(reasons(logs).includes('send_terminal'));
});

test('a delivered reply whose bookkeeping failed is still delivered', async () => {
  const { fx, logs } = stubEffects({
    deliver: async () => ({ outcome: 'sent', providerMessageId: 'mid.1', bookkeeping: 'markSent: unwritable' }),
  });
  const r = await run(fx);
  assert.equal(r.body['sent'], 1);
  assert.ok(reasons(logs).includes('send_bookkeeping_failed'), 'loud, and not a re-send');
});

// ---------------------------------------------------------------------------
// The flow's own outcomes
// ---------------------------------------------------------------------------

test('a retryable reception outcome is 503 and stops the entry', async () => {
  const { fx, delivered } = stubEffects({
    generateReply: async () => ({ kind: 'retry', detail: 'model unreachable' }),
  });
  const r = await run(fx);
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'worker.reception_retry');
  assert.equal(delivered.length, 0);
});

test('a dropped reception outcome continues to the next message', async () => {
  const { fx, logs } = stubEffects({ generateReply: async () => ({ kind: 'dropped', reason: 'stale_event' }) });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(r.body['drafted'], 0);
  assert.ok(reasons(logs).includes('reception_dropped'));
});

test('a handoff answer is still an answer, and it is logged as one', async () => {
  const { fx, logs } = stubEffects({
    generateReply: async () => ({ kind: 'drafted', outboundId: 'om-1', answeredBy: 'canned', refusal: 'outbound_numeral' }),
  });
  const r = await run(fx);
  assert.equal(r.body['drafted'], 1);
  assert.ok(reasons(logs).includes('answered_with_handoff'));
});

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

test('a reply somebody else already holds or sent is skipped, not re-sent', async () => {
  // `claim`'s CAS matches nothing, then the state read says `sent`.
  const { fx, delivered, logs } = stubEffects({
    tables: { outbound_messages: [{ data: null }, { data: { state: 'sent' } }] },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(delivered.length, 0);
  assert.ok(reasons(logs).includes('not_ours'));
});

test('an unreadable outbound row is 503, never a silent skip', async () => {
  const { fx } = stubEffects({ tables: { outbound_messages: { error: { message: 'reset' } } } });
  const r = await run(fx);
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'worker.claim_unavailable');
});

// ---------------------------------------------------------------------------
// Persistence failures
// ---------------------------------------------------------------------------

test('every persistence failure is 503 — nothing is lost to a 200', async () => {
  const cases: [string, Record<string, Reply>, string][] = [
    ['contacts', { contacts: { error: { message: 'x' } } }, 'worker.contact_failed'],
    ['conversations', { conversations: { error: { message: 'x' } } }, 'worker.conversation_failed'],
    ['messages', { messages: { error: { message: 'x' } } }, 'worker.message_failed'],
  ];
  for (const [what, tables, code] of cases) {
    const { fx } = stubEffects({ tables });
    const r = await run(fx);
    assert.equal(r.status, 503, what);
    assert.equal(r.body['error'], code);
  }
});

test('a redelivery of the same customer message never generates a second reply', async () => {
  // `recordInbound` reports a duplicate. Generating again would double-reply and
  // double-bill, which is the whole reason the message id is the idempotency key.
  const { fx, generated } = stubEffects({
    tables: {
      // The insert loses the unique index, then the follow-up read finds the winner's row.
      // That is a redelivery, not an error — the same shape `outbound/claim.ts` relies on.
      messages: [
        { error: { code: '23505', message: 'duplicate key' } },
        { data: { id: 'msg-1' }, error: null },
      ],
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(generated.length, 0);
  assert.equal(r.body['drafted'], 0);
});
