import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLiveSnapshot, publishNeeded, publishRevision, rollbackTo } from './publish.ts';
import type { LoadOutcome } from './publish.ts';
import type { Rendered } from './render.ts';

const RENDERED: Rendered = {
  promptStable: 'compiled prefix',
  promptGate: 'gate blocks only',
  contentHash: 'abc123',
  promptChars: 15,
  allowedNumbers: ['33,000'],
  order: ['gate_scaffold'],
};

/** Records the order of writes, because for publish the ORDER is the correctness property. */
function stubDb(opts: {
  revisionRow?: unknown; revisionError?: unknown;
  snapshotError?: unknown; updateError?: unknown; pointerError?: unknown;
  snapshotRow?: unknown; tenantRow?: unknown; tenantError?: unknown;
} = {}) {
  const ops: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const from = (name: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'order', 'limit']) chain[m] = () => chain;
    // The snapshot insert takes an ARRAY — one row per channel — so flatten rather than
    // pushing the argument, or a payload check reads `undefined` and passes vacuously.
    chain['insert'] = (row: Record<string, unknown> | Record<string, unknown>[]) => {
      ops.push(`insert:${name}`);
      inserted.push(...(Array.isArray(row) ? row : [row]));
      return chain;
    };
    chain['update'] = () => { ops.push(`update:${name}`); return chain; };
    // `??` would swallow an EXPLICIT null, which is precisely the case several of these
    // tests set up — "the row is absent" is a different fact from "the caller said
    // nothing". Presence of the key is the test, not truthiness of the value.
    const given = <T,>(key: string, fallback: T): T => (key in opts ? (opts as Record<string, T>)[key] as T : fallback);
    chain['maybeSingle'] = async () => {
      if (name === 'config_revisions') return { data: given('revisionRow', { status: 'draft' } as unknown), error: opts.revisionError ?? null };
      if (name === 'config_snapshots') return { data: given('snapshotRow', { content_hash: 'abc123', prompt_stable: 'p', allowed_numbers: ['33,000'] } as unknown), error: null };
      if (name === 'tenants') return { data: given('tenantRow', { live_revision_id: 'rev-1' } as unknown), error: opts.tenantError ?? null };
      return { data: null, error: null };
    };
    chain['then'] = (res: (v: unknown) => unknown) => {
      const last = ops[ops.length - 1] ?? '';
      if (last === 'insert:config_snapshots') return res({ error: opts.snapshotError ?? null });
      if (last === 'update:config_revisions') return res({ error: opts.updateError ?? null });
      if (last === 'update:tenants') return res({ error: opts.pointerError ?? null });
      return res({ error: null });
    };
    return chain;
  };
  return { ops, inserted, db: { from } as never };
}

const base = {
  tenantId: 't-1', revisionId: 'rev-2',
  snapshots: [{ channel: 'facebook_page', rendered: RENDERED }],
  now: new Date('2026-09-04T00:00:00Z'),
};

test('DONE-TEST: publishing is one insert and a pointer move', () => {
  return publishRevision(stubDb().db, base).then(async (r) => {
    assert.equal(r.ok, true);
  });
});

test('THE ORDER: the snapshot is inserted BEFORE the pointer moves', async () => {
  // If the pointer moved first there would be a window in which live_revision_id names a
  // revision with no snapshot. Reception would find nothing to render and 503 — for every
  // customer of that tenant, for as long as the window lasted.
  const { db, ops } = stubDb();
  await publishRevision(db, base);
  assert.deepEqual(ops, [
    'insert:config_snapshots',
    'update:config_revisions',   // mark published
    'update:config_revisions',   // supersede the outgoing one
    'update:tenants',            // the pointer move, last
  ]);
});

test('a failed snapshot insert never moves the pointer', async () => {
  const { db, ops } = stubDb({ snapshotError: { message: 'duplicate key' } });
  const r = await publishRevision(db, base);
  assert.equal(r.ok, false);
  assert.equal(ops.includes('update:tenants'), false, 'a partially published config looks live');
});

