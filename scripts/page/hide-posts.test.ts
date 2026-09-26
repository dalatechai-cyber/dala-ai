/**
 * `hide-posts.ts` against a local stand-in for Graph: it lists, hides ONLY after the exact
 * confirmation word, keeps `--before` / `--except` posts out, restores one or all, never sends
 * the token anywhere but Graph (or this local test server), and never prints Meta's message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/page/hide-posts.ts');
const PAGE = '863503883522801';

type Post = { id: string; created_time: string; message?: string; is_hidden: boolean };

function graphStub(posts: Post[]) {
  const writes: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer TKN') {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: { code: 190, message: 'token TKN is invalid' } }));
    }
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && u.pathname.endsWith('/published_posts')) {
      const second = u.searchParams.get('after') === 'p2';
      const port = (server.address() as { port: number }).port;
      return res.end(JSON.stringify({
        data: second ? posts.slice(2) : posts.slice(0, 2),
        paging: second ? {} : { next: `http://127.0.0.1:${port}/v21.0/${PAGE}/published_posts?after=p2` },
      }));
    }
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const id = u.pathname.split('/').pop() ?? '';
      const post = posts.find((p) => p.id === id);
      if (post === undefined) { res.writeHead(400); res.end(JSON.stringify({ error: { code: 100 } })); return; }
      post.is_hidden = new URLSearchParams(body).get('is_hidden') === 'true';
      writes.push(`${id}=${post.is_hidden}`);
      res.end(JSON.stringify({ success: true }));
    });
  });
  return { server, writes };
}

async function run(port: number, args: string[], input: string, env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'hide-posts-'));
  const child = spawn(process.execPath, [SCRIPT, '--page', PAGE, ...args], {
    cwd,
    env: { ...process.env, META_PAGE_TOKEN: 'TKN', META_GRAPH_BASE: `http://127.0.0.1:${port}`, ...env },
  });
  let out = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { out += c.toString(); });
  child.stdin.end(input);
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { code, out, cwd };
}

function fixture(): Post[] {
  return [
    { id: `${PAGE}_1`, created_time: '2026-08-01T10:00:00+0000', message: 'Хуучин пост', is_hidden: false },
    { id: `${PAGE}_2`, created_time: '2026-09-01T10:00:00+0000', message: 'Old promo', is_hidden: false },
    { id: `${PAGE}_3`, created_time: '2026-09-25T10:00:00+0000', message: 'Шинэ пост', is_hidden: false },
    { id: `${PAGE}_4`, created_time: '2026-07-01T10:00:00+0000', message: 'already hidden', is_hidden: true },
  ];
}

async function withStub(posts: Post[], fn: (port: number, writes: string[]) => Promise<void>) {
  const { server, writes } = graphStub(posts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn((server.address() as { port: number }).port, writes);
  } finally {
    server.close();
  }
}

test('lists every post across pages, and anything but HIDE changes nothing', async () => {
  await withStub(fixture(), async (port, writes) => {
    const r = await run(port, [], 'hide\n');
    assert.match(r.out, /4 published post\(s\)/);
    assert.match(r.out, /Stopped\. Nothing was changed\./);
    assert.deepEqual(writes, []);
  });
});

test('HIDE hides the visible posts before the date, except the listed ones, and logs them', async () => {
  const posts = fixture();
  await withStub(posts, async (port, writes) => {
    const r = await run(port, ['--before', '2026-09-20', '--except', `${PAGE}_2`], 'HIDE\n');
    assert.deepEqual(writes, [`${PAGE}_1=true`]);
    assert.equal(posts.find((p) => p.id === `${PAGE}_3`)?.is_hidden, false, 'a post on or after --before stays');
    const log = join(r.cwd, `hidden-posts-${PAGE}.log`);
    assert.ok(existsSync(log));
    assert.match(readFileSync(log, 'utf8'), new RegExp(`^${PAGE}_1\\t`));
  });
});

test('--unhide restores one post; --unhide-all restores every hidden one after UNHIDE', async () => {
  const posts = fixture();
  await withStub(posts, async (port, writes) => {
    await run(port, ['--unhide', `${PAGE}_4`], '');
    assert.deepEqual(writes, [`${PAGE}_4=false`]);
    posts[0]!.is_hidden = true;
    posts[1]!.is_hidden = true;
    await run(port, ['--unhide-all'], 'UNHIDE\n');
    assert.deepEqual(posts.map((p) => p.is_hidden), [false, false, false, false]);
  });
});

test('a refused token prints Meta\'s CODE, never its message (which can quote the token)', async () => {
  await withStub(fixture(), async (port) => {
    const r = await run(port, [], '', { META_PAGE_TOKEN: 'wrong' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /graph code 190/);
    assert.doesNotMatch(r.out, /token TKN is invalid/);
    assert.doesNotMatch(r.out, /wrong/, 'the token itself is never printed');
  });
});

test('the token is never sent to a host that is not Graph or this local test server', async () => {
  await withStub(fixture(), async (port) => {
    const r = await run(port, [], '', { META_GRAPH_BASE: 'https://graph.example.com' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /may only point at a local test server/);
  });
});

test('the token is refused as an argument', async () => {
  await withStub(fixture(), async (port) => {
    const r = await run(port, ['--token', 'TKN'], '');
    assert.notEqual(r.code, 0);
    assert.match(r.out, /never from an argument/);
  });
});
