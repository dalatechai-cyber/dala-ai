import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_REPLY_WINDOW_MS, RATE_LIMIT_BACKOFF_MS, commentEntry, flattenComments, graphGetJson, mediaToRead,
  parsePollState, pollVerdict, runInstagramCommentPoll, type GraphRead, type PollEffects, type PollState,
} from './poll.ts';
import { extractInstagramComments } from '../meta/comments.ts';
import { dedupKeyForEntry } from '../webhook/identity.ts';
import type { EntryInput, EntryOutcome } from '../webhook/entry.ts';

const IG = '17841417491117031';
const CHANNEL = 'ig-channel';
const PAGE_CHANNEL = 'page-channel';
const TENANT = 't-0';
const NOW = new Date('2026-09-27T03:00:00Z');
const SINCE = new Date('2026-09-27T02:00:00Z');
const iso = (d: Date) => d.toISOString().replace('.000Z', '+0000');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

type Op = { table: string; kind: 'select' | 'update'; values?: unknown; filters: string[] };

/** A PostgREST stand-in: records every call, answers selects from `rows`. */
function stubDb(channelRow: Record<string, unknown> | null, opts: { selectError?: string } = {}) {
  const ops: Op[] = [];
  const db = {
    from(table: string) {
      const op: Op = { table, kind: 'select', filters: [] };
      ops.push(op);
      const chain: Record<string, unknown> = {
        select() { op.kind = 'select'; return chain; },
        update(values: unknown) { op.kind = 'update'; op.values = values; return chain; },
        eq(c: string, v: unknown) { op.filters.push(`eq ${c}=${String(v)}`); return chain; },
        neq(c: string, v: unknown) { op.filters.push(`neq ${c}=${String(v)}`); return chain; },
        not(c: string, o: string, v: unknown) { op.filters.push(`not ${c} ${o} ${String(v)}`); return chain; },
        or(expr: string) { op.filters.push(`or ${expr}`); return chain; },
        then(resolve: (r: unknown) => void) {
          if (op.kind === 'update') return resolve({ data: null, error: null });
          if (opts.selectError) return resolve({ data: null, error: { message: opts.selectError } });
          return resolve({ data: channelRow === null ? [] : [channelRow], error: null });
        },
      };
      return chain;
    },
  };
  return { db, ops };
}

function channel(state: PollState | null, over: Record<string, unknown> = {}) {
  return {
    id: CHANNEL, tenant_id: TENANT, external_id: IG, app_slug: 'dalatech', via_channel_id: PAGE_CHANNEL,
    graph_version_override: null, comment_poll_state: state, ...over,
  };
}

type GraphCall = { path: string; params: Record<string, string>; token: string };

function effects(opts: {
  row: Record<string, unknown> | null;
  graph: (call: GraphCall) => GraphRead;
  entry?: (input: EntryInput) => EntryOutcome;
  token?: { ok: true; token: string } | { ok: false; detail: string };
  clock?: () => number;
  signature?: boolean;
}) {
  const { db, ops } = stubDb(opts.row);
  const graphCalls: GraphCall[] = [];
  const entries: EntryInput[] = [];
  const tokenRefs: unknown[] = [];
  const fx: PollEffects = {
    db: db as unknown as PollEffects['db'],
    now: NOW,
    verifySignature: async () => opts.signature ?? true,
    graphVersionDefault: () => 'v21.0',
    loadToken: async (ref) => { tokenRefs.push(ref); return opts.token ?? { ok: true, token: 'TOKEN' }; },
    graphGet: async (call) => { graphCalls.push(call); return opts.graph(call); },
    handleEntry: async (input) => {
      entries.push(input);
      return opts.entry ? opts.entry(input) : { outcome: 'queued', eventId: entries.length, redelivery: false };
    },
    log: () => {},
    ...(opts.clock ? { clock: opts.clock } : {}),
  };
  const run = () => runInstagramCommentPoll(fx, { rawBody: '{}', signature: 'sig' });
  const stateWrites = () => ops.filter((o) => o.kind === 'update' && o.filters.includes(`eq id=${CHANNEL}`))
    .map((o) => (o.values as { comment_poll_state: PollState }).comment_poll_state);
  return { fx, ops, graphCalls, entries, tokenRefs, run, stateWrites };
}

const ok = (body: Record<string, unknown>): GraphRead => ({ ok: true, body });
const media = (...m: Array<[string, number]>) => ok({ data: m.map(([id, n]) => ({ id, timestamp: iso(minutesAgo(600)), comments_count: n })) });
const c = (id: string, text: string, at: Date, from: string | null = 'igsid_customer', extra: Record<string, unknown> = {}) => ({
  id, text, timestamp: iso(at), ...(from === null ? {} : { from: { id: from, username: `u_${from}` } }), ...extra,
});
const baseState = (counts: Record<string, number>): PollState => ({ since: SINCE.toISOString(), counts, lastError: null, backoffUntil: null });