test('a revision that is not a draft is refused', async () => {
  const { db } = stubDb({ revisionRow: { status: 'published' } });
  const r = await publishRevision(db, base);
  assert.equal(!r.ok && r.code, 'not_draft');
});

test('a revision belonging to nobody is refused', async () => {
  const { db } = stubDb({ revisionRow: null });
  const r = await publishRevision(db, base);
  assert.equal(!r.ok && r.code, 'not_draft');
});

test('publishing with no snapshots is refused before anything is read', async () => {
  const { db, ops } = stubDb();
  const r = await publishRevision(db, { ...base, snapshots: [] });
  assert.equal(!r.ok && r.code, 'no_snapshot');
  assert.deepEqual(ops, []);
});

test('an unreadable config_revisions refuses — it never assumes draft', async () => {
  const { db } = stubDb({ revisionError: { message: 'connection reset' } });
  const r = await publishRevision(db, base);
  assert.equal(!r.ok && r.code, 'publish_failed');
});

// ---------------------------------------------------------------------------
// Rollback.
// ---------------------------------------------------------------------------

test('DONE-TEST: rollback is one UPDATE, and re-renders nothing', async () => {
  const { db, ops } = stubDb();
  const r = await rollbackTo(db, { tenantId: 't-1', revisionId: 'rev-1', channels: ['facebook_page'] });
  assert.equal(r.ok, true);
  assert.deepEqual(ops, ['update:tenants'], 'exactly one write, and no compile');
});

test('rolling back to a revision with no snapshot is REFUSED', async () => {
  // A rollback is by definition something done in a hurry, when something is already
  // wrong. It must not be able to make it worse by pointing at a revision that cannot
  // render — which would 503 every conversation for that tenant.
  const { db, ops } = stubDb({ snapshotRow: null });
  const r = await rollbackTo(db, { tenantId: 't-1', revisionId: 'rev-0', channels: ['facebook_page'] });
  assert.equal(!r.ok && r.code, 'no_snapshot');
  assert.deepEqual(ops, [], 'the pointer never moved');
});

test('every channel is checked, not just the first', async () => {
  const { db } = stubDb({ snapshotRow: null });
  const r = await rollbackTo(db, { tenantId: 't-1', revisionId: 'rev-0', channels: ['facebook_page', 'instagram'] });
  assert.equal(!r.ok && r.detail.includes('facebook_page'), true);
});

// ---------------------------------------------------------------------------
// Reading the live snapshot.
// ---------------------------------------------------------------------------

test('the live snapshot is read through the pointer', async () => {
  const r = await loadLiveSnapshot(stubDb().db, { tenantId: 't-1', channel: 'facebook_page' });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.snapshot.revisionId, 'rev-1');
  assert.deepEqual(r.ok && r.snapshot.allowedNumbers, ['33,000']);
});

test('DONE-TEST: THE CANNED HASH IS WRITTEN ONTO THE SNAPSHOT THAT CARRIES THE SECTION', async () => {
  // D-058. The prefix now contains the tenant's canned lines, so the snapshot has to carry
  // their identity — otherwise a request has no way to tell whether the rows it reads are
  // the rows the model was given, and the divergence is silent by construction.
  const { inserted } = stubDb();
  const s = stubDb();
  await publishRevision(s.db, {
    ...base,
    snapshots: [{ channel: 'facebook_page', rendered: RENDERED, cannedHash: 'deadbeef' }],
  });
  assert.equal(s.inserted.find((r) => 'content_hash' in r)?.['canned_hash'], 'deadbeef');
  assert.equal(inserted.length, 0);
});

test('a snapshot published without one writes NULL, not an empty string', async () => {
  // Null is the marker for "this prefix predates D-058" and the reply path branches on it.
  // '' would be a claim that the prefix contains a section whose body hashes to nothing.
  const s = stubDb();
  await publishRevision(s.db, base);
  assert.equal(s.inserted.find((r) => 'content_hash' in r)?.['canned_hash'], null);
});

