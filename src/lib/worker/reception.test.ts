import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECEPTION_MAX_DELIVERIES, runReceptionJob, TYPING_WAIT_MS, type DeliverArgs, type GenerateArgs, type WorkerEffects } from './reception.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import type { ExhaustedInput } from './exhaustedAlert.ts';

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
function payload(over: { mid?: string; text?: string; ts?: number; attachments?: unknown[] } = {}) {
  return {
    id: '100000000000001',
    time: NOW.getTime(),
    messaging: [
      {
        sender: { id: PSID },
        recipient: { id: '100000000000001' },
        timestamp: over.ts ?? SENT_AT.getTime(),
        message: {
          mid: over.mid ?? MID,
          text: over.text ?? 'Сайн байна уу, үнэ хэд вэ?',
          ...(over.attachments === undefined ? {} : { attachments: over.attachments }),
        },
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
  const standbyAlerts: { tenantId: string; channelId: string; dayKey: string; events: number }[] = [];
  const exhausted: ExhaustedInput[] = [];
  const typed: { tenantId: string; channelId: string; recipientId: string }[] = [];

  const fx: WorkerEffects = {
    db,
    now: NOW,
    verifySignature: async () => true,
    alertStandby: async (a) => { standbyAlerts.push(a); },
    alertDeliveryExhausted: async (a) => { exhausted.push(a); },
    showTyping: async (a) => { typed.push(a); },
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
    sendPrivateReply: async () => { throw new Error('the DM path must never reach the comment surface'); },
    lookupComment: async () => { throw new Error('the DM path must never reach the comment surface'); },
    alertComplaint: async () => { throw new Error('the DM path must never reach the comment surface'); },
    log: (level, event, fields) => {
      logs.push(fields === undefined ? { level, event } : { level, event, fields });
    },
    ...rest,
  };
  return { fx, ops, logs, generated, delivered, flags, standbyAlerts, exhausted, typed };
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
// Secondary receiver (§3.7)
// ---------------------------------------------------------------------------

test('DONE-TEST: a standby entry is refused, marked and ALERTED — never processed', async () => {
  // §3.7: the Page Inbox app is the primary receiver, so Meta delivers into entry.standby
  // and we may not answer. The webhook is well-formed, correctly signed and correctly
  // routed for the right tenant, so before this branch the entry read as "no customer
  // wrote in": 200, marked processed, every health signal green, and the only symptom the
  // salon phoning the founder.
  //
  // THIS BRANCH IS NOT THE TWO-APP CASE, and the 2026-09-07 measurement must not be read
  // as retiring it. That measurement (D-043) subscribed tenant #0's Page to both Meta apps
  // and the message still arrived in `entry.messaging` for both — being a second
  // subscriber is not a Handover demotion. A Page whose PRIMARY RECEIVER is the Page
  // Inbox app is a different setting and still produces standby, which is what this test
  // covers and why deleting it on the strength of that measurement would restore the
  // silent failure exactly.
  const { fx, logs, ops, standbyAlerts, generated } = stubEffects({
    tables: {
      webhook_events: {
        data: {
          raw_payload: {
            id: 'PAGE',
            standby: [{ sender: { id: 'PSID' }, timestamp: NOW.getTime(), message: { mid: 'm1', text: 'Сайн уу' } }],
          },
        },
      },
    },
  });
  const r = await run(fx);

  // 200, because a redelivery cannot change a Page setting.
  assert.equal(r.status, 200);
  assert.equal(r.body['refused'], 'standby_not_primary');
  assert.equal(generated.length, 0, 'no model call — we may not answer at all');
  assert.ok(reasons(logs).includes('standby_not_primary'));
  assert.equal(standbyAlerts.length, 1, 'the alert IS the output here');
  assert.equal(standbyAlerts[0]?.events, 1);
  // The STATE, not merely that a write happened. `processed` is precisely the reading
  // that hides this fault — the row would say the entry was handled and nothing anywhere
  // would disagree. `0001` anticipated `standby_not_primary` for exactly this.
  // The update that carries a STATE, not merely the first update on the table: since
  // D-110 every delivery also writes `attempts`, and `.find()` was picking that up. The
  // assertion always meant the state write, so it now says so.
  const marked = ops.filter((o) => o.table === 'webhook_events' && o.op === 'update')
    .find((o) => o.patch?.['state'] !== undefined);
  assert.equal(marked?.patch?.['state'], 'standby_not_primary');
});

test('the standby alert is keyed per channel per DAY', async () => {
  // A misconfigured Page produces standby on every message, so a bare channel key would
  // fire on all of them. A key with no period at all would go quiet for good the first
  // time somebody "fixed" it and it came back.
  const { fx, standbyAlerts } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: { id: 'P', standby: [{ sender: { id: 'X' } }] } } } },
  });
  await run(fx);
  assert.equal(standbyAlerts[0]?.dayKey, '2026-09-04');
  assert.ok(standbyAlerts[0]?.channelId);
});

