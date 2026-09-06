import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicationIdFor } from './qstash.ts';

/** The exact key the first real webhook built, from `webhook_events.dedup_key` row 1. */
const REAL_KEY = '863503883522801:0:311:dalatech';

test('REGRESSION: the id QStash refused contains no colon', async () => {
  // Production, 2026-09-06 01:17:26 UTC:
  //   [webhook] enqueue_failed { detail: '{"error":"DeduplicationId cannot contain \':\'"}' }
  // The route 500'd, Meta retried twice, and both retries were skipped as duplicates.
  const id = deduplicationIdFor('facebook_page', REAL_KEY);
  assert.equal(id.includes(':'), false);
  assert.match(id, /^[0-9a-f]{64}$/);
});

test('the same event always produces the same id — dedup depends on it', () => {
  assert.equal(
    deduplicationIdFor('facebook_page', REAL_KEY),
    deduplicationIdFor('facebook_page', REAL_KEY),
  );
});

test('a different event produces a different id, in every component', () => {
  const base = deduplicationIdFor('facebook_page', '863503883522801:0:311:dalatech');
  for (const other of [
    ['facebook_page', '863503883522801:1:311:dalatech'],   // next entry index
    ['facebook_page', '863503883522801:0:312:dalatech'],   // different body length
    ['facebook_page', '963503883522801:0:311:dalatech'],   // different page
    ['facebook_page', '863503883522801:0:311:dala_ai'],    // different app slug
    ['instagram', '863503883522801:0:311:dalatech'],       // different provider
  ] as const) {
    assert.notEqual(deduplicationIdFor(other[0], other[1]), base, other.join(' '));
  }
});

test('DONE-TEST: the OBVIOUS fix would have weakened the guarantee; this one does not', () => {
  // Swapping ':' for '-' is the one-character fix, and it silently merges two distinct
  // events: the parts are joined without escaping, so a separator that can also occur
  // inside a part makes the joined string ambiguous. Two different (provider, key) pairs,
  // one naive id — which is a dropped message, not a rejected request.
  const naive = (p: string, k: string) => `${p}:${k}`.replaceAll(':', '-');
  assert.equal(naive('facebook_page', 'a-b'), naive('facebook_page-a', 'b'), 'the collision is real');

  // The shipped function keeps them distinct, because it hashes the unambiguous original.
  assert.notEqual(
    deduplicationIdFor('facebook_page', 'a-b'),
    deduplicationIdFor('facebook_page-a', 'b'),
  );
});