test('a snapshot row with no canned_hash loads as null, and one with a hash loads as the hash', async () => {
  const older = await loadLiveSnapshot(stubDb().db, { tenantId: 't-1', channel: 'facebook_page' });
  assert.equal(older.ok && older.snapshot.cannedHash, null);

  const newer = await loadLiveSnapshot(stubDb({
    snapshotRow: { content_hash: 'abc123', prompt_stable: 'p', allowed_numbers: [], canned_hash: 'f00d' },
  }).db, { tenantId: 't-1', channel: 'facebook_page' });
  assert.equal(newer.ok && newer.snapshot.cannedHash, 'f00d');
});

test('a tenant with no live revision REFUSES — there are no defaults to fall back to', async () => {
  // Inventing one would be a bot answering with a prompt nobody approved.
  const r = await loadLiveSnapshot(stubDb({ tenantRow: { live_revision_id: null } }).db, {
    tenantId: 't-1', channel: 'facebook_page',
  });
  assert.equal(!r.ok && r.code, 'no_live_revision');
});

test('an unreadable tenants row refuses rather than guessing', async () => {
  const r = await loadLiveSnapshot(stubDb({ tenantError: { message: 'timeout' } }).db, {
    tenantId: 't-1', channel: 'facebook_page',
  });
  assert.equal(!r.ok && r.code, 'unavailable');
});

test('a missing snapshot for the channel refuses', async () => {
  const r = await loadLiveSnapshot(stubDb({ snapshotRow: null }).db, { tenantId: 't-1', channel: 'instagram' });
  assert.equal(!r.ok && r.code, 'no_snapshot');
});

// ---------------------------------------------------------------------------
// D-142: a publish is judged over every channel, not the first one
// ---------------------------------------------------------------------------

const snap = (channel: string, contentHash: string, cannedHash: string | null = 'c1') => ({
  ok: true as const,
  snapshot: { revisionId: 'r', channel, contentHash, promptStable: '', allowedNumbers: [], cannedHash, promptGate: null },
});
const noSnap = { ok: false as const, code: 'no_snapshot' as const, detail: 'no snapshot for channel instagram' };
const COMPILED = { contentHash: 'h1', cannedHash: 'c1' };

test('DONE-TEST: A NEW CHANNEL WITH NO SNAPSHOT NEEDS A PUBLISH, even when the others are identical', () => {
  // Measured 2026-09-26: tenant #0 had snapshots for facebook_page and web; its new Instagram
  // channel had none, and the command said «Nothing to publish».
  const live = new Map<string, LoadOutcome>([['facebook_page', snap('facebook_page', 'h1')], ['web', snap('web', 'h1')], ['instagram', noSnap]]);
  assert.deepEqual(publishNeeded(['facebook_page', 'web', 'instagram'], live, COMPILED),
    { needed: true, missing: ['instagram'], changed: [] });
  // The order of the channel list does not matter: first or last, it is found.
  assert.deepEqual(publishNeeded(['instagram', 'facebook_page'], live, COMPILED),
    { needed: true, missing: ['instagram'], changed: [] });
});

test('every channel identical is the only "nothing to publish"', () => {
  const live = new Map([['facebook_page', snap('facebook_page', 'h1')], ['web', snap('web', 'h1')]]);
  assert.deepEqual(publishNeeded(['facebook_page', 'web'], live, COMPILED), { needed: false });
});

test('a changed prefix, a changed canned hash, or no live revision at all each need a publish', () => {
  assert.deepEqual(publishNeeded(['facebook_page'], new Map([['facebook_page', snap('facebook_page', 'h0')]]), COMPILED),
    { needed: true, missing: [], changed: ['facebook_page'] });
  assert.deepEqual(publishNeeded(['facebook_page'], new Map([['facebook_page', snap('facebook_page', 'h1', null)]]), COMPILED),
    { needed: true, missing: [], changed: ['facebook_page'] });
  const none = { ok: false as const, code: 'no_live_revision' as const, detail: '' };
  assert.deepEqual(publishNeeded(['facebook_page'], new Map([['facebook_page', none]]), COMPILED),
    { needed: true, missing: ['facebook_page'], changed: [] });
});
