/**
 * The website a visitor is already on is never where they are sent (founder, 2026-09-26, D-140).
 *
 * Measured on dalatech.online: «Танай оффис хаана байдаг вэ?» got «… Дэлгэрэнгүй мэдээллийг
 * https://dalatech.online хуудаснаас үзэх боломжтой.», and the approved follow-up ended
 * «👉 Бусад AI ажилтнууд: https://dalatech.online». Both are right on the Facebook Page and
 * wrong in a widget on that very page. The founder's rule is for every tenant with a website
 * channel, not DalaTech: *"don't send visitors to the site they're on"*.
 *
 * ## Which sites are "the site they're on"
 *
 * The tenant's VERIFIED `tenant_domains` hosts — the registry `/api/web/message` already reads
 * for CORS, i.e. exactly the hosts the widget is allowed to run on. A subdomain that is not
 * listed is a different site: `app.dalatech.online` (the demo app) is where DalaTech's approved
 * website follow-up sends people, and it stays.
 *
 * ## Two layers, data first
 *
 *  1. **An approved website version** (`web_body`, `0056`) on a `sales_next_steps` or
 *     `deterministic_replies` row replaces `body` on the website (`websiteContext`). That is
 *     the founder's own wording and is always preferred.
 *  2. **The rule, for everything else** (`withoutOwnSite`): on the website, a sentence in the
 *     reply that names one of those hosts is not sent. The model's words, a canned line
 *     compiled into the prefix, a row with no website version: the same rule. What is removed
 *     is flagged, so a row that needed a website version is visible rather than silently
 *     trimmed forever.
 *
 * The unit is the SENTENCE, not the line: «Манай хаяг: Улаанбаатар, Монгол. Дэлгэрэнгүй
 * мэдээллийг https://dalatech.online хуудаснаас үзэх боломжтой.» keeps its first sentence. A
 * reply with nothing left is the caller's to replace with the general line.
 *
 * ## What it cannot see
 *
 * A reference with no host in it — «манай вэбсайтаас үзнэ үү» — is not detected. The host is
 * the one thing that is unambiguous in any language; a phrase list would be the input-filter
 * fallacy the outbound guard's header rejects.
 */
import type { ReceptionContext } from '../reception/load.ts';
import { nfc } from '../mn/text.ts';

/** The tenant's verified widget hosts, lower-cased, without a leading `www.`, de-duplicated. */
export function ownSiteHosts(rows: readonly { host: unknown; verified_at: unknown }[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.verified_at === null || r.verified_at === undefined) continue;
    const h = String(r.host ?? '').trim().toLowerCase().replace(/^www\./u, '');
    if (h !== '' && h.includes('.')) out.add(h);
  }
  return [...out];
}

/** The context the website answers from: every approved website version in place of its body. */
export function websiteContext(ctx: ReceptionContext): ReceptionContext {
  const web = (b: string | null | undefined): string | null =>
    typeof b === 'string' && b.trim() !== '' ? nfc(b) : null;
  // Defensive on shape: a throw here would fail the whole website reply over wording.
  return {
    ...ctx,
    deterministic: (ctx.deterministic ?? []).map((r) => {
      const w = web(r.webBody);
      return w === null ? r : { ...r, body: w };
    }),
    sales: ctx.sales === null || ctx.sales === undefined ? ctx.sales : {
      ...ctx.sales,
      steps: ctx.sales.steps.map((s) => {
        const w = web(s.webBody);
        return w === null ? s : { ...s, body: w };
      }),
    },
  };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * A matcher for any of `hosts`, with or without a scheme or `www.`. Not a subdomain of it
 * (`app.dalatech.online` is another site), not an e-mail address at it, not a longer host
 * (`dalatech.online.mn`). Bounds are explicit Unicode classes, never `\b` (rule 6).
 */
export function ownSiteMatcher(hosts: readonly string[]): RegExp | null {
  if (hosts.length === 0) return null;
  const alt = hosts.map(escape).join('|');
  return new RegExp(
    // After the host: a Mongolian case suffix may follow a hyphen («dalatech.online-д», the
    // «Ш0-г» lesson of D-066), so only a hyphen into Latin or a digit continues a hostname.
    `(?<![\\p{L}\\p{N}.\\-@/])(?:https?:\\/\\/)?(?:www\\.)?(?:${alt})(?![\\p{L}\\p{N}]|-[\\p{Script=Latin}\\p{N}]|\\.[\\p{L}\\p{N}])`,
    'iu',
  );
}

/** A line's sentences, each with its end mark. A `.` inside a URL is not an end. */
function sentences(line: string): string[] {
  const out: string[] = [];
  const cps = [...line];
  let acc = '';
  for (let i = 0; i < cps.length; i += 1) {
    const c = cps[i] ?? '';
    acc += c;
    const next = cps[i + 1];
    if (/[.!?…]/u.test(c) && (next === undefined || /\s/u.test(next))) {
      out.push(acc);
      acc = '';
    }
  }
  if (acc !== '') out.push(acc);
  return out;
}

/**
 * The reply with every sentence that names one of the tenant's own hosts left out, and the
 * sentences that were. No hosts, or nothing named: the body unchanged, to the byte.
 */
export function withoutOwnSite(body: string, hosts: readonly string[]): { body: string; removed: string[] } {
  const re = ownSiteMatcher(hosts);
  if (re === null || !re.test(nfc(body))) return { body, removed: [] };
  const removed: string[] = [];
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (!re.test(nfc(line))) { lines.push(line); continue; }
    const kept = sentences(line).filter((s) => {
      if (re.test(nfc(s))) { removed.push(s.trim()); return false; }
      return true;
    });
    const joined = kept.map((s) => s.trim()).filter((s) => s !== '').join(' ');
    if (joined !== '') lines.push(joined);
  }
  // Blank lines left behind collapse to one, and none at either end.
  const text = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  return { body: text, removed };
}
