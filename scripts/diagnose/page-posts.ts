/**
 * List a Facebook Page's posts, and say which ones an ACTIVE ad is using.
 *
 *     META_PAGE_TOKEN=… node scripts/diagnose/page-posts.ts \
 *       --page 863503883522801 [--ad-account act_1234567890]
 *
 * READ-ONLY. GETs and nothing else; there is no flag that hides, archives or deletes. Hiding
 * is a separate decision the founder takes after reading this list (founder, 2026-09-26).
 *
 * ## Why a script, and why the token comes from the environment
 *
 * `graph.facebook.com` is refused by this repository's cloud environment's egress proxy, so no
 * session can list the posts itself; the founder runs this where Graph is reachable. The
 * token is the founder's own system-user token and is read from `META_PAGE_TOKEN`, never an
 * argument: a command line lands in shell history and in `ps` for every process on the box.
 * It is not the sealed `page_token` in `tenant_secrets` — that one opens only inside the
 * deployment, and its KEK cannot be read back out of Vercel (D-107).
 *
 * ## "Used by an active ad" is only answered when it can be
 *
 * A Page token cannot see ads. With `--ad-account`, the ad account's ACTIVE ads are read
 * (`ads_read`) and every post one of them promotes is marked. Without it, or when that read
 * fails, the column says `not checked` — never `no`. Undetermined is a result.
 */

function die(message: string): never {
  process.stderr.write(`page-posts: ${message}\n`);
  process.exit(2);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv.some((a) => a.startsWith('--token') || a.startsWith('--secret'))) {
  die('the token is read from META_PAGE_TOKEN in the environment, never from an argument');
}
const token = process.env['META_PAGE_TOKEN'] ?? '';
if (token === '') die('META_PAGE_TOKEN is not set');
const page = arg('page') ?? '';
if (!/^[0-9]{6,32}$/.test(page)) die('--page must be the numeric Page id');
const adAccount = arg('ad-account');
if (adAccount !== undefined && !/^act_[0-9]{3,32}$/.test(adAccount)) die('--ad-account must look like act_1234567890');
const version = process.env['META_GRAPH_VERSION'] ?? 'v21.0';

type GraphPage<T> = { data?: T[]; paging?: { next?: string }; error?: { code?: number; message?: string } };

/** Every page of an edge. The error's code is printed, its message is not (it can quote a token). */
async function readAll<T>(firstUrl: string): Promise<{ ok: true; rows: T[] } | { ok: false; detail: string }> {
  const rows: T[] = [];
  let url: string | undefined = firstUrl;
  for (let pages = 0; url !== undefined && pages < 50; pages += 1) {
    const res: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as GraphPage<T>;
    if (!res.ok || body.error !== undefined) {
      return {
        ok: false,
        detail: body.error?.code === undefined
          ? `HTTP ${res.status} with no Graph error in the body — a network or proxy refusal, not a permission`
          : `HTTP ${res.status} graph code ${body.error.code}`,
      };
    }
    rows.push(...(body.data ?? []));
    url = body.paging?.next;
  }
  return { ok: true, rows };
}

type Post = { id: string; created_time?: string; message?: string; story?: string; is_hidden?: boolean; permalink_url?: string };
type Ad = { id: string; name?: string; creative?: { effective_object_story_id?: string; object_story_id?: string } };

const posts = await readAll<Post>(
  `https://graph.facebook.com/${version}/${page}/published_posts?fields=id,created_time,message,story,is_hidden,permalink_url&limit=100`,
);
if (!posts.ok) {
  die(`posts unreadable: ${posts.detail}.${posts.detail.includes('graph code')
    ? ' The token needs pages_read_engagement (and pages_show_list) on this Page.' : ''}`);
}

let adsNote = 'not checked (no --ad-account)';
const inActiveAd = new Map<string, string[]>();
if (adAccount !== undefined) {
  const ads = await readAll<Ad>(
    `https://graph.facebook.com/${version}/${adAccount}/ads?fields=id,name,creative{effective_object_story_id,object_story_id}`
      + `&effective_status=${encodeURIComponent('["ACTIVE"]')}&limit=100`,
  );
  if (!ads.ok) {
    adsNote = `not checked (ads unreadable: ${ads.detail}; the token needs ads_read on ${adAccount})`;
  } else {
    adsNote = `${ads.rows.length} active ad(s) read from ${adAccount}`;
    for (const ad of ads.rows) {
      for (const story of [ad.creative?.effective_object_story_id, ad.creative?.object_story_id]) {
        if (story === undefined) continue;
        inActiveAd.set(story, [...(inActiveAd.get(story) ?? []), ad.name ?? ad.id]);
      }
    }
  }
}

const checked = adAccount !== undefined && !adsNote.startsWith('not checked');
const out = (s: string) => process.stdout.write(`${s}\n`);
out(`Page ${page}: ${posts.rows.length} published post(s). Ads: ${adsNote}.`);
out('');
out('date        | post id | hidden | active ad | preview');
for (const p of posts.rows) {
  const text = (p.message ?? p.story ?? '').replace(/\s+/gu, ' ').trim();
  const preview = [...text].length > 70 ? `${[...text].slice(0, 69).join('')}…` : text;
  const ads = inActiveAd.get(p.id);
  const ad = !checked ? 'not checked' : ads === undefined ? 'no' : `YES: ${ads.join(', ')}`;
  out(`${(p.created_time ?? '').slice(0, 10)} | ${p.id} | ${p.is_hidden === true ? 'yes' : 'no'} | ${ad} | ${preview}`);
}

export {};