// --- The signature --------------------------------------------------------------------

test('an unsigned call is refused before anything is read', async () => {
  const h = effects({ row: channel(null), graph: () => media(), signature: false });
  const r = await h.run();
  assert.equal(r.status, 401);
  assert.equal(h.ops.length, 0);
  assert.equal(h.graphCalls.length, 0);
});

// --- Never an old comment ---------------------------------------------------------------

test('the first poll sets the watermark and answers NOTHING, even with comments waiting', async () => {
  const h = effects({ row: channel(null), graph: (call) => call.path.endsWith('/media') ? media(['m1', 3], ['m2', 0]) : ok({ data: [c('x', '1', minutesAgo(1))] }) });
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.equal(h.entries.length, 0);
  assert.deepEqual(h.graphCalls.map((g) => g.path), [`${IG}/media`]);
  const [state] = h.stateWrites();
  assert.equal(state?.since, NOW.toISOString());
  assert.deepEqual(state?.counts, { m1: 3, m2: 0 });
});

test('a comment stamped before the watermark is never queued; one after it is', async () => {
  const h = effects({
    row: channel(baseState({ m1: 1 })),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 3]) : ok({
      data: [c('new', '1', minutesAgo(2)), c('before', '1', new Date(SINCE.getTime() - 1000)), c('older', '1', minutesAgo(600))],
    }),
  });
  await h.run();
  assert.deepEqual(h.entries.map((e) => (e.entry as { changes: Array<{ value: { id: string } }> }).changes[0]?.value.id), ['new']);
});

test('nothing older than the 7-day private-reply window is queued, whatever the watermark says', async () => {
  const longAgo = new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000);
  const h = effects({
    row: channel({ ...baseState({ m1: 0 }), since: longAgo.toISOString() }),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 2]) : ok({
      data: [c('eight_days', '1', new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000)), c('fresh', '1', minutesAgo(1))],
    }),
  });
  await h.run();
  assert.equal(h.entries.length, 1);
  assert.equal(pollVerdict({ id: 'x', text: '1', timestamp: new Date(NOW.getTime() - PRIVATE_REPLY_WINDOW_MS - 1), fromId: 'a', fromUsername: null, parentId: null, user: null },
    { accountId: IG, since: longAgo, now: NOW }), 'old');
});

test('turning the comment switch off clears the watermark, so turning it on answers nothing from the gap', async () => {
  const h = effects({ row: null, graph: () => media() });
  await h.run();
  const clear = h.ops.find((o) => o.kind === 'update' && (o.values as Record<string, unknown>)['comment_poll_state'] === null);
  assert.ok(clear, 'the clear is issued on every run');
  assert.deepEqual(clear.filters, [
    'eq provider=instagram', 'not comment_poll_state is null', 'or comment_delivery_mode.eq.off,comment_policy.eq.none',
  ]);
  const read = h.ops.find((o) => o.kind === 'select');
  assert.deepEqual(read?.filters, ['eq provider=instagram', 'neq comment_delivery_mode=off', 'neq comment_policy=none']);
});

// --- Same rules as the webhook -------------------------------------------------------------

test('our own comments are never queued: by account id, or by Graph\'s `user` field', async () => {
  const h = effects({
    row: channel(baseState({ m1: 0 })),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 3]) : ok({
      data: [c('self', 'Сайн байна уу!', minutesAgo(1), IG), c('user', '1', minutesAgo(1), 'x', { user: { id: IG } }), c('cust', '1', minutesAgo(1))],
    }),
  });
  const r = await h.run();
  assert.equal(h.entries.length, 1);
  assert.equal(r.body['ours'], 2);
});

test('a comment with no `from` cannot be held to one-per-person and is skipped, counted', async () => {
  const h = effects({
    row: channel(baseState({ m1: 0 })),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 1]) : ok({ data: [c('anon', '1', minutesAgo(1), null)] }),
  });
  const r = await h.run();
  assert.equal(h.entries.length, 0);
  assert.equal(r.body['noFrom'], 1);
});

test('a queued comment goes through the webhook\'s own claim, as instagram, index 0, the channel slug, source poll', async () => {
  const h = effects({
    row: channel(baseState({ m1: 0 })),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 2]) : ok({
      data: [{ ...c('top', 'Сайн уу', minutesAgo(5)), replies: { data: [c('reply', '1', minutesAgo(1), 'igsid_2')] } }],
    }),
  });
  await h.run();
  assert.equal(h.entries.length, 2);
  const reply = h.entries[1] as EntryInput;
  assert.equal(reply.provider, 'instagram');
  assert.equal(reply.index, 0);
  assert.equal(reply.matchedAppSlug, 'dalatech');
  assert.equal(reply.source, 'poll');
  assert.deepEqual(reply.entry, {
    id: IG, time: Math.floor(minutesAgo(1).getTime() / 1000),
    changes: [{ field: 'comments', value: { id: 'reply', text: '1', parent_id: 'top', from: { id: 'igsid_2', username: 'u_igsid_2' }, media: { id: 'm1' } } }],
  });
});