test('DONE-TEST: THE STANDBY KEY IS THE TENANT\'S DAY, NOT UTC\'S', async () => {
  // This test asserted `NOW.toISOString().slice(0, 10)` and could not fail: NOW is 12:00
  // UTC, which is 20:00 the same date in Ulaanbaatar, so both conventions agreed. At 18:00
  // UTC they do not — it is 02:00 the next morning locally — and that eight-hour window is
  // where a once-a-day alert fires twice for one trading day.
  const late = new Date('2026-09-04T18:00:00Z');
  const { fx, standbyAlerts } = stubEffects({
    now: late,
    tables: { webhook_events: { data: { raw_payload: { id: 'P', standby: [{ sender: { id: 'X' } }] } } } },
  });
  await run(fx);
  assert.equal(standbyAlerts[0]?.dayKey, '2026-09-05', 'the tenant is already on the 5th');
  assert.notEqual(standbyAlerts[0]?.dayKey, late.toISOString().slice(0, 10));
});

test('DONE-TEST: A TENANT WITH NO TIMEZONE IS 503, NEVER A DEFAULTED CALENDAR', async () => {
  // The column is NOT NULL, so this is unreachable today. It is asserted because the
  // tempting `?? 'Asia/Ulaanbaatar'` is unreachable in exactly the same way, right up
  // until a select changes — and then it silently charges every tenant's reply to
  // somebody else's day. Undetermined refuses; a redelivery costs nothing.
  const { fx, logs } = stubEffects({
    tables: {
      tenants: [
        { data: { default_locale: 'mn-MN', prompt_cache_mode: '1h', max_reply_age_minutes: 30 }, error: null },
        { data: { live_revision_id: 'rev-1' }, error: null },
      ],
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 503);
  assert.ok(logs.some((l) => l.event === 'tenant_timezone_missing'), JSON.stringify(logs.map((l) => l.event)));
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

test('DONE-TEST: WHAT ANSWERED THIS CUSTOMER IS WRITTEN ON THE CUSTOMER\'S ROW', async () => {
  // `messages.answered_by`, `revision_id` and `prompt_hash` have existed since `0001` and
  // were written by NOTHING until 2026-09-14: `reception/deps.ts` carried a literal
  // `void answeredBy;`, and the revision and content hash never left `ReceptionContext`.
  //
  // Found while reading Matrix's first real mirror drafts. The cost was immediate rather
  // than theoretical — a republish was days away, and two drafts either side of a config
  // change would have been indistinguishable in the table, so the fourteen days could not
  // have answered "did that edit help", which is the whole question the mirror exists for.
  const { fx, ops } = stubEffects();
  const r = await run(fx);
  assert.equal(r.status, 200);

  const trace = ops.find((o) => o.table === 'messages' && o.op === 'update');
  assert.ok(trace, `no trace written: ${JSON.stringify(ops.map((o) => `${o.table}:${o.op}`))}`);
  assert.equal(trace?.patch?.['answered_by'], 'model');
  // The snapshot's own content_hash, not a recomputation: it names the exact compiled
  // prefix the model read, and it is the prompt-cache key.
  assert.equal(trace?.patch?.['prompt_hash'], 'h1');
  assert.ok(String(trace?.patch?.['revision_id'] ?? '') !== '', 'the revision that answered');
});

test('a trace that cannot be written LOGS and still answers the customer', async () => {
  // Best-effort by construction. The reply already exists when this runs, so a failure here
  // is evidence lost; refusing over it, or 503-ing into a retry that would re-drive an
  // already-drafted event, would cost the customer their answer instead. Same posture as
  // `flagQuality`, and the log line is what makes the loss visible.
  const { fx, logs } = stubEffects({
    tables: {
      // `messages` is touched three times in one run, and the order is the test: the
      // inbound insert, the history read, then the trace update. A two-entry queue made the
      // HISTORY read fail and the job 503'd before it ever reached the trace — which is the
      // positional-stub trap this file's own docstring warns about, earned again.
      messages: [
        { data: { id: 'msg-1' }, error: null },
        { data: [], error: null },
        { data: null, error: { message: 'connection reset' } },
      ],
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 200, 'the reply stands');
  assert.equal(r.body['drafted'], 1);
  assert.ok(logs.some((l) => l.event === 'trace_failed'), JSON.stringify(reasons(logs)));
});

test('DONE-TEST: replied_at IS WRITTEN, so the sweeper\'s filter means something', async () => {
  // `sweepStrandedEvents` filters `.is(\'replied_at\', null)` and the column was written by
  // nothing, so that filter could not exclude a single row. It was harmless only because the
  // `state` filter beside it carried the whole load — and it would have become load-bearing
  // the moment somebody trusted it while widening that list. An assertion that cannot fail,
  // sitting inside the sweep built to break a silence.
  const { fx, ops } = stubEffects();
  await run(fx);
  const processed = ops.filter((o) => o.table === 'webhook_events' && o.op === 'update')
    .find((o) => o.patch?.['state'] === 'processed');
  assert.ok(processed, 'the event is processed');
  assert.equal(processed?.patch?.['replied_at'], NOW.toISOString());
});

test('and an entry that answered NOBODY is processed WITHOUT replied_at', async () => {
  // The other half, and the reason this is not just `now` unconditionally: an echo, a read
  // receipt, or a channel that cannot generate produces no answer. "Seen and declined" and
  // "answered" must not be spelled the same way, which is the defect this column had.
  const { fx, ops } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: { id: '100000000000001', messaging: [] } }, error: null } },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  const processed = ops.filter((o) => o.table === 'webhook_events' && o.op === 'update')
    .find((o) => o.patch?.['state'] === 'processed');
  assert.ok(processed);
  assert.equal(processed?.patch?.['replied_at'], undefined, 'nothing was answered');
});

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
  // Track 4's 14-day mirror. Both systems see the traffic during it, so a shadow channel
  // that sent would give every Matrix customer two replies from one salon for two weeks.
  //
  // BY WHAT ROUTE both see it is an open question the repository has answered wrongly
  // twice — see `channel/delivery.ts`. It does not change what this test is about:
  // whichever way the events arrive, one sender is the point.
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

test('DONE-TEST: A CHANNEL THAT CANNOT SEND DOES NOT GENERATE — except the mirror', async () => {
  // `canDeliver` was consulted only after the reply existed, so every non-live mode paid a
  // model call for text nobody could receive. The case that costs real money is a halted
  // channel: `haltChannelOutbound` sets `delivery_mode = 'off'` on a Graph 190, so after a
  // token died every further message drafted into a channel that could not send.
  //
  // `shadow_routing` is the sharper one — its own description reads «nothing is generated
  // or sent», and it generated. The code and its documentation had disagreed since the
  // mode existed, and the only symptom was a bill.
  for (const mode of ['off', 'shadow_routing', 'unrecognised']) {
    const { fx, generated, logs } = stubEffects({
      tables: {
        tenant_channels: { data: { external_id: '1', delivery_mode: mode, graph_version_override: null } },
      },
    });
    const r = await run(fx);
    assert.equal(generated.length, 0, `${mode} must not reach the model`);
    assert.equal(r.body['drafted'], 0, mode);
    assert.equal(r.body['notGenerated'], 1, mode);
    assert.ok(reasons(logs).includes('not_generating'), mode);
  }
});

test('the customer message is still STORED for a channel that cannot send', async () => {
  // §3.4.5: persist everything, generate nothing. Losing the question would be far worse
  // than paying for an answer — a routing rehearsal that dropped inbound messages would be
  // rehearsing the wrong thing.
  const { fx, ops } = stubEffects({
    tables: {
      tenant_channels: { data: { external_id: '1', delivery_mode: 'off', graph_version_override: null } },
    },
  });
  await run(fx);
  assert.ok(ops.some((o) => o.table === 'messages'), 'the inbound message must be persisted');
  assert.equal(ops.some((o) => o.table === 'spend_reservations'), false, 'and no hold is taken');
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
  // THREE reads of `outbound_messages` now, not two, and the first belongs to somebody
  // else: since D-111 `readHistory` reads the assistant's own turns from this table, and
  // it runs BEFORE the claim. Leaving it out shifted the whole queue by one and handed the
  // claim the history's answer — the same silent off-by-one the `webhook_events` fixture
  // above documents, in a second table. A fixture whose order drifts is a test asserting
  // the stub rather than the code.
  //
  // 1. history (no prior assistant turns) · 2. claim's CAS matches nothing · 3. state says `sent`.
  const { fx, delivered, logs } = stubEffects({
    tables: { outbound_messages: [{ data: [] }, { data: null }, { data: { state: 'sent' } }] },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(delivered.length, 0);
  assert.ok(reasons(logs).includes('not_ours'));
});

test('an unreadable outbound row is 503, never a silent skip', async () => {
  // Split in two since D-111, because this table is now read by two different callers and
  // they refuse under different names. Collapsing them would let one regress unseen.
  //
  // The CLAIM's read: history answers cleanly first, then the claim cannot read.
  const claimBroken = stubEffects({
    tables: { outbound_messages: [{ data: [] }, { error: { message: 'reset' } }] },
  });
  const r = await run(claimBroken.fx);
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'worker.claim_unavailable');

  // The HISTORY's read, which comes first and fails closed for its own reason: an empty
  // assistant half is indistinguishable from the defect D-111 fixed, so a hiccup must not
  // quietly hand the model a transcript with no replies in it.
  const historyBroken = stubEffects({
    tables: { outbound_messages: { error: { message: 'reset' } } },
  });
  const h = await run(historyBroken.fx);
  assert.equal(h.status, 503);
  assert.equal(h.body['error'], 'worker.history_failed');
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

/** `recordInbound` loses the unique index, then reads the winner's row: a redelivery. */
const DUPLICATE_INBOUND: Reply[] = [
  { error: { code: '23505', message: 'duplicate key' } },
  { data: { id: 'msg-1' }, error: null },
];

test('a redelivery whose reply ALREADY EXISTS never generates a second one', async () => {
  // The idempotency that was always intended: a reply row under `in:<mid>` exists, so the
  // question has been answered and answering again would double-reply and double-bill.
  const { fx, generated, logs } = stubEffects({
    tables: {
      messages: DUPLICATE_INBOUND,
      outbound_messages: { data: { id: 'om-9', state: 'sent' }, error: null },
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(generated.length, 0);
  assert.equal(r.body['drafted'], 0);
  assert.equal(logs.find((l) => l.event === 'already_answered')?.fields?.['outboundId'], 'om-9');
});

test('DONE-TEST: a redelivery with NO reply row is ANSWERED, not skipped', async () => {
  // 2026-09-06, event 4. The first attempt persisted the customer's message and then died
  // at the spend guard; QStash retried; the retry saw the inbound row it had just written,
  // skipped, and marked the event `processed` — which no redelivery re-drives. The message
  // became permanently unanswerable and every status code was the intended one.
  //
  // The inbound row says a row exists. Only a reply says a reply happened.
  const { fx, generated, logs } = stubEffects({
    tables: {
      messages: DUPLICATE_INBOUND,
      outbound_messages: [
        { data: null, error: null },                                                   // no reply yet
        { data: { id: 'om-1', body: 'ХАРИУЛТ', state: 'draft', attempts: 0 }, error: null },
      ],
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(generated.length, 1, 'the customer gets an answer on the retry');
  assert.equal(r.body['drafted'], 1);
  assert.ok(logs.some((l) => l.event === 'redelivery_unanswered'), 'and it says so');
});

test('a redelivery whose reply lookup FAILS is 503 — neither skipped nor answered twice', async () => {
  const { fx, generated } = stubEffects({
    tables: {
      messages: DUPLICATE_INBOUND,
      outbound_messages: { data: null, error: { message: 'connection reset' } },
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 503);
  assert.equal(generated.length, 0, 'and nothing was generated on a guess');
});

test('DONE-TEST: a 503 refusal logs the DETAIL, not just the category', async () => {
  // `guard_unavailable` names a class. Without the detail, a one-line schema mismatch
  // between `db.rpc('reserve_spend')` and `app.reserve_spend` reads identically to a
  // database outage — which is exactly how 2026-09-06 was spent.
  const { fx, logs } = stubEffects({
    tables: { tenant_roles: { data: null, error: { message: 'permission denied' } } },
  });
  const r = await run(fx);
  assert.equal(r.status, 503);
  const refused = logs.find((l) => l.event === 'refused');
  assert.equal(refused?.fields?.['code'], 'guard_unavailable');
  assert.match(String(refused?.fields?.['detail']), /permission denied/);
});

// ---------------------------------------------------------------------------
// The captioned attachment, carried and counted. D-083.
// ---------------------------------------------------------------------------

test('A CAPTIONED PHOTOGRAPH REACHES THE GATE AS AN ATTACHMENT, AND IS COUNTED', async () => {
  // Before this the kinds were computed in `extract.ts` and dropped for any message that
  // had text, so the model was handed the caption alone and answered about a picture it
  // could not see and did not know existed.
  const { fx, generated, flags } = stubEffects({
    tables: {
      webhook_events: {
        data: { raw_payload: payload({ text: 'Ийм болгож болох уу?', attachments: [{ type: 'image', payload: { url: 'https://x/y' } }] }) },
      },
    },
  });
  const r = await run(fx);

  assert.equal(r.status, 200);
  assert.deepEqual(generated[0]?.customerAttachments, ['image'], 'the gate is told a picture is there');
  assert.equal(generated[0]?.customerSentPhoto, true, 'a captioned photograph is a photograph');
  const captioned = flags.find((f) => f.code === 'inbound_captioned_attachment');
  assert.ok(captioned, `expected the flag; got ${JSON.stringify(flags.map((f) => f.code))}`);
  assert.equal(captioned?.tenantId, TENANT, 'quality_flags.tenant_id is NOT NULL');
  assert.match(captioned?.detail ?? '', /image/);
});

test('a STICKER sent with text is not counted as a photograph', async () => {
  // D-070's lesson on the other side: Meta sends one sticker as TWO attachments and
  // declares the first `image`, so reading `type` alone turns every thumbs-up with a word
  // beside it into a lost sales enquiry in the morning report. Any sticker id means filler.
  const { fx, generated, flags } = stubEffects({
    tables: {
      webhook_events: {
        data: {
          raw_payload: payload({
            text: 'за',
            attachments: [
              { type: 'image', payload: { sticker_id: 369239263222822 } },
              { type: 'sticker', payload: { sticker_id: 369239263222822 } },
            ],
          }),
        },
      },
    },
  });
  const r = await run(fx);

  assert.equal(r.status, 200);
  assert.equal(flags.some((f) => f.code === 'inbound_captioned_attachment'), false, 'a thumbs-up is not a photograph');
  // The kinds still reach the gate — a tenant rule may legitimately want to see them.
  assert.ok((generated[0]?.customerAttachments ?? []).length > 0);
  assert.equal(generated[0]?.customerSentPhoto, false, 'and it is never answered as a photograph');
});

test('a photograph sent WITH a sticker is not answered as a photograph (any sticker id means filler)', async () => {
  // `attachmentKinds` already reports a sticker as «sticker», so «image» here is a real
  // image — but imageReply's rule is that ANY sticker id makes the message filler, and the
  // captioned path keeps the same rule rather than a second one.
  const { fx, generated } = stubEffects({
    tables: {
      webhook_events: {
        data: {
          raw_payload: payload({
            text: 'за',
            attachments: [
              { type: 'image', payload: { url: 'https://example.invalid/p.jpg' } },
              { type: 'sticker', payload: { sticker_id: 369239263222822 } },
            ],
          }),
        },
      },
    },
  });
  await run(fx);
  assert.ok(generated[0]?.customerAttachments.includes('image'));
  assert.equal(generated[0]?.customerSentPhoto, false);
});

test('an ordinary text message is neither flagged nor given attachments', async () => {
  const { fx, generated, flags } = stubEffects({});
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.deepEqual(generated[0]?.customerAttachments, []);
  assert.equal(generated[0]?.customerSentPhoto, false);
  assert.equal(flags.some((f) => f.code === 'inbound_captioned_attachment'), false);
});

// ── D-110: a failed delivery has to be visible, and countable ──────────────────────────

test('DONE-TEST: EVERY DELIVERY IS COUNTED, INCLUDING ONE THAT REFUSES', async () => {
  // `webhook_events.attempts` was written by nothing and read by nothing from `0001` until
  // 2026-09-21, which is why the stranded alert could only guess at delivery history and
  // guessed wrong: it told the founder event 266 was "never delivered to the worker" when
  // production logs show three deliveries. The count is taken on ARRIVAL, above every
  // refusal, so the case that matters — a run that dies inside its own error handling —
  // still leaves evidence that QStash delivered it.
  const { fx, ops } = stubEffects({
    tables: {
      webhook_events: { data: { raw_payload: { id: '100000000000001', messaging: [] }, attempts: 0 }, error: null },
    },
  });
  await run(fx);
  const counted = ops.filter((o) => o.table === 'webhook_events' && o.op === 'update')
    .find((o) => o.patch?.['attempts'] !== undefined);
  assert.equal(counted?.patch?.['attempts'], 1, 'the first delivery writes attempts = 1');
});

test('DONE-TEST: THE EXHAUSTION ALERT FIRES ON THE LAST DELIVERY AND NOT BEFORE', async () => {
  // The whole point of moving detection off the hourly sweep. A 503 means "retry me", and
  // on the final delivery the identical status means the opposite — nobody is coming. Only
  // this wrapper knows both facts at once.
  //
  // The refusal used here is the timezone one above: determinate, 503, and reached before
  // any model call, so the test exercises the wrapper rather than the reply path.
  const tenantRefusal = {
    tenants: [
      { data: { default_locale: 'mn-MN', prompt_cache_mode: '1h', max_reply_age_minutes: 30 }, error: null },
      { data: { live_revision_id: 'rev-1' }, error: null },
    ],
  };
  const atLimit = await stubEffects({
    tables: {
      ...tenantRefusal,
      webhook_events: {
        data: {
          raw_payload: { id: '100000000000001', messaging: [] },
          attempts: RECEPTION_MAX_DELIVERIES - 1,
          received_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
        },
        error: null,
      },
    },
  });
  const last = await run(atLimit.fx);
  assert.equal(last.status, 503);
  assert.equal(atLimit.exhausted.length, 1, 'the final delivery alerts');
  assert.equal(atLimit.exhausted[0]?.attempts, RECEPTION_MAX_DELIVERIES);
  assert.equal(atLimit.exhausted[0]?.limitMinutes, 30);
  assert.equal(Math.floor(atLimit.exhausted[0]?.ageMinutes ?? -1), 4, 'the age a human needs to judge it');

  // …and NOT on an earlier one, which is what keeps this off Telegram for every transient
  // 503 that the next retry fixes. CLAUDE.md is explicit that the alert chat is shared with
  // customers, so a false page here buries a real message.
  const earlier = await stubEffects({
    tables: {
      ...tenantRefusal,
      webhook_events: { data: { raw_payload: { id: '100000000000001', messaging: [] }, attempts: 0 }, error: null },
    },
  });
  assert.equal((await run(earlier.fx)).status, 503);
  assert.equal(earlier.exhausted.length, 0, 'a retry is still coming — say nothing');
});

test('DONE-TEST: A LIMIT THE JOB NEVER READ IS NULL, NOT THE PLATFORM DEFAULT', async () => {
  // `worker.tenant_unreadable` is a 503 that happens ABOVE the tenant's reply limit, so a
  // run exhausted on that path never learns the number. Pre-filling the trace with
  // `DEFAULT_REPLY_AGE_LIMIT_MINUTES` — which is what the first version did — prints 30 for
  // a tenant whose real limit is 15, in the generous direction, inside a critical alert
  // telling a human how long they have. That is this work's own defect reappearing in the
  // fix for it: an alert asserting something it had not measured.
  const { fx, exhausted } = stubEffects({
    tables: {
      tenants: { data: null, error: { message: 'timeout' } },
      webhook_events: {
        data: {
          raw_payload: { id: '100000000000001', messaging: [] },
          attempts: RECEPTION_MAX_DELIVERIES - 1,
          received_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
        },
        error: null,
      },
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 503);
  assert.equal(r.body['error'], 'worker.tenant_unreadable');
  assert.equal(exhausted.length, 1, 'still alerted — the customer is still unanswered');
  assert.equal(exhausted[0]?.limitMinutes, null, 'unknown is reported as unknown');
  assert.equal(exhausted[0]?.attempts, RECEPTION_MAX_DELIVERIES);
});

test('DONE-TEST: THE EXHAUSTION ALERT IS TOLD WHY, WHERE, AND WHO WROTE — NOT JUST A CODE', async () => {
  // Measured 2026-09-24: the founder received «last: worker.reception_retry» 29 times while
  // the real reason, `canned_stale`, sat in the log line beside it — and the alert could not
  // tell a shadow channel the incumbent had answered from a live customer left waiting,
  // because nothing told it the channel's mode or who had written. All three are carried
  // now, and each is what `worker/exhaustedAlert.ts` needs to decide whether to page.
  const stale = 'canned_stale: the canned lines have changed since this configuration was published';
  const { fx, exhausted } = stubEffects({
    generateReply: async () => ({ kind: 'retry', detail: stale }),
    tables: {
      webhook_events: {
        data: {
          raw_payload: payload(),
          attempts: RECEPTION_MAX_DELIVERIES - 1,
          received_at: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
        },
        error: null,
      },
      tenant_channels: {
        data: { external_id: '100000000000001', delivery_mode: 'shadow', meta_app_id: '1562862634970492' },
        error: null,
      },
    },
  });
  const r = await run(fx);
  assert.equal(r.body['error'], 'worker.reception_retry');
  assert.equal(exhausted.length, 1);
  const a = exhausted[0]!;
  assert.equal(a.detail, stale);
  assert.equal(a.deliveryMode, 'shadow');
  assert.equal(a.ourAppId, '1562862634970492');
  assert.equal(a.channelId, CHANNEL);
  assert.deepEqual(a.turns, [{ psid: PSID, sentAt: SENT_AT }], 'the customer, on Meta\'s clock');
});

test('a delivery that SUCCEEDS never alerts, however many attempts preceded it', async () => {
  // The recovery case: the matcher is fixed, the redelivery works. An alert here would
  // report a customer as unanswered at the moment they were answered.
  const { fx, exhausted } = stubEffects({
    tables: {
      webhook_events: {
        data: { raw_payload: { id: '100000000000001', messaging: [] }, attempts: RECEPTION_MAX_DELIVERIES + 5 },
        error: null,
      },
    },
  });
  assert.equal((await run(fx)).status, 200);
  assert.equal(exhausted.length, 0);
});

// ── The typing bubble, and the gate that keeps it off a mirrored Page ──────────────────

test('DONE-TEST: THE TYPING BUBBLE IS GATED ON deliver, NOT ON generate', async () => {
  // The mistake this is here to stop is one character wide and reaches a real person.
  //
  // A sender action is an OUTBOUND Graph call: the customer sees the bubble on the Page.
  // In `shadow` the platform generates and withholds, while the incumbent answers that
  // same Page — so a bubble gated on `generate` would appear in front of somebody else's
  // customer, promise a reply, and never produce one. `delivery.generate` is true in
  // shadow and `delivery.deliver` is not, which is the whole distinction.
  const shadow = await stubEffects({
    tables: { tenant_channels: { data: { id: 'ch-1', tenant_id: 't-1', external_id: '100000000000001', delivery_mode: 'shadow', token_status: 'active', status: 'active', app_slug: 'dalatech', meta_app_id: null } } },
  });
  await run(shadow.fx);
  assert.deepEqual(shadow.typed, [], 'a mirrored channel must stay invisible on the Page');
});

test('a live channel shows the bubble, once, before the reply', async () => {
  const { fx, typed, delivered } = stubEffects();
  await run(fx);
  assert.equal(typed.length, 1, 'exactly one bubble per customer message');
  assert.equal(typed[0]?.channelId, 'c-1');
  assert.ok(delivered.length >= 1, 'and the reply still goes out');
});

test('DONE-TEST: A MESSAGE THAT WILL NEVER BE ANSWERED SHOWS NO BUBBLE', async () => {
  // A bubble is a PROMISE of a reply, so it belongs below every exit that ends in silence.
  //
  // The first version of this feature sat above the freshness check, the history read and
  // the spend guard. An hour-old replay therefore showed a live customer «typing…» and
  // then produced nothing at all — the one outcome worse than the slow reply the bubble
  // was added to soften. Same shape as the guard whose trigger moved out from under it:
  // the code was right where it was written and wrong where it ran.
  const { fx, typed, delivered, logs } = stubEffects({
    tables: { webhook_events: { data: { raw_payload: payload({ ts: NOW.getTime() - 60 * 60_000 }) } } },
  });
  await run(fx);
  assert.ok(reasons(logs).includes('reply_too_late'), 'precondition: the message is stale');
  assert.equal(delivered.length, 0, 'precondition: nothing is sent');
  assert.deepEqual(typed, [], 'so nothing may have been promised either');
});

test('DONE-TEST: SHADOW STILL RECORDS HOW LONG THE MODEL TOOK', async () => {
  // The instrument skipped the only tenant anybody is asking about.
  //
  // `clock.lap('generate')` was placed after the `!delivery.deliver` early-continue, so a
  // shadow channel — which is Matrix, the mirror whose latency prompted this whole piece
  // of work — logged every phase EXCEPT the model call. The reader would have seen a
  // timing line that looked complete, summed to far less than the wall clock, and pointed
  // at the database. An instrument that omits the dominant phase for the tenant being
  // measured is worse than no instrument, because it is believed.
  const shadow = stubEffects({
    tables: { tenant_channels: { data: { id: 'ch-1', tenant_id: 't-1', external_id: '100000000000001', delivery_mode: 'shadow', token_status: 'active', status: 'active', app_slug: 'dalatech', meta_app_id: null } } },
  });
  await run(shadow.fx);
  assert.ok(reasons(shadow.logs).includes('not_delivering'), 'precondition: it drafted and withheld');
  const timing = shadow.logs.find((l) => l.event === 'reply_timing_ms');
  assert.ok(timing !== undefined, 'a shadow run still logs its timings');
  assert.equal(typeof timing.fields?.['generate'], 'number',
    `the model call is the point of the line: ${JSON.stringify(timing.fields)}`);
});

test('DONE-TEST: THE SPEND GUARD AND THE TRACE WRITE ARE NOT BILLED TO THE MODEL', async () => {
  // `generate` used to span the guard RPC, the model call and the trace write — three
  // round trips under one name, two of them the database. If the guard were the slow
  // thing in production, this log line would have sent the reader to the model. That is
  // precisely the "alerted with wrong information" failure, built into the instrument
  // meant to prevent it.
  const { fx, logs } = stubEffects();
  await run(fx);
  const timing = logs.find((l) => l.event === 'reply_timing_ms');
  assert.ok(timing !== undefined);
  for (const phase of ['guard', 'generate', 'trace']) {
    assert.equal(typeof timing.fields?.[phase], 'number',
      `${phase} must be its own phase: ${JSON.stringify(timing.fields)}`);
  }
});

test('DONE-TEST: A TYPING BUBBLE THAT THROWS NEVER COSTS THE CUSTOMER A REPLY', async () => {
  // It is not awaited, so a rejection here would be an unhandled rejection on a lambda
  // mid-reply rather than a handled failure. The worker catches it and carries on: a
  // decoration must never be able to take the reply down with it.
  const { fx, delivered, logs } = stubEffects();
  fx.showTyping = async () => { throw new Error('graph down'); };
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(delivered.length, 1, 'the reply is unaffected');
  assert.ok(reasons(logs).includes('typing_indicator_failed'), 'and the failure is visible');
});

test('a reply logs where its wall-clock went, and the phases do not overwrite each other', async () => {
  // The production gap this exists to close: the bake-off measures the model path at 3.7s
  // and production measured 25.8s from inbound row to draft. The harness stubs the
  // database and structurally cannot see the difference, so the answer has to come from a
  // real turn.
  //
  // The accumulation matters as much as the timing. One webhook entry can carry several
  // messages and the loop runs these phases once per message — assigning instead of adding
  // would report the LAST message's timings as if they were the whole job's, which is the
  // kind of number that looks precise and is wrong.
  const { fx, logs } = stubEffects();
  await run(fx);
  const timing = logs.find((l) => l.event === 'reply_timing_ms');
  assert.ok(timing !== undefined, `no timing line was logged: ${JSON.stringify(reasons(logs))}`);
  for (const phase of ['event_read', 'tenant_read', 'context_load', 'generate']) {
    assert.equal(typeof timing.fields?.[phase], 'number', `${phase} is missing from ${JSON.stringify(timing.fields)}`);
  }
  // It is diagnostic only: nothing branches on it, so it cannot change what a customer is told.
  assert.equal(timing.level, 'info');
});

test('DONE-TEST: THE LARGEST DATABASE PHASE REPORTS ITS TWO HALVES', async () => {
  // `context_load` was 533ms of the 1,667ms of database time on the first real turn after
  // the region pin — the largest single phase — and it is TWO stages that behave nothing
  // alike: one row by key, then ten queries issued together. One number over both cannot
  // say which dominates, so it cannot say whether there is anything to win.
  //
  // This is here because the alternative was reasoning about it, and reasoning about an
  // unmeasured phase is exactly what produced the `generate must not move` clause that
  // failed the same day. An instrument nobody has watched fire is the other half of that
  // mistake, so this asserts the fields ARRIVE rather than trusting that they will.
  const { fx, logs } = stubEffects();
  await run(fx);
  const timing = logs.find((l) => l.event === 'reply_timing_ms');
  assert.ok(timing !== undefined, `no timing line: ${JSON.stringify(reasons(logs))}`);
  for (const half of ['context_snapshot', 'context_batch']) {
    assert.equal(typeof timing.fields?.[half], 'number',
      `${half} missing from ${JSON.stringify(timing.fields)}`);
  }
  // The halves are bounded by the whole. A split that exceeds the phase it divides is not
  // a split, and would send a reader chasing a saving that does not exist.
  const whole = Number(timing.fields?.['context_load']);
  const snapshot = Number(timing.fields?.['context_snapshot']);
  const batch = Number(timing.fields?.['context_batch']);
  assert.ok(snapshot + batch <= whole + 1,
    `the halves (${snapshot} + ${batch}) exceed context_load (${whole})`);
});

// ---------------------------------------------------------------------------
// D-122: the comment switch is its own, and `off` never reaches the comment surface
// ---------------------------------------------------------------------------

const FEED_ENTRY = {
  id: '100000000000001',
  changes: [{ field: 'feed', value: {
    item: 'comment', verb: 'add', comment_id: '1_2', post_id: '100000000000001_1',
    from: { id: 'customer_9', name: 'Сараа' }, message: 'Үнэ хэд вэ?', created_time: Math.floor(NOW.getTime() / 1000) - 60,
  } }],
};

test('D-122: comments OFF on a DM-live channel never reach the comment surface', async () => {
  // The throwing comment stubs from `stubEffects` are the assertion: reaching any of them fails.
  const { fx } = stubEffects({
    tables: {
      webhook_events: { data: { raw_payload: FEED_ENTRY, attempts: 0, received_at: NOW.toISOString() } },
      tenant_channels: { data: {
        external_id: '100000000000001', delivery_mode: 'live', token_status: 'active',
        comment_policy: 'both', comment_delivery_mode: 'off', graph_version_override: null,
      } },
    },
  });
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(r.body['comments'], undefined);
});

test('D-122: comments in SHADOW run on a DM-live channel, and read the comment switch, not the DM one', async () => {
  const seen: string[] = [];
  const { fx } = stubEffects({
    tables: {
      webhook_events: { data: { raw_payload: FEED_ENTRY, attempts: 0, received_at: NOW.toISOString() } },
      tenant_channels: { data: {
        external_id: '100000000000001', delivery_mode: 'live', token_status: 'active',
        comment_policy: 'both', comment_delivery_mode: 'shadow', graph_version_override: null,
      } },
      comment_rules: { data: [{ rule_key: 'price', verdict: 'reply', matcher: { mode: 'has_word', words: ['үнэ'] } }], error: null },
    },
  });
  fx.lookupComment = async (a) => { seen.push(`lookup:${a.commentId}`); return { tagsPerson: false, postCreatedAt: NOW, problems: [] }; };
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.ok(r.body['comments'] !== undefined, 'the comment job ran');
  const comments = r.body['comments'] as { replied: number; privateSent: number };
  assert.equal(comments.replied, 0, 'shadow posts nothing, whatever the DM mode says');
  assert.equal(comments.privateSent, 0);
});

test('D-124: the reply never waits for its bubble; a bubble that lands late is cleared after it', async () => {
  // A reply that needs no model is ready before the bubble's own request returns. Waiting
  // for the bubble cost every such reply its round trip; not clearing it could hang
  // «typing…» under the answer. The reply goes first, then typing_off.
  const order: string[] = [];
  const { fx, logs } = stubEffects();
  const realDeliver = fx.deliver;
  fx.showTyping = async (a) => {
    if (a.action === 'typing_off') { order.push('typing_off'); return; }
    await new Promise((r) => setTimeout(r, 40));
    order.push('typing_on');
  };
  fx.deliver = async (a) => { order.push('deliver'); return realDeliver(a); };
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.deepEqual(order, ['deliver', 'typing_on', 'typing_off']);
  assert.ok(reasons(logs).includes('typing_cleared_after_reply'));
});

test('D-124: a bubble that landed before the reply is left alone — no typing_off', async () => {
  const order: string[] = [];
  const { fx, logs } = stubEffects();
  const realDeliver = fx.deliver;
  fx.showTyping = async (a) => { order.push(a.action ?? 'typing_on'); };
  // A model-like reply: the bubble has long landed by the time it is ready.
  const realGenerate = fx.generateReply;
  fx.generateReply = (async (...args: Parameters<typeof fx.generateReply>) => {
    await new Promise((r) => setTimeout(r, 20));
    return realGenerate(...args);
  }) as typeof fx.generateReply;
  fx.deliver = async (a) => { order.push('deliver'); return realDeliver(a); };
  await run(fx);
  assert.deepEqual(order, ['typing_on', 'deliver']);
  assert.ok(!reasons(logs).includes('typing_cleared_after_reply'));
});

test('D-124: a bubble that never answers never delays the reply, and the job still ends', async () => {
  const { fx, delivered } = stubEffects();
  let sentAt = 0;
  const realDeliver = fx.deliver;
  fx.deliver = async (a) => { sentAt = Date.now(); return realDeliver(a); };
  fx.showTyping = (a) => (a.action === 'typing_off' ? Promise.resolve() : new Promise<void>(() => {}));
  const t0 = Date.now();
  const r = await run(fx);
  assert.equal(r.status, 200);
  assert.equal(delivered.length, 1);
  assert.ok(sentAt - t0 < 500, `the reply waited ${sentAt - t0}ms for its bubble`);
  assert.ok(Date.now() - t0 < 2 * TYPING_WAIT_MS + 1_000, `the job took ${Date.now() - t0}ms`);
});
