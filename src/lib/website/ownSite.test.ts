import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownSiteHosts, ownSiteMatcher, websiteContext, withoutOwnSite } from './ownSite.ts';
import type { ReceptionContext } from '../reception/load.ts';

const HOSTS = ownSiteHosts([
  { host: 'dalatech.online', verified_at: '2026-09-19' },
  { host: 'www.dalatech.online', verified_at: '2026-09-19' },
  { host: 'dalatech-chatbot.vercel.app', verified_at: '2026-09-25' },
  { host: 'unverified.example', verified_at: null },
]);

test('the hosts are the VERIFIED widget hosts, without www, once each', () => {
  assert.deepEqual(HOSTS, ['dalatech.online', 'dalatech-chatbot.vercel.app']);
});

test('DONE-TEST: the measured reply keeps its address and loses «see dalatech.online» (2026-09-26 15:47)', () => {
  const r = withoutOwnSite(
    'Манай хаяг: Улаанбаатар, Монгол. Дэлгэрэнгүй мэдээллийг https://dalatech.online хуудаснаас үзэх боломжтой.', HOSTS);
  assert.equal(r.body, 'Манай хаяг: Улаанбаатар, Монгол.');
  assert.equal(r.removed.length, 1);
});

test('DONE-TEST: the follow-up\'s own-site line goes; the demo app is another site and stays', () => {
  const followUp = '🤖 Таны Facebook, Instagram, вэбсайтын зурваст 24/7 хариулна.\n'
    + '🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online\n👉 Бусад AI ажилтнууд: https://dalatech.online';
  assert.equal(withoutOwnSite(followUp, HOSTS).body,
    '🤖 Таны Facebook, Instagram, вэбсайтын зурваст 24/7 хариулна.\n🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online');
});

test('every way of naming the site is caught; a subdomain, an e-mail or a longer host is not', () => {
  const re = ownSiteMatcher(HOSTS);
  assert.ok(re !== null);
  for (const s of ['dalatech.online дээр', 'https://dalatech.online/', 'http://www.dalatech.online/agents', 'WWW.DALATECH.ONLINE-д',
    'dalatech.online.', 'https://dalatech-chatbot.vercel.app']) {
    assert.ok(re.test(s), s);
  }
  for (const s of ['https://app.dalatech.online', 'info@dalatech.online', 'dalatech.online.mn', 'mydalatech.online', 'dalatech.ai',
    'dalatech.online-shop.mn']) {
    assert.ok(!re.test(s), s);
  }
});

test('no hosts (the Page), or nothing named: the body unchanged to the byte', () => {
  const body = 'Дэлгэрэнгүй: https://dalatech.online';
  assert.deepEqual(withoutOwnSite(body, []), { body, removed: [] });
  const other = 'Демо: https://app.dalatech.online  \n\nБаярлалаа.';
  assert.deepEqual(withoutOwnSite(other, HOSTS), { body: other, removed: [] });
});

test('a reply that is only a pointer to the site comes back empty, for the caller to replace', () => {
  assert.equal(withoutOwnSite('Дэлгэрэнгүйг https://dalatech.online хаягаас үзээрэй.', HOSTS).body, '');
});

test('a URL\'s dots are not sentence ends; the sentence around it goes whole', () => {
  const r = withoutOwnSite('Тийм. Манай dalatech.online сайтад бүх ажилтны мэдээлэл бий. Өөр асуулт байна уу?', HOSTS);
  assert.equal(r.body, 'Тийм. Өөр асуулт байна уу?');
});

test('the website context swaps in each approved website version, and only where one exists', () => {
  const ctx = {
    deterministic: [
      { intent: 'a', body: 'A body', webBody: 'A web' },
      { intent: 'b', body: 'B body', webBody: null },
      { intent: 'c', body: 'C body', webBody: '   ' },
    ],
    sales: { mode: 'live', leadRoute: 'founder_telegram', pairings: [], steps: [
      { kind: 'follow_up', body: 'F body', webBody: 'F web' },
      { kind: 'demo', body: 'D body', webBody: null },
    ] },
  } as unknown as ReceptionContext;
  const w = websiteContext(ctx);
  assert.deepEqual(w.deterministic.map((r) => r.body), ['A web', 'B body', 'C body']);
  assert.deepEqual(w.sales?.steps.map((s) => s.body), ['F web', 'D body']);
  // The Page's context is untouched.
  assert.deepEqual(ctx.deterministic.map((r) => r.body), ['A body', 'B body', 'C body']);
  assert.equal(websiteContext({ ...ctx, sales: null }).sales, null);
});
