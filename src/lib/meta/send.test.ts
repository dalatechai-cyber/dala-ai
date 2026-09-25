import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { classify, sendMessage, type SendInput } from './send.ts';

const TOKEN = 'EAAsecretTokenValueThatMustNeverAppearAnywhere';
const PAGE = '100000000000001';
const PSID = '7654321098765432';

const base: SendInput = {
  pageId: PAGE,
  recipientId: PSID,
  text: 'Сайн байна уу. Захиалга авъя.',
  token: TOKEN,
  graphVersion: 'v21.0',
};

/** A stub `fetch` that records the one request it was given. */
function stubFetch(reply: { status: number; body?: unknown; text?: string }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: init as RequestInit });
    const body = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(body, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { seen, impl };
}

// ---------------------------------------------------------------------------
// The URL, and the line that must never come back
// ---------------------------------------------------------------------------

test("the send goes to /{page-id}/messages, and the token is a header", async () => {
  const { seen, impl } = stubFetch({ status: 200, body: { recipient_id: PSID, message_id: 'mid.1' } });
  const out = await sendMessage({ ...base, fetchImpl: impl });

  assert.equal(out.outcome, 'sent');
  assert.equal(out.outcome === 'sent' && out.providerMessageId, 'mid.1');

  const req = seen[0];
  assert.equal(req?.url, `https://graph.facebook.com/v21.0/${PAGE}/messages`);
  assert.doesNotMatch(req?.url ?? '', /me\/messages/);
  // The token is in the Authorization header and NOWHERE else — not the URL, not the body.
  assert.doesNotMatch(req?.url ?? '', new RegExp(TOKEN));
  assert.doesNotMatch(String(req?.init.body ?? ''), new RegExp(TOKEN));
  const headers = req?.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], `Bearer ${TOKEN}`);
});

test("'me' is refused rather than discouraged", async () => {
  // /me/messages resolves the Page FROM THE TOKEN, so a token/tenant mismatch succeeds and
  // posts as the wrong salon with a 200 OK. There is no error to catch, which is why this
  // is a refusal in code and not a note in a comment.
  const { seen, impl } = stubFetch({ status: 200, body: { message_id: 'mid.1' } });
  const out = await sendMessage({ ...base, pageId: 'me', fetchImpl: impl });
  assert.equal(out.outcome, 'failed');
  assert.match(out.outcome === 'failed' ? out.detail : '', /page id must be explicit/);
  assert.equal(seen.length, 0, 'nothing may reach the network');
});

test('an empty page id, recipient or body never reaches the network', async () => {
  for (const patch of [{ pageId: '' }, { recipientId: '' }, { text: '' }]) {
    const { seen, impl } = stubFetch({ status: 200, body: { message_id: 'mid.1' } });
    const out = await sendMessage({ ...base, ...patch, fetchImpl: impl });
    assert.equal(out.outcome, 'failed');
    assert.equal(seen.length, 0);
  }
});

test('the body carries messaging_type RESPONSE and the text unchanged', async () => {
  const { seen, impl } = stubFetch({ status: 200, body: { message_id: 'mid.1' } });
  await sendMessage({ ...base, fetchImpl: impl });
  const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body['messaging_type'], 'RESPONSE');
  assert.deepEqual(body['recipient'], { id: PSID });
  // Mongolian Cyrillic survives JSON.stringify and the wire without transformation.
  assert.deepEqual(body['message'], { text: 'Сайн байна уу. Захиалга авъя.' });
});

