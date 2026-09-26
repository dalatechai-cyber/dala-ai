import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagramTagsPerson, lookupComment, lookupInstagramComment, parseGraphTime, tagsAPerson } from './lookup.ts';
import { complaintAlertBody } from './complaint.ts';

const PAGE = '1520409424715591';

test('tagsAPerson: absent is no tag; a user tag is a person; the Page itself is not', () => {
  assert.equal(tagsAPerson(undefined, PAGE), false);
  assert.equal(tagsAPerson([], PAGE), false);
  assert.equal(tagsAPerson([{ id: '42', name: 'Bold Bat', type: 'user', offset: 0, length: 8 }], PAGE), true);
  assert.equal(tagsAPerson([{ id: PAGE, name: 'Tara salon', type: 'page' }], PAGE), false);
  assert.equal(tagsAPerson([{ id: '77', name: 'Other page', type: 'page' }], PAGE), false);
  // Our Page's id without a type is still ours; an unknown type is not the salon.
  assert.equal(tagsAPerson([{ id: PAGE }], PAGE), false);
  assert.equal(tagsAPerson([{ id: '9', type: 'group' }], PAGE), true);
  assert.equal(tagsAPerson(['garbage'], PAGE), true);
  // Not an array is unreadable, and unreadable is null — never "no tags".
  assert.equal(tagsAPerson({ data: [] }, PAGE), null);
});

test('parseGraphTime reads Graph’s +0000 offset, and refuses garbage', () => {
  assert.equal(parseGraphTime('2026-09-22T05:40:00+0000')?.toISOString(), '2026-09-22T05:40:00.000Z');
  assert.equal(parseGraphTime('2026-09-22T13:40:00+0800')?.toISOString(), '2026-09-22T05:40:00.000Z');
  assert.equal(parseGraphTime('yesterday'), null);
  assert.equal(parseGraphTime(1790000000), null);
  assert.equal(parseGraphTime(undefined), null);
});

function fetchStub(routes: Record<string, { status: number; body: unknown } | 'throw'>, seen: { url: string; auth: string }[]) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: String((init.headers as Record<string, string>)['authorization']) });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key === undefined ? { status: 404, body: {} } : routes[key];
    if (r === 'throw' || r === undefined) throw Object.assign(new Error('reset'), { name: 'AbortError' });
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

test('lookupComment reads tags from the COMMENT and the age from the POST, token in the header only', async () => {
  const seen: { url: string; auth: string }[] = [];
  const out = await lookupComment({
    commentId: '139_174', postId: `${PAGE}_139`, pageId: PAGE, token: 'SECRET', graphVersion: 'v21.0',
    fetchImpl: fetchStub({
      '139_174?fields=message_tags': { status: 200, body: { id: '139_174' } },
      [`${PAGE}_139?fields=created_time`]: { status: 200, body: { created_time: '2026-09-22T05:40:00+0000' } },
    }, seen),
  });
  assert.equal(out.tagsPerson, false);
  assert.equal(out.postCreatedAt?.toISOString(), '2026-09-22T05:40:00.000Z');
  assert.deepEqual(out.problems, []);
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.ok(!s.url.includes('SECRET'), 'never a query parameter');
    assert.equal(s.auth, 'Bearer SECRET');
  }
});

test('lookupComment: a Graph error or a dropped connection is null, never false', async () => {
  const out = await lookupComment({
    commentId: 'c', postId: 'p', pageId: PAGE, token: 't', graphVersion: 'v21.0',
    fetchImpl: fetchStub({
      'c?fields=message_tags': { status: 400, body: { error: { code: 100, message: 'token EAAB… is bad' } } },
      'p?fields=created_time': 'throw',
    }, []),
  });
  assert.equal(out.tagsPerson, null);
  assert.equal(out.postCreatedAt, null);
  assert.equal(out.problems.length, 2);
  assert.ok(out.problems.every((p) => !p.includes('EAAB')), 'Meta’s message text is never carried');
});

test('the complaint alert quotes the comment, truncated by CHARACTER, and carries the link', () => {
  const body = complaintAlertBody({ tenantName: 'Tara Salon', text: 'Утсаа авахгүй юм 😡', link: 'https://www.facebook.com/x?comment_id=1' });
  assert.ok(body.includes('«Утсаа авахгүй юм 😡»'));
  assert.ok(body.endsWith('https://www.facebook.com/x?comment_id=1'));
  assert.ok(body.includes('Tara Salon'));
  const long = complaintAlertBody({ tenantName: 't', text: '😡'.repeat(400), link: 'l' });
  assert.ok(long.includes(`«${'😡'.repeat(280)}…»`), 'code points, never UTF-16 units');
});

test('D-145: an Instagram mention is @username in the text', () => {
  for (const t of ['@bold_99 хар', 'хар @bold.b', '1 @x']) assert.equal(instagramTagsPerson(t), true, t);
  for (const t of ['1', 'mail@site.mn', '1 👍', 'Үнэ хэд вэ?']) assert.equal(instagramTagsPerson(t), false, t);
});

test('D-145: the Instagram lookup reads the media timestamp and never the Page fields', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ timestamp: '2026-09-20T10:00:00+0000', id: 'm1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await lookupInstagramComment({ commentId: 'c1', postId: 'm1', pageId: 'ig', token: 't', graphVersion: 'v21.0', text: '1', fetchImpl });
  assert.equal(urls.length, 1);
  assert.ok(urls[0]?.endsWith('/m1?fields=timestamp'));
  assert.deepEqual(r, { tagsPerson: false, postCreatedAt: new Date('2026-09-20T10:00:00Z'), problems: [] });
});
