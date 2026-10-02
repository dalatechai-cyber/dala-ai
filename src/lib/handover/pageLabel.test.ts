import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelNeedsPerson, labelThread, type LabelDeps } from './pageLabel.ts';

type Call = { method: string; url: string; body: unknown; auth: string | null };

function fakeGraph(answers: Array<{ status: number; json: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: String(init?.method), url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)), auth: headers['authorization'] ?? null });
    const a = answers.shift() ?? { status: 500, json: { error: { code: 2, message: 'no scripted answer' } } };
    return new Response(JSON.stringify(a.json), { status: a.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = { pageId: '1520409424715591', psid: 'psid_1', labelName: 'Хүн хариулах', token: 'tok', graphVersion: 'v21.0' };

test('an existing label is found by name and put on the customer: two calls, the token in a header only', async () => {
  const g = fakeGraph([
    { status: 200, json: { data: [{ id: 'L1', page_label_name: 'Өөр' }, { id: 'L2', page_label_name: 'Хүн хариулах' }] } },
    { status: 200, json: { success: true } },
  ]);
  const r = await labelThread({ ...BASE, fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { outcome: 'labelled', labelId: 'L2', created: false });
  assert.equal(g.calls.length, 2);
  assert.match(g.calls[0]!.url, /\/v21\.0\/1520409424715591\/custom_labels\?fields=id%2Cpage_label_name&limit=100$/u);
  assert.equal(g.calls[1]!.method, 'POST');
  assert.match(g.calls[1]!.url, /\/v21\.0\/L2\/label$/u);
  assert.deepEqual(g.calls[1]!.body, { user: 'psid_1' });
  for (const c of g.calls) {
    assert.equal(c.auth, 'Bearer tok');
    assert.doesNotMatch(c.url, /tok/u, 'never a query parameter');
  }
});

test('a missing label is created once, then attached', async () => {
  const g = fakeGraph([
    { status: 200, json: { data: [] } },
    { status: 200, json: { id: 'NEW' } },
    { status: 200, json: { success: true } },
  ]);
  const r = await labelThread({ ...BASE, fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { outcome: 'labelled', labelId: 'NEW', created: true });
  assert.deepEqual(g.calls[1]!.body, { page_label_name: 'Хүн хариулах' });
});

test('the label list is paged by cursor, and the name compared in NFC', async () => {
  const decomposed = 'Хүн хариулах'.normalize('NFD');
  const g = fakeGraph([
    { status: 200, json: { data: [{ id: 'L1', page_label_name: 'A' }], paging: { cursors: { after: 'C1' }, next: 'https://graph.facebook.com/next' } } },
    { status: 200, json: { data: [{ id: 'L9', page_label_name: decomposed }] } },
    { status: 200, json: { success: true } },
  ]);
  const r = await labelThread({ ...BASE, fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { outcome: 'labelled', labelId: 'L9', created: false });
  assert.match(g.calls[1]!.url, /after=C1/u);
});

test('a Graph refusal names the step and the code; nothing is retried', async () => {
  const g = fakeGraph([
    { status: 200, json: { data: [] } },
    { status: 403, json: { error: { code: 200, message: 'Permissions error' } } },
  ]);
  const r = await labelThread({ ...BASE, fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { outcome: 'failed', step: 'create', status: 403, code: 200, detail: 'HTTP 403: Permissions error' });
  assert.equal(g.calls.length, 2);
});

test("'me', an empty page or no customer is refused before any call", async () => {
  for (const bad of [{ pageId: 'me' }, { pageId: '' }, { psid: '' }]) {
    const g = fakeGraph([]);
    const r = await labelThread({ ...BASE, ...bad, fetchImpl: g.fetchImpl });
    assert.deepEqual(r, { outcome: 'skipped', reason: 'no_thread' });
    assert.equal(g.calls.length, 0);
  }
});

test('the whole label stays inside its budget: a hanging Graph is cut off, never awaited forever', async () => {
  const hanging = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })) as unknown as typeof fetch;
  const started = Date.now();
  const r = await labelThread({ ...BASE, fetchImpl: hanging, budgetMs: 50 });
  assert.equal(r.outcome, 'failed');
  assert.ok(Date.now() - started < 1000);
});

const DEPS = (over: Partial<LabelDeps> = {}): LabelDeps & { tokens: number } => {
  const d = {
    tokens: 0,
    readLabel: async () => 'Хүн хариулах' as string | null | 'unreadable',
    loadToken: async () => { d.tokens += 1; return { ok: true as const, token: 'tok' }; },
    graphVersion: 'v21.0',
    ...over,
  };
  return d;
};
const THREAD = { channelId: 'ch', pageId: '1520409424715591', psid: 'psid_1' };

test('OFF by default: a tenant with no label set gets no Graph call and no token is opened', async () => {
  const g = fakeGraph([]);
  const d = DEPS({ readLabel: async () => null, fetchImpl: g.fetchImpl });
  assert.deepEqual(await labelNeedsPerson(d, { tenantId: 't', provider: 'facebook', thread: THREAD }), { outcome: 'skipped', reason: 'no_label_set' });
  assert.equal(g.calls.length, 0);
  assert.equal(d.tokens, 0);
});

test('Messenger only: Instagram and the website are never labelled', async () => {
  for (const provider of ['instagram', 'web']) {
    const g = fakeGraph([]);
    const r = await labelNeedsPerson(DEPS({ fetchImpl: g.fetchImpl }), { tenantId: 't', provider, thread: THREAD });
    assert.deepEqual(r, { outcome: 'skipped', reason: 'not_messenger' });
    assert.equal(g.calls.length, 0);
  }
});

test('an unreadable setting, a missing token or no thread is skipped and said, never thrown', async () => {
  assert.deepEqual(await labelNeedsPerson(DEPS({ readLabel: async () => 'unreadable' }), { tenantId: 't', provider: 'facebook', thread: THREAD }),
    { outcome: 'skipped', reason: 'label_unreadable' });
  assert.deepEqual(await labelNeedsPerson(DEPS({ loadToken: async () => ({ ok: false, detail: 'revoked' }) }), { tenantId: 't', provider: 'facebook', thread: THREAD }),
    { outcome: 'skipped', reason: 'no_credential', detail: 'revoked' });
  assert.deepEqual(await labelNeedsPerson(DEPS(), { tenantId: 't', provider: 'facebook' }), { outcome: 'skipped', reason: 'no_thread' });
  const r = await labelNeedsPerson(DEPS({ readLabel: async () => { throw new Error('boom'); } }), { tenantId: 't', provider: 'facebook', thread: THREAD });
  assert.equal(r.outcome, 'failed');
});

test('the token is opened for the channel that sends (an Instagram channel sends through its Page, D-141)', async () => {
  const seen: string[] = [];
  const g = fakeGraph([{ status: 200, json: { data: [{ id: 'L', page_label_name: 'Хүн хариулах' }] } }, { status: 200, json: { success: true } }]);
  const d = DEPS({ loadToken: async (_t, ch) => { seen.push(ch); return { ok: true, token: 'tok' }; }, fetchImpl: g.fetchImpl });
  const r = await labelNeedsPerson(d, { tenantId: 't', provider: 'facebook', thread: { ...THREAD, tokenChannelId: 'page-ch' } });
  assert.equal(r.outcome, 'labelled');
  assert.deepEqual(seen, ['page-ch']);
});