test('the polled entry reads exactly as D-145\'s extractor reads a webhook: the comment\'s own time, thread, person', () => {
  const at = minutesAgo(3);
  const entry = commentEntry(IG, 'm1', { id: 'c9', text: ' 1 ', timestamp: at, fromId: 'igsid_9', fromUsername: 'bold', parentId: null, user: null });
  const { comments, skipped } = extractInstagramComments(entry, IG);
  assert.deepEqual(skipped, []);
  assert.equal(comments.length, 1);
  const got = comments[0]!;
  assert.equal(got.commentId, 'c9');
  assert.equal(got.postId, 'm1');
  assert.equal(got.fromId, 'igsid_9');
  assert.equal(got.threadId, 'c9');
  assert.equal(got.createdAt.getTime(), Math.floor(at.getTime() / 1000) * 1000);
});

// --- Never twice ---------------------------------------------------------------------------

test('a webhook for the same comment after App Review has the SAME event key as the polled row', () => {
  const at = minutesAgo(3);
  const polled = commentEntry(IG, 'm1', { id: '17865799348089039', text: '1', timestamp: at, fromId: 'igsid_9', fromUsername: 'bold', parentId: null, user: null });
  // Meta's own shape: a later `time`, extra media fields, the `comments` field (webhook_events 883).
  const pushed = {
    id: IG, time: Math.floor(NOW.getTime() / 1000),
    changes: [{ field: 'comments', value: { id: '17865799348089039', from: { id: 'igsid_9', username: 'bold' }, text: '1', media: { id: 'm1', media_product_type: 'FEED' } } }],
  };
  const key = (entry: unknown) => dedupKeyForEntry({ externalId: IG, index: 0, entry, matchedAppSlug: 'dalatech' });
  assert.equal(key(polled), key(pushed));
});

test('an unchanged post costs no comment read and queues nothing', async () => {
  const h = effects({ row: channel(baseState({ m1: 4, m2: 0 })), graph: () => media(['m1', 4], ['m2', 0]) });
  await h.run();
  assert.deepEqual(h.graphCalls.map((g) => g.path), [`${IG}/media`]);
  assert.equal(h.entries.length, 0);
  assert.deepEqual(h.stateWrites()[0]?.counts, { m1: 4, m2: 0 });
});

test('a count that went DOWN (a deletion) is recorded without a read', async () => {
  const h = effects({ row: channel(baseState({ m1: 5 })), graph: () => media(['m1', 3]) });
  await h.run();
  assert.equal(h.graphCalls.length, 1);
  assert.deepEqual(h.stateWrites()[0]?.counts, { m1: 3 });
});

test('a post whose comments could not all be queued keeps its OLD count, so the next run reads it again', async () => {
  const h = effects({
    row: channel(baseState({ m1: 0, m2: 0 })),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 1], ['m2', 1])
      : ok({ data: [c(call.path.startsWith('m1') ? 'a' : 'b', '1', minutesAgo(1))] }),
    entry: (input) => (input.entry as { changes: Array<{ value: { id: string } }> }).changes[0]?.value.id === 'a'
      ? { outcome: 'enqueue_failed', eventId: 1, detail: 'qstash down' }
      : { outcome: 'queued', eventId: 2, redelivery: false },
  });
  await h.run();
  const state = h.stateWrites()[0];
  assert.deepEqual(state?.counts, { m1: 0, m2: 1 });
  assert.match(String(state?.lastError), /enqueue_failed/);
});

test('a comment already queued (read again after a later comment) is not a failure and advances the count', async () => {
  const h = effects({
    row: channel(baseState({ m1: 1 })),
    graph: (call) => call.path.endsWith('/media') ? media(['m1', 2]) : ok({ data: [c('new', '1', minutesAgo(1)), c('seen', '1', minutesAgo(3))] }),
    entry: (input) => (input.entry as { changes: Array<{ value: { id: string } }> }).changes[0]?.value.id === 'seen'
      ? { outcome: 'already_queued', eventId: 7, state: 'processed' } : { outcome: 'queued', eventId: 8, redelivery: false },
  });
  const r = await h.run();
  assert.equal(r.body['alreadyQueued'], 1);
  assert.deepEqual(h.stateWrites()[0]?.counts, { m1: 2 });
  assert.equal(h.stateWrites()[0]?.lastError, null);
});

// --- Cheap, and inside Meta's limits ---------------------------------------------------------

