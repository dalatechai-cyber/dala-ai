/**
 * Hide a Facebook Page's old posts — hidden, NOT deleted, restorable — and un-hide them.
 *
 *     read -rs META_PAGE_TOKEN && export META_PAGE_TOKEN
 *     node scripts/page/hide-posts.ts --page 863503883522801 [--before 2026-09-20] [--except ID,ID]
 *         lists every post (date, id, hidden?, preview); then asks you to type HIDE before it
 *         hides the visible ones it listed. Anything else typed hides nothing.
 *     node scripts/page/hide-posts.ts --page 863503883522801 --unhide POST_ID
 *     node scripts/page/hide-posts.ts --page 863503883522801 --unhide-all
 *         lists the hidden posts, asks you to type UNHIDE, then shows them again.
 *
 * Founder, 2026-09-27: every old post on the DalaTech Page hidden, restorable; the check for
 * active ads is done in Ads Manager, so `--except` takes the ids to leave alone and `--before`
 * keeps anything posted on or after a date (the new posts) out of the list.
 *
 * ## Why a script the founder runs
 *
 * `graph.facebook.com` is refused by this repository's cloud environment's egress proxy. The
 * token is the founder's Page token (it needs `pages_manage_posts` to hide, and
 * `pages_read_engagement` to list), read from `META_PAGE_TOKEN` and never from an argument: a
 * command line lands in shell history and in `ps`. It is sent in the Authorization header only,
 * and Meta's error MESSAGE is never printed (an auth error can quote the token back) — only its
 * code.
 *
 * ## Hidden is reversible, and the record says what to reverse
 *
 * `POST /{post-id}` with `is_hidden=true` takes the post off the Page's timeline; it stays in
 * the Page's content library and `is_hidden=false` puts it back. Every post this run hides is
 * appended to `hidden-posts-<page>.log` in the current directory, one id per line with the time,
 * so an un-hide never depends on remembering which ones were hidden.
 *
 * Standalone on purpose (no imports from `src/`): it runs from a fresh checkout with no
 * `npm install`.
 */
import { createInterface } from 'node:readline/promises';
import { appendFileSync } from 'node:fs';

