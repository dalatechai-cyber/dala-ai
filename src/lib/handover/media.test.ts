import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMediaMessage, mediaHandoffAlertBody, mediaLinksIn } from './media.ts';

test('DONE-TEST (Tara, 2026-09-27): THE SHARED FACEBOOK REEL IS MEDIA', () => {
  assert.deepEqual(mediaLinksIn('https://www.facebook.com/share/r/19d6h1MDrW/?mibextid=wwXIfr'),
    ['https://www.facebook.com/share/r/19d6h1MDrW/?mibextid=wwXIfr']);
  assert.equal(isMediaMessage({ text: 'Ene budalt hed boloh be? https://www.facebook.com/share/r/19d6h1MDrW/', attachments: [], sentPhoto: false }), true);
});

test('photo and video links from the usual places are media', () => {
  for (const u of [
    'https://fb.watch/abc123/', 'https://www.facebook.com/reel/123', 'https://m.facebook.com/watch/?v=1',
    'https://www.facebook.com/photo/?fbid=1', 'https://www.instagram.com/reel/Cx1/', 'https://instagram.com/p/Cx2',
    'https://vm.tiktok.com/ZM1/', 'https://www.tiktok.com/@a/video/1', 'https://youtu.be/x', 'https://www.youtube.com/shorts/y',
    'https://pin.it/abc', 'www.instagram.com/p/xyz',
  ]) assert.equal(mediaLinksIn(`энэ ${u} хэд вэ`).length, 1, u);
});

test('a link that is not a photo or video is not media', () => {
  for (const t of [
    'https://www.facebook.com/tarasalon', 'https://maps.app.goo.gl/ckEXBLoq4FnxJHq16', 'https://app.dalatech.online',
    'энэ хэд вэ', 'facebook дээр харсан', '',
  ]) assert.equal(mediaLinksIn(t).length, 0, t);
});

test('a photo or a video attachment is media; a sticker is not (the caller excludes it)', () => {
  assert.equal(isMediaMessage({ text: 'iim bolgoj bolhu', attachments: ['image'], sentPhoto: true }), true);
  assert.equal(isMediaMessage({ text: 'энэ', attachments: ['video'], sentPhoto: false }), true);
  // A sticker arrives declaring `image` with sentPhoto false (D-070).
  assert.equal(isMediaMessage({ text: 'ok', attachments: ['image'], sentPhoto: false }), false);
});

test('the alert carries the links and ids, never what the customer wrote', () => {
  const body = mediaHandoffAlertBody({ tenantName: 'Tara Salon', links: ['https://fb.watch/a/'], conversationId: 'c1' });
  assert.ok(body.startsWith('📎 Tara Salon:'));
  assert.ok(body.includes('https://fb.watch/a/'));
  assert.ok(body.includes('silent in this conversation'));
  assert.ok(mediaHandoffAlertBody({ tenantName: 'T', links: [], conversationId: 'c1' }).includes('attached photo or video'));
});

test('a profile or channel page is not media', () => {
  for (const u of ['https://www.instagram.com/tarasalon/', 'https://www.youtube.com/@channel', 'https://www.tiktok.com/@tara',
    'https://www.pinterest.com/tara/']) assert.equal(mediaLinksIn(u).length, 0, u);
});

test('a photo or a video with no words is planned once per sender; a sticker never is', async () => {
  const { planMediaAlone } = await import('./media.ts');
  const skip = (o: Record<string, unknown>) => ({
    reason: 'no_text', idx: 0, externalId: 'm1', senderId: 'p1', recipientId: null, appId: null,
    attachments: [], stickerIds: [], ...o,
  });
  const plans = planMediaAlone([
    skip({ idx: 0, attachments: ['video'] }),
    skip({ idx: 1, attachments: ['image'] }),
    skip({ idx: 2, senderId: 'p2', attachments: ['image'], stickerIds: ['369239263222822'] }),
    skip({ idx: 3, senderId: 'p3', attachments: ['audio'] }),
    skip({ idx: 4, senderId: 'p4', reason: 'echo', attachments: ['image'] }),
  ] as never);
  assert.deepEqual(plans.map((p) => p.idx), [0]);
});
