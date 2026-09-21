import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkippedEvent } from '../meta/extract.ts';
import { imageReplyDedupKey, planImageReplies } from './imageReply.ts';

const skip = (o: Partial<SkippedEvent>): SkippedEvent => ({
  reason: 'no_text', idx: 0, externalId: 'm_1', senderId: 'psid_1', recipientId: null,
  appId: null, attachments: [], stickerIds: [], ...o,
});

test('DONE-TEST: A THUMBS-UP IS NEVER ANSWERED, WHATEVER ITS TYPE SAYS', () => {
  // Meta sends one sticker as TWO attachments and declares the first `image` (D-070), so
  // `type` alone reports a photograph when none arrived. A bot that says «I cannot see
  // pictures» to every thumbs-up is worse than one that says nothing, and the sticker_id
  // in the PAYLOAD is the only field that tells them apart.
  const thumbsUp = skip({ attachments: ['image', 'sticker'], stickerIds: ['369239263222822'] });
  assert.deepEqual(planImageReplies([thumbsUp]), []);

  // Exactly the shape of the real drop on 2026-09-15 11:37:13.
  assert.deepEqual(planImageReplies([skip({ attachments: ['sticker'], stickerIds: ['369239263222822'] })]), []);
});

test('DONE-TEST: A REAL PHOTOGRAPH IS ANSWERED', () => {
  // The shape of all four lost photographs: an image, and no sticker_ids at all.
  const photo = skip({ idx: 2, attachments: ['image'], stickerIds: [] });
  assert.deepEqual(planImageReplies([photo]), [{ idx: 2, senderId: 'psid_1' }]);
});

test('one reply per sender per entry — a burst is not three answers', () => {
  // Meta can batch several messages from one person into a single entry.messaging.
  const burst = [
    skip({ idx: 0, attachments: ['image'] }),
    skip({ idx: 1, attachments: ['image'] }),
    skip({ idx: 2, attachments: ['image'] }),
  ];
  assert.deepEqual(planImageReplies(burst), [{ idx: 0, senderId: 'psid_1' }]);
});

test('two different people in one entry are both answered', () => {
  const two = [
    skip({ idx: 0, attachments: ['image'], senderId: 'psid_a' }),
    skip({ idx: 1, attachments: ['image'], senderId: 'psid_b' }),
  ];
  assert.deepEqual(planImageReplies(two).map((p) => p.senderId), ['psid_a', 'psid_b']);
});

test('only a text-less attachment — never a postback, echo or malformed event', () => {
  for (const reason of ['postback', 'malformed', 'echo', 'status_event'] as const) {
    assert.deepEqual(planImageReplies([skip({ reason, attachments: ['image'] })]), [], reason);
  }
});

test('a skip with no sender cannot be answered', () => {
  assert.deepEqual(planImageReplies([skip({ attachments: ['image'], senderId: null })]), []);
  assert.deepEqual(planImageReplies([skip({ attachments: ['image'], senderId: '' })]), []);
});

test('a text-less attachment that is not an image is left alone', () => {
  // A voice note or a file is a different question and gets today's behaviour.
  assert.deepEqual(planImageReplies([skip({ attachments: ['audio'] })]), []);
  assert.deepEqual(planImageReplies([skip({ attachments: [] })]), []);
});

test('the dedup key is stable across a redelivery and distinct across events', () => {
  assert.equal(imageReplyDedupKey(44, 0), 'img:44:0');
  assert.equal(imageReplyDedupKey(44, 0), imageReplyDedupKey(44, 0));
  assert.notEqual(imageReplyDedupKey(44, 0), imageReplyDedupKey(46, 0));
  assert.notEqual(imageReplyDedupKey(44, 0), imageReplyDedupKey(44, 1));
});

test('the two real 2026-09-15 drops 82 seconds apart are separate events', () => {
  // event 44 at 16:47:10 and event 46 at 16:48:32 — separate entries, so the dedup key
  // cannot suppress the second and the look-back window is what must. This test pins the
  // reason BURST_WINDOW_MS exists rather than the window itself.
  assert.notEqual(imageReplyDedupKey(44, 0), imageReplyDedupKey(46, 0));
});