test('D-122: a private reply names the COMMENT, carries no messaging_type, and needs exactly one recipient', async () => {
  const { seen, impl } = stubFetch({ status: 200, body: { recipient_id: PSID, message_id: 'mid.p' } });
  const out = await sendMessage({ ...base, recipientId: '', recipientCommentId: '139_174', fetchImpl: impl });
  assert.deepEqual(out, { outcome: 'sent', providerMessageId: 'mid.p', recipientId: PSID });
  const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body['recipient'], { comment_id: '139_174' });
  assert.equal('messaging_type' in body, false);
  assert.ok(seen[0]?.url.endsWith(`/${PAGE}/messages`));
  // Both, or neither, never reach the network.
  const both = stubFetch({ status: 200, body: { message_id: 'x' } });
  const r1 = await sendMessage({ ...base, recipientCommentId: '139_174', fetchImpl: both.impl });
  const r2 = await sendMessage({ ...base, recipientId: '', fetchImpl: both.impl });
  assert.equal(r1.outcome, 'failed');
  assert.equal(r2.outcome, 'failed');
  assert.equal(both.seen.length, 0);
});

// ---------------------------------------------------------------------------
// The Graph error taxonomy
// ---------------------------------------------------------------------------

test('§3.4.4 taxonomy: each code maps to its documented action', () => {
  assert.deepEqual(classify(400, 190), { failure: 'token_revoked', retryable: false });
  assert.deepEqual(classify(403, 200), { failure: 'channel_permission_error', retryable: false });
  assert.deepEqual(classify(403, 10), { failure: 'channel_permission_error', retryable: false });
  assert.deepEqual(classify(400, 100), { failure: 'recipient_unreachable', retryable: false });
  assert.deepEqual(classify(400, 230), { failure: 'consent_withheld', retryable: false });
  assert.deepEqual(classify(400, 9010), { failure: 'bot_validation', retryable: false });
  assert.deepEqual(classify(429, 613), { failure: 'rate_limited', retryable: true });
});

test('a 190 is NEVER retryable — that is how a queue becomes a rate-limit ban', () => {
  // The app is shared by every tenant, so retrying one tenant's dead token throttles all
  // of them. §3.4.4 names this specifically.
  assert.equal(classify(400, 190).retryable, false);
  assert.equal(classify(500, 190).retryable, false, 'even behind a 5xx status');
});

test('an unrecognised code is classified by HTTP status, and 4xx does not retry', () => {
  assert.deepEqual(classify(503, 99999), { failure: 'transient', retryable: true });
  assert.deepEqual(classify(500, null), { failure: 'transient', retryable: true });
  assert.deepEqual(classify(400, 99999), { failure: 'unknown', retryable: false });
  assert.deepEqual(classify(404, null), { failure: 'unknown', retryable: false });
});

test('a Graph error yields the numeric code and no provider text', async () => {
  const { impl } = stubFetch({
    status: 400,
    body: {
      error: {
        // Meta's own message is the string most likely to quote the credential back.
        message: `Error validating access token: the token ${TOKEN} has expired`,
        type: 'OAuthException',
        code: 190,
        error_subcode: 463,
        fbtrace_id: 'AbCdEf123',
      },
    },
  });
  const out = await sendMessage({ ...base, fetchImpl: impl });
  assert.equal(out.outcome, 'failed');
  if (out.outcome !== 'failed') return;
  assert.equal(out.failure, 'token_revoked');
  assert.equal(out.code, 190);
  assert.equal(out.subcode, 463);
  assert.equal(out.status, 400);
  assert.doesNotMatch(out.detail, new RegExp(TOKEN), 'the token must not reach refused_reason');
  assert.doesNotMatch(out.detail, /validating access token/, "Meta's message is not carried");
  assert.match(out.detail, /fbtrace=AbCdEf123/, 'what an operator actually needs');
});

test('a Graph error with no parseable body is still classified by status', async () => {
  const out = await sendMessage({ ...base, fetchImpl: stubFetch({ status: 502, text: '<html>bad gateway</html>' }).impl });
  assert.equal(out.outcome === 'failed' && out.failure, 'transient');
  assert.equal(out.outcome === 'failed' && out.retryable, true);
  assert.equal(out.outcome === 'failed' && out.code, null);
});

// ---------------------------------------------------------------------------
// The third outcome
// ---------------------------------------------------------------------------

