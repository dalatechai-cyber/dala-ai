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

/** Serves the tenants row; records every table touched. `alerts` answers an error, so no Telegram is attempted. */
function alertDb(tenant: Record<string, unknown> | null) {
  const touched: string[] = [];
  const db = {
    from(table: string) {
      touched.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'insert', 'upsert', 'update', 'is', 'order', 'limit', 'gte']) chain[m] = () => chain;
      const reply = table === 'tenants' ? { data: tenant, error: null } : { data: null, error: { message: 'stub', code: 'XX000' } };
      chain['maybeSingle'] = async () => reply;
      chain['single'] = async () => reply;
      chain['then'] = (res: (v: unknown) => unknown) => res(reply);
      return chain;
    },
  };
  return { db: db as never, touched };
}

test('D-153: a tenant with the media alert ON is alerted (DalaTech\'s setting)', async () => {
  const { raiseMediaHandoff } = await import('./media.ts');
  const { db, touched } = alertDb({ display_name: 'DalaTech', media_handoff_alert: true });
  const out = await raiseMediaHandoff(db, { tenantId: 't0', conversationId: 'c1', externalId: 'm1', text: 'https://fb.watch/a/' });
  assert.notEqual(out.outcome, 'disabled');
  assert.ok(touched.includes('alerts'), 'the alert was raised');
});

test('D-153: a tenant with the media alert OFF gets no Telegram and no alert row (Tara\'s setting)', async () => {
  const { raiseMediaHandoff } = await import('./media.ts');
  const { db, touched } = alertDb({ display_name: 'Tara Salon', media_handoff_alert: false });
  const out = await raiseMediaHandoff(db, { tenantId: 't1', conversationId: 'c1', externalId: 'm1', text: 'https://fb.watch/a/' });
  assert.deepEqual(out, { outcome: 'disabled' });
  assert.deepEqual(touched, ['tenants'], 'nothing but the setting was read');
});

test('D-153: an unreadable setting still alerts: a silent failure would hide the hand-off', async () => {
  const { raiseMediaHandoff } = await import('./media.ts');
  const { db, touched } = alertDb(null);
  const out = await raiseMediaHandoff(db, { tenantId: 't1', conversationId: 'c1', externalId: 'm1', text: '' });
  assert.notEqual(out.outcome, 'disabled');
  assert.ok(touched.includes('alerts'));
});

// ---------------------------------------------------------------------------
// A shared reel or post is an attachment, whatever the customer typed.
// ---------------------------------------------------------------------------

/** The attachment of Tara's `webhook_events` 142, 144 and 979 (2026-09-18/27), trimmed. */
const realReel = { type: 'reel', payload: { url: 'https://www.facebook.com/reel/1399878458435873?fs=e&s=m', title: 'Reel', reel_video_id: 1399878458435873 } };

test('REAL (Tara, events 142/144): a reel shared with no words is planned for the notice, not left silent', async () => {
  const { extractInboundMessages } = await import('../meta/extract.ts');
  const { planMediaAlone } = await import('./media.ts');
  const r = extractInboundMessages({
    id: '1520409424715591', time: 1,
    messaging: [{ sender: { id: 'psid-r' }, recipient: { id: '1520409424715591' }, timestamp: 1, message: { mid: 'm_reel', attachments: [realReel] } }],
  });
  assert.equal(r.messages.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['no_text']);
  assert.deepEqual(planMediaAlone(r.skipped).map((p) => p.senderId), ['psid-r']);
});

test('a reel with words that hold no link is still media: the attachment decides, not the text', () => {
  assert.equal(isMediaMessage({ text: 'Ene budalt hed boloh be?', attachments: ['reel'], sentPhoto: false }), true);
  assert.equal(isMediaMessage({ text: 'Ene budalt hed boloh be?', attachments: [], sentPhoto: false }), false);
});

test('Instagram: a photo alone, a shared reel and a shared post each reach the notice; a story mention and audio do not', async () => {
  const { extractInboundMessages } = await import('../meta/extract.ts');
  const { planMediaAlone } = await import('./media.ts');
  const ig = (sender: string, attachments: unknown[], text?: string) => ({
    sender: { id: sender }, recipient: { id: '17841417491117031' }, timestamp: 1,
    message: { mid: `m_${sender}`, ...(text === undefined ? {} : { text }), attachments },
  });
  const r = extractInboundMessages({
    id: '17841417491117031', time: 1,
    messaging: [
      ig('ig-photo', [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1' } }]),
      ig('ig-reel', [{ type: 'ig_reel', payload: { url: 'https://lookaside.fbsbx.com/x', title: 't', reel_video_id: '1' } }]),
      ig('ig-post', [{ type: 'share', payload: { url: 'https://lookaside.fbsbx.com/y' } }]),
      ig('ig-story', [{ type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/z' } }]),
      ig('ig-audio', [{ type: 'audio', payload: { url: 'https://lookaside.fbsbx.com/a' } }]),
    ],
  });
  assert.deepEqual(planMediaAlone(r.skipped).map((p) => p.senderId), ['ig-photo', 'ig-reel', 'ig-post']);
});

test('Instagram: a photo WITH words is parsed with its attachment, like Messenger', async () => {
  const { extractInboundMessages } = await import('../meta/extract.ts');
  const r = extractInboundMessages({
    id: '17841417491117031', time: 1,
    messaging: [{
      sender: { id: 'igsid-1' }, recipient: { id: '17841417491117031' }, timestamp: 1,
      message: { mid: 'm_igcap', text: 'энэ хэд вэ', attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/p' } }] },
    }],
  });
  // The parser side only: the worker's own caption tests (worker/reception.test.ts) turn
  // these fields into `customerSentPhoto`, and they share this one parser for both providers.
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.messages[0]?.attachments, ['image']);
  assert.deepEqual(r.messages[0]?.stickerIds, []);
  assert.equal(r.messages[0]?.text, 'энэ хэд вэ');
});