function die(message: string): never {
  process.stderr.write(`hide-posts: ${message}\n`);
  process.exit(2);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

if (process.argv.some((a) => a.startsWith('--token') || a.startsWith('--secret'))) {
  die('the token is read from META_PAGE_TOKEN in the environment, never from an argument');
}
const token = process.env['META_PAGE_TOKEN'] ?? '';
if (token === '') die('META_PAGE_TOKEN is not set (read -rs META_PAGE_TOKEN && export META_PAGE_TOKEN)');
const page = arg('page') ?? '';
if (!/^[0-9]{6,32}$/.test(page)) die('--page must be the numeric Page id');
const before = arg('before');
if (before !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(before)) die('--before must be a date like 2026-09-20');
const except = new Set((arg('except') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''));
const unhideOne = arg('unhide');
if (unhideOne !== undefined && !/^[0-9]+_[0-9]+$/.test(unhideOne)) die('--unhide takes a post id like 863503883522801_123456789');
const unhideAll = flag('unhide-all');
const version = process.env['META_GRAPH_VERSION'] ?? 'v21.0';
// For the test only: a local stand-in for Graph. Never anywhere else — the token goes with it.
const base = process.env['META_GRAPH_BASE'] ?? 'https://graph.facebook.com';
if (!/^https:\/\/graph\.facebook\.com$|^http:\/\/127\.0\.0\.1:\d+$/.test(base)) die('META_GRAPH_BASE may only point at a local test server');

const out = (s: string) => process.stdout.write(`${s}\n`);
const headers = { authorization: `Bearer ${token}` };

type GraphError = { error?: { code?: number } };
type Post = { id: string; created_time?: string; message?: string; story?: string; is_hidden?: boolean };

function graphDetail(status: number, body: GraphError): string {
  return body.error?.code === undefined
    ? `HTTP ${status} with no Graph error in the body — a network or proxy refusal, not a permission`
    : `HTTP ${status} graph code ${body.error.code}`;
}

async function listPosts(): Promise<Post[]> {
  const rows: Post[] = [];
  let url: string | undefined =
    `${base}/${version}/${page}/published_posts?fields=id,created_time,message,story,is_hidden&limit=100`;
  for (let pages = 0; url !== undefined && pages < 100; pages += 1) {
    const res: Response = await fetch(url, { headers, cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as { data?: Post[]; paging?: { next?: string } } & GraphError;
    if (!res.ok || body.error !== undefined) {
      die(`posts unreadable: ${graphDetail(res.status, body)}.${body.error?.code === 190
        ? ' The token is invalid or expired — generate a new Page token.'
        : body.error?.code === undefined ? '' : ' Listing needs pages_read_engagement on this Page.'}`);
    }
    rows.push(...(body.data ?? []));
    const next = body.paging?.next;
    // Only ever follow Graph's own paging back to Graph: the token travels with the request.
    url = typeof next === 'string' && next.startsWith(`${base}/`) ? next : undefined;
  }
  return rows;
}

async function setHidden(postId: string, hidden: boolean): Promise<{ ok: true } | { ok: false; detail: string }> {
  const res = await fetch(`${base}/${version}/${postId}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ is_hidden: String(hidden) }).toString(),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean } & GraphError;
  if (!res.ok || body.error !== undefined || body.success === false) {
    return { ok: false, detail: `${graphDetail(res.status, body)}${body.error?.code === 200 || body.error?.code === 10
      ? ' — the token needs pages_manage_posts on this Page' : ''}` };
  }
  return { ok: true };
}

function row(p: Post): string {
  const text = (p.message ?? p.story ?? '').replace(/\s+/gu, ' ').trim();
  const cps = [...text];
  const preview = cps.length > 60 ? `${cps.slice(0, 59).join('')}…` : text;
  return `${(p.created_time ?? '').slice(0, 10)} | ${p.id} | ${p.is_hidden === true ? 'hidden ' : 'visible'} | ${preview}`;
}

async function confirm(word: string, question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} Type ${word} to go ahead, anything else to stop: `);
    return answer.trim() === word;
  } finally {
    rl.close();
  }
}

async function apply(targets: Post[], hidden: boolean): Promise<void> {
  const log = `hidden-posts-${page}.log`;
  let done = 0;
  const failed: string[] = [];
  for (const p of targets) {
    const r = await setHidden(p.id, hidden);
    if (r.ok) {
      done += 1;
      if (hidden) appendFileSync(log, `${p.id}\t${new Date().toISOString()}\n`);
      out(`  ${hidden ? 'hidden  ' : 'unhidden'} ${p.id}`);
    } else {
      failed.push(p.id);
      out(`  FAILED   ${p.id}: ${r.detail}`);
      // A permission refusal will refuse every post the same way; stop rather than repeat it.
      if (/graph code (10|200|190)\b/.test(r.detail)) break;
    }
  }
  out('');
  out(`${hidden ? 'Hidden' : 'Un-hidden'}: ${done} of ${targets.length}.${failed.length > 0 ? ` Failed or not tried: ${targets.length - done}.` : ''}`);
  if (hidden && done > 0) out(`Their ids are in ${log}. To restore: --unhide POST_ID, or --unhide-all.`);
}

if (unhideOne !== undefined) {
  if (!unhideOne.startsWith(`${page}_`)) die(`${unhideOne} is not a post of Page ${page}`);
  const r = await setHidden(unhideOne, false);
  if (!r.ok) die(`could not un-hide ${unhideOne}: ${r.detail}`);
  out(`Un-hidden: ${unhideOne}`);
} else {
  const posts = await listPosts();
  out(`Page ${page}: ${posts.length} published post(s).`);
  out('');
  out('date       | post id | state   | preview');
  for (const p of posts) out(row(p));
  out('');

  if (unhideAll) {
    const targets = posts.filter((p) => p.is_hidden === true);
    if (targets.length === 0) {
      out('No hidden posts. Nothing to do.');
    } else if (await confirm('UNHIDE', `Un-hide these ${targets.length} hidden post(s)?`)) {
      await apply(targets, false);
    } else {
      out('Stopped. Nothing was changed.');
    }
  } else {
    const targets = posts.filter((p) => p.is_hidden !== true
      && !except.has(p.id)
      && (before === undefined || (p.created_time ?? '9999').slice(0, 10) < before));
    const kept = posts.length - targets.length;
    out(`Would hide ${targets.length} visible post(s)${before === undefined ? '' : ` posted before ${before}`}`
      + `${except.size > 0 ? `, leaving out ${except.size} listed with --except` : ''}. ${kept} stay as they are.`);
    for (const p of targets) out(`  ${row(p)}`);
    out('');
    if (targets.length === 0) {
      out('Nothing to hide.');
    } else if (await confirm('HIDE', `Hide these ${targets.length} post(s)? They are NOT deleted and can be un-hidden.`)) {
      await apply(targets, true);
    } else {
      out('Stopped. Nothing was changed.');
    }
  }
}

export {};