test('a 2xx with no message_id is indeterminate, not sent', async () => {
  // Meta almost certainly delivered it and we cannot say so. Marking it sent would claim a
  // provider id we do not have; re-sending would reply twice. Parking it is the only
  // answer that is not a guess.
  const out = await sendMessage({ ...base, fetchImpl: stubFetch({ status: 200, body: { recipient_id: PSID } }).impl });
  assert.equal(out.outcome, 'indeterminate');
});

test('a 2xx with an unparseable body is indeterminate', async () => {
  const out = await sendMessage({ ...base, fetchImpl: stubFetch({ status: 200, text: 'not json' }).impl });
  assert.equal(out.outcome, 'indeterminate');
});

// ---------------------------------------------------------------------------
// Real sockets. These use node:http rather than a stub, because the whole point of the
// failed/indeterminate split is which REAL error shapes can be proved pre-delivery — and
// a stub that throws an object I invented proves only that I can invent objects.
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer<T>(handler: Handler, fn: (origin: string, server: Server) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Point the sender at a local origin by wrapping fetch, leaving everything else real. */
function localFetch(origin: string): typeof fetch {
  return ((url: unknown, init: unknown) =>
    fetch(String(url).replace('https://graph.facebook.com', origin), init as RequestInit)) as typeof fetch;
}

test('a real 200 over a real socket parses as sent', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers['authorization'], `Bearer ${TOKEN}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ recipient_id: PSID, message_id: 'mid.real' }));
    },
    async (origin) => {
      const out = await sendMessage({ ...base, fetchImpl: localFetch(origin) });
      assert.equal(out.outcome === 'sent' && out.providerMessageId, 'mid.real');
    },
  );
});

test('a timeout is INDETERMINATE — the request may already have been acted on', async () => {
  await withServer(
    () => {
      /* never respond */
    },
    async (origin) => {
      const out = await sendMessage({ ...base, fetchImpl: localFetch(origin), timeoutMs: 150 });
      assert.equal(out.outcome, 'indeterminate', 'a timed-out send must not be retried');
    },
  );
});

test('a connection reset mid-response is INDETERMINATE', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"message_');
      res.socket?.destroy();
    },
    async (origin) => {
      const out = await sendMessage({ ...base, fetchImpl: localFetch(origin) });
      assert.equal(out.outcome, 'indeterminate');
    },
  );
});

test('a refused connection is FAILED and retryable — it provably never arrived', async () => {
  // The one case where re-sending cannot double-reply, so it is the one case that is not
  // parked. Found by closing the server before the call rather than by inventing an error.
  const origin = await withServer(
    () => {},
    async (o) => o,
  );
  const out = await sendMessage({ ...base, fetchImpl: localFetch(origin) });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.outcome === 'failed' && out.retryable, true);
  assert.match(out.outcome === 'failed' ? out.detail : '', /never established/);
});

test('a name that does not resolve is FAILED, not indeterminate', async () => {
  const out = await sendMessage({
    ...base,
    fetchImpl: ((url: unknown, init: unknown) =>
      fetch(
        String(url).replace('https://graph.facebook.com', 'http://this-host-does-not-exist.invalid'),
        init as RequestInit,
      )) as typeof fetch,
    timeoutMs: 5_000,
  });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.outcome === 'failed' && out.retryable, true);
});

test('an enormous response body is bounded rather than buffered whole', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(200 * 1024));
    },
    async (origin) => {
      const out = await sendMessage({ ...base, fetchImpl: localFetch(origin) });
      // Bounded, unparseable, 2xx: indeterminate rather than a crash or a false 'sent'.
      assert.equal(out.outcome, 'indeterminate');
    },
  );
});

test('the timeout is armed and cleared, so a fast send does not hold the process open', async () => {
  // A dangling setTimeout keeps a lambda alive to its own timeout and costs real money on
  // a per-invocation-millisecond biller. Proved by the test simply exiting.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message_id: 'mid.fast' }));
    },
    async (origin) => {
      const started = Date.now();
      const out = await sendMessage({ ...base, fetchImpl: localFetch(origin), timeoutMs: 30_000 });
      assert.equal(out.outcome, 'sent');
      assert.ok(Date.now() - started < 5_000);
    },
  );
});
