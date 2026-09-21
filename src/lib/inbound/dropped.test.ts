import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DROPPED_FLAG, planDroppedFlags, recordDroppedInbound, skipSummary } from './dropped.ts';
import type { SkippedEvent } from '../meta/extract.ts';

const NOW = new Date('2026-09-14T12:27:47Z');

function skip(over: Partial<SkippedEvent> = {}): SkippedEvent {
  return {
    reason: 'no_text', idx: 0, externalId: 'm_thumb', senderId: 'psid-1', recipientId: null,
    appId: null, attachments: ['sticker'], stickerIds: ['369239263222822'], ...over,
  };
}

/**
 * A PostgREST-shaped fake. `inserted` is what the test asserts against; `flags` is what an
 * earlier attempt already wrote, which is how the retry cases are set up.
 */
function fakeDb(over: {
  flags?: unknown[]; flagsError?: { message: string };
  contact?: unknown; conversation?: unknown; insertError?: { message: string };
} = {}) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'contains', 'order', 'limit']) chain[m] = () => chain;
      chain['insert'] = (row: Record<string, unknown>) => {
        if (table === 'quality_flags' && over.insertError === undefined) inserted.push(row);
        return { then: (res: (v: unknown) => unknown) => res({ error: over.insertError ?? null }) };
      };
      chain['maybeSingle'] = () => ({
        then: (res: (v: unknown) => unknown) => res(
          table === 'contacts'
            ? { data: over.contact ?? null, error: null }
            : { data: over.conversation ?? null, error: null },
        ),
      });
      chain['then'] = (res: (v: unknown) => unknown) => res(
        table === 'quality_flags'
          ? { data: over.flags ?? [], error: over.flagsError ?? null }
          : { data: [], error: null },
      );
      return chain;
    },
  };
  return { db: db as never, inserted };
}

const base = { tenantId: 't-1', channelId: 'ch-1', eventId: 14, now: NOW };

// --- what gets a row -------------------------------------------------------

test('DONE-TEST: AN ECHO AND A RECEIPT ARE NOT A CUSTOMER DOING ANYTHING', () => {
  // Recording our own outbound coming back, and Meta's bookkeeping, would bury the skips
  // that matter under traffic nobody sent — which is the same digest-noise failure D-063
  // is about, rebuilt in a different table.
  assert.deepEqual(planDroppedFlags([skip({ reason: 'echo' }), skip({ reason: 'status_event' })]), []);
});

test('DONE-TEST: no_text, postback AND malformed are all a customer getting nothing', () => {
  // Leaving postback and malformed out would rebuild this exact blind spot one branch over
  // — D-062's "when you split a verdict, ask what the new branch is now collapsing".
  const planned = planDroppedFlags([
    skip({ reason: 'no_text', idx: 0 }),
    skip({ reason: 'postback', idx: 1 }),
    skip({ reason: 'malformed', idx: 2 }),
    skip({ reason: 'echo', idx: 3 }),
  ]);
  assert.deepEqual(planned.map((p) => p.reason), ['no_text', 'postback', 'malformed']);
});

// --- the row itself --------------------------------------------------------

test('the row carries the kind and the sticker id, so a reader can tell what it was', async () => {
  const { db, inserted } = fakeDb();
  const r = await recordDroppedInbound(db, { ...base, skipped: [skip()] });
  assert.equal(r.written, 1);
  assert.equal(inserted[0]?.['flag'], DROPPED_FLAG);
  assert.deepEqual(inserted[0]?.['detail'], {
    reason: 'no_text', event_id: 14, idx: 0, mid: 'm_thumb',
    attachments: ['sticker'], sticker_ids: ['369239263222822'],
  });
});

test('DONE-TEST: THE PSID IS NEVER COPIED INTO THE JSONB DETAIL', async () => {
  // `conversation_id` is the link, and it is already governed by the retention and
  // data-deletion paths that own customer identity. A PSID pasted into a jsonb blob is one
  // the deletion callback would never find.
  const { db, inserted } = fakeDb({ contact: { id: 'c-1' }, conversation: { id: 'conv-1' } });
  await recordDroppedInbound(db, { ...base, skipped: [skip()] });
  assert.doesNotMatch(JSON.stringify(inserted[0]?.['detail']), /psid-1/);
  assert.equal(inserted[0]?.['conversation_id'], 'conv-1');
});