test('the token is the connected Page channel\'s, loaded per run', async () => {
  const h = effects({ row: channel(baseState({})), graph: () => media() });
  await h.run();
  assert.deepEqual(h.tokenRefs, [{ tenantId: TENANT, channelId: PAGE_CHANNEL }]);
  assert.equal(h.graphCalls[0]?.token, 'TOKEN');
});

test('a rate-limit code backs the channel off; a run inside the back-off makes no Graph call', async () => {
  const h = effects({ row: channel(baseState({ m1: 0 })), graph: () => ({ ok: false, code: 80002, detail: 'graph 400 code=80002' }) });
  await h.run();
  const state = h.stateWrites()[0];
  assert.equal(state?.backoffUntil, new Date(NOW.getTime() + RATE_LIMIT_BACKOFF_MS).toISOString());
  assert.deepEqual(state?.counts, { m1: 0 });

  const again = effects({ row: channel(state ?? null), graph: () => media(['m1', 9]) });
  const r = await again.run();
  assert.equal(again.graphCalls.length, 0);
  assert.equal(r.body['backedOff'], 1);
});

test('an unloadable token makes no Graph call and records the error', async () => {
  const h = effects({ row: channel(baseState({ m1: 0 })), graph: () => media(), token: { ok: false, detail: 'secret_revoked' } });
  await h.run();
  assert.equal(h.graphCalls.length, 0);
  assert.match(String(h.stateWrites()[0]?.lastError), /secret_revoked/);
});

test('a channel that never baselined stays unbaselined when its first poll fails', async () => {
  const h = effects({ row: channel(null), graph: () => ({ ok: false, code: 10, detail: 'graph 403 code=10' }) });
  await h.run();
  assert.equal(h.stateWrites().length, 0);
});

test('the run stops starting reads once its time budget is spent', async () => {
  let t = 0;
  const h = effects({
    row: channel(baseState({ m1: 0, m2: 0 })),
    graph: (call) => { t += 30_000; return call.path.endsWith('/media') ? media(['m1', 1], ['m2', 1]) : ok({ data: [] }); },
    clock: () => t,
  });
  await h.run();
  // media read (30 s), m1 read (60 s > 40 s budget), m2 never started.
  assert.deepEqual(h.graphCalls.map((g) => g.path), [`${IG}/media`, 'm1/comments']);
  assert.deepEqual(h.stateWrites()[0]?.counts, { m1: 1, m2: 0 });
});

test('an unreadable channel list is a 503, so QStash retries', async () => {
  const { db } = stubDb(null, { selectError: 'down' });
  const fx = effects({ row: null, graph: () => media() }).fx;
  const r = await runInstagramCommentPoll({ ...fx, db: db as unknown as PollEffects['db'] }, { rawBody: '{}', signature: 's' });
  assert.equal(r.status, 503);
});

// --- Helpers ---------------------------------------------------------------------------------

test('parsePollState refuses a state with no usable watermark', () => {
  assert.equal(parsePollState(null), null);
  assert.equal(parsePollState({ counts: {} }), null);
  assert.equal(parsePollState({ since: 'nope' }), null);
  assert.deepEqual(parsePollState({ since: SINCE.toISOString(), counts: { a: 1, b: 'x' } })?.counts, { a: 1 });
});

test('mediaToRead picks only posts whose count went up, a new post counting from zero', () => {
  assert.deepEqual(mediaToRead([{ id: 'a', commentsCount: 2 }, { id: 'b', commentsCount: 1 }, { id: 'c', commentsCount: 0 }], { a: 2, b: 0 })
    .map((m) => m.id), ['b']);
});

test('flattenComments takes nested replies and gives each its parent', () => {
  const got = flattenComments({ data: [{ id: 't', text: 'a', timestamp: iso(NOW), replies: { data: [{ id: 'r', text: '1', timestamp: iso(NOW) }] } }] });
  assert.deepEqual(got.map((x) => [x.id, x.parentId]), [['t', null], ['r', 't']]);
});

test('graphGetJson puts the token in the header, never the URL, and carries the code but not Meta\'s message', async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get('authorization') };
    return new Response(JSON.stringify({ error: { code: 190, message: 'token SECRET is invalid' } }), { status: 400 });
  }) as unknown as typeof fetch;
  const r = await graphGetJson({ graphVersion: 'v21.0', path: `${IG}/media`, params: { fields: 'id' }, token: 'SECRET' }, fake);
  assert.deepEqual(r, { ok: false, code: 190, detail: 'graph 400 code=190' });
  assert.equal(seen!.auth, 'Bearer SECRET');
  assert.ok(!seen!.url.includes('SECRET'));
  assert.equal(seen!.url, `https://graph.facebook.com/v21.0/${IG}/media?fields=id`);
});
