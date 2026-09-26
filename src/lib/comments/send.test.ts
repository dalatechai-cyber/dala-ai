import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { REPLY_EDGE, sendCommentReply, type CommentSendInput } from './send.ts';

const TOKEN = 'EAAsecretPageTokenThatMustNeverAppear';
const COMMENT_ID = '100000000000001_c1';
const LINE = 'Сайн байна уу! Дэлгэрэнгүйг хувийн мессежээр хүргэе.';

const base: CommentSendInput = { commentId: COMMENT_ID, body: LINE, token: TOKEN, graphVersion: 'v21.0' };

function stubFetch(reply: { status: number; body?: unknown; text?: string }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: init as RequestInit });
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

test('the reply goes to the comment edge, with the token in a header only', () => {
  return (async () => {
    const { seen, impl } = stubFetch({ status: 200, body: { id: `${COMMENT_ID}_r1` } });
    const out = await sendCommentReply({ ...base, fetchImpl: impl });

    assert.equal(out.outcome, 'sent');
    assert.equal(out.outcome === 'sent' && out.providerCommentId, `${COMMENT_ID}_r1`);

    const req = seen[0];
    assert.equal(req?.url, `https://graph.facebook.com/v21.0/${encodeURIComponent(COMMENT_ID)}/${REPLY_EDGE}`);
    assert.doesNotMatch(req?.url ?? '', new RegExp(TOKEN), 'never a query parameter');
    assert.doesNotMatch(String(req?.init.body ?? ''), new RegExp(TOKEN));
    assert.equal((req?.init.headers as Record<string, string>)['authorization'], `Bearer ${TOKEN}`);
  })();
});

test('the body is the tenant line, verbatim and alone', async () => {
  // Nothing here may compose, append to, or vary what eligibility chose. The public
  // surface is the wrong place for a function that could.
  const { seen, impl } = stubFetch({ status: 200, body: { id: 'r1' } });
  await sendCommentReply({ ...base, fetchImpl: impl });
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), { message: LINE });
});

test('the edge is one constant, so an unverified guess is a one-line fix', () => {
  // 00-research-notes marks POST /{comment-id}/comments SEARCH-CORROBORATED with an
  // explicit "re-verify the exact edge"; one source claims POST /{comment-id} instead.
  // This pins that the value is reachable and used, so changing it changes the request.
  assert.equal(REPLY_EDGE, 'comments');
});

test('an empty reply is refused before it can be posted', async () => {
  // An empty public reply under a customer's comment reads as the salon deliberately
  // posting nothing, and it cannot be un-posted.
  for (const body of ['', '   ']) {
    const { seen, impl } = stubFetch({ status: 200, body: { id: 'r1' } });
    const out = await sendCommentReply({ ...base, body, fetchImpl: impl });
    assert.equal(out.outcome, 'failed');
    assert.equal(seen.length, 0, 'nothing may reach the network');
  }
});

test('a missing comment id never reaches the network', async () => {
  const { seen, impl } = stubFetch({ status: 200, body: { id: 'r1' } });
  const out = await sendCommentReply({ ...base, commentId: '', fetchImpl: impl });
  assert.equal(out.outcome, 'failed');
  assert.equal(seen.length, 0);
});

test('the Graph taxonomy is the same one the DM path uses', async () => {
  const cases: [number, number, string, boolean][] = [
    [400, 190, 'token_revoked', false],
    [403, 200, 'channel_permission_error', false],
    [403, 10, 'channel_permission_error', false],
    [400, 100, 'recipient_unreachable', false],
    [429, 613, 'rate_limited', true],
    [503, 99999, 'transient', true],
    [400, 99999, 'unknown', false],
  ];
  for (const [status, code, failure, retryable] of cases) {
    const { impl } = stubFetch({ status, body: { error: { code, message: 'x', fbtrace_id: 'T1' } } });
    const out = await sendCommentReply({ ...base, fetchImpl: impl });
    assert.equal(out.outcome === 'failed' && out.failure, failure, `code ${code}`);
    assert.equal(out.outcome === 'failed' && out.retryable, retryable, `code ${code}`);
  }
});

test('no failure detail carries the token or Meta\'s own message', async () => {
  const { impl } = stubFetch({
    status: 400,
    body: { error: { message: `Error validating access token: ${TOKEN} has expired`, code: 190, fbtrace_id: 'AbC' } },
  });
  const out = await sendCommentReply({ ...base, fetchImpl: impl });
  assert.equal(out.outcome, 'failed');
  if (out.outcome !== 'failed') return;
  assert.doesNotMatch(out.detail, new RegExp(TOKEN));
  assert.doesNotMatch(out.detail, /validating access token/);
  assert.match(out.detail, /fbtrace=AbC/);
});

test('a 2xx with no comment id is indeterminate, not sent', async () => {
  // It is probably public. We cannot say so, and posting again would put two identical
  // replies under one customer's comment.
  const out = await sendCommentReply({ ...base, fetchImpl: stubFetch({ status: 200, body: {} }).impl });
  assert.equal(out.outcome, 'indeterminate');
});

// ---------------------------------------------------------------------------
// Real sockets: which real error shapes mean what
// ---------------------------------------------------------------------------

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (origin: string) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const localFetch = (origin: string): typeof fetch =>
  ((url: unknown, init: unknown) =>
    fetch(String(url).replace('https://graph.facebook.com', origin), init as RequestInit)) as typeof fetch;

test('a timeout is INDETERMINATE — the reply may already be public', async () => {
  await withServer(
    () => {},
    async (origin) => {
      const out = await sendCommentReply({ ...base, fetchImpl: localFetch(origin), timeoutMs: 150 });
      assert.equal(out.outcome, 'indeterminate');
    },
  );
});

test('a refused connection is FAILED and retryable — it provably never arrived', async () => {
  const origin = await withServer(() => {}, async (o) => o);
  const out = await sendCommentReply({ ...base, fetchImpl: localFetch(origin) });
  assert.equal(out.outcome === 'failed' && out.retryable, true);
  assert.match(out.outcome === 'failed' ? out.detail : '', /never established/);
});

test('a real 200 over a real socket, with a Cyrillic body, parses as sent', async () => {
  await withServer(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        assert.equal(JSON.parse(body).message, LINE, 'Cyrillic survives the wire unchanged');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'real_r1' }));
      });
    },
    async (origin) => {
      const out = await sendCommentReply({ ...base, fetchImpl: localFetch(origin) });
      assert.equal(out.outcome === 'sent' && out.providerCommentId, 'real_r1');
    },
  );
});

test('D-145: an Instagram comment is answered at /replies', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ id: 'r1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendCommentReply({ commentId: '1789', body: 'Сайн байна уу!', token: 't', graphVersion: 'v21.0', edge: 'replies', fetchImpl });
  assert.equal(r.outcome, 'sent');
  assert.ok(urls[0]?.endsWith('/1789/replies'));
});