test('with no existing conversation the row still lands, unattached', async () => {
  // A photo that arrives before any text has nothing to attach to, and null is the honest
  // answer. Losing the row instead would be the bug this file repairs.
  const { db, inserted } = fakeDb({ contact: null });
  const r = await recordDroppedInbound(db, { ...base, skipped: [skip()] });
  assert.equal(r.written, 1);
  assert.equal(inserted[0]?.['conversation_id'], null);
});

test('a malformed event with no sender is recorded without a conversation lookup', async () => {
  const { db, inserted } = fakeDb();
  await recordDroppedInbound(db, {
    ...base, skipped: [skip({ reason: 'malformed', senderId: null, externalId: null, attachments: [], stickerIds: [] })],
  });
  assert.deepEqual(inserted[0]?.['detail'], { reason: 'malformed', event_id: 14, idx: 0 });
});

// --- idempotence -----------------------------------------------------------

test('DONE-TEST: A QSTASH RETRY DOES NOT RECORD THE SAME LOSS TWICE', async () => {
  // `quality_flags` has no unique key and adding one is a migration the founder pushes, so
  // the identity is `(event_id, idx)` — both stable across a retry, and both present even
  // when Meta's mid is not. Without this the digest count drifts up on its own, and the
  // number a person reads is the whole deliverable.
  const { db, inserted } = fakeDb({ flags: [{ detail: { event_id: 14, idx: 0 } }] });
  const r = await recordDroppedInbound(db, { ...base, skipped: [skip({ idx: 0 }), skip({ idx: 1 })] });
  assert.equal(r.duplicate, 1);
  assert.equal(r.written, 1);
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0]?.['detail'] as Record<string, unknown>)['idx'], 1);
});

test('DONE-TEST: when the dedupe read FAILS the row is written and SAYS it is unverified', async () => {
  // Dropping it rebuilds the bug this file exists to fix; writing it silently lets a
  // duplicate pass as a distinct loss. Undetermined is a result, and it belongs in the row
  // rather than in a log nobody greps.
  const { db, inserted } = fakeDb({ flagsError: { message: 'connection reset' } });
  const r = await recordDroppedInbound(db, { ...base, skipped: [skip()] });
  assert.equal(r.written, 1);
  assert.equal((inserted[0]?.['detail'] as Record<string, unknown>)['dedupe'], 'unverified');
  assert.match(String(r.detail), /connection reset/);
});

test('a failed insert is COUNTED, never folded into silence', async () => {
  // "The recorder is broken" and "nothing was dropped" must not reach a reader as the same
  // silence. That equivalence is the entire defect being repaired.
  const { db } = fakeDb({ insertError: { message: 'permission denied' } });
  const r = await recordDroppedInbound(db, { ...base, skipped: [skip()] });
  assert.equal(r.failed, 1);
  assert.equal(r.written, 0);
  assert.match(String(r.detail), /permission denied/);
});

test('nothing worth recording touches the database at all', async () => {
  const { db, inserted } = fakeDb();
  const r = await recordDroppedInbound(db, { ...base, skipped: [skip({ reason: 'echo' })] });
  assert.deepEqual(r, { written: 0, duplicate: 0, failed: 0 });
  assert.equal(inserted.length, 0);
});

// --- what leaves the process ----------------------------------------------

test('DONE-TEST: the loggable summary carries counts and kinds, and NO PSID', () => {
  // `SkippedEvent` holds the PSID so a row can find its conversation. It must never reach
  // a log line — `contacts.external_id` is the one place it is governed.
  const summary = skipSummary([skip(), skip({ idx: 1, reason: 'echo', attachments: [] })]);
  assert.deepEqual(summary, { count: 2, byReason: { no_text: 1, echo: 1 }, kinds: ['sticker'] });
  assert.doesNotMatch(JSON.stringify(summary), /psid-1/);
});
