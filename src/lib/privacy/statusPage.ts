/**
 * The page a person lands on after asking Facebook to delete their data.
 *
 * Meta's Data Deletion Request callback must return a URL where the person can check the
 * status of their request. This renders it.
 *
 * ## Every sentence on it is customer-visible Mongolian, so every sentence is gated
 *
 * The words here are read by a customer in Mongolia — the same customers who read the
 * tenant's replies — so they pass the same gate: rows in `prompt_blocks` with
 * `scope = 'platform'` and a non-null `reviewed_at`. There is no English fallback and no
 * built-in default string, because a fallback is how unreviewed platform Mongolian
 * reaches a customer: it never fails a build, it just quietly ships.
 *
 * Until the blocks are written and signed this page returns **503**, deliberately and
 * visibly, rather than a degraded page that looks like it works. App Review will visit
 * this URL, so an unsigned block is a submission blocker that announces itself — which is
 * the only kind of blocker that gets fixed before it costs a review cycle.
 *
 * ## What it may show
 *
 * A state, two dates, and the code the person already holds. Never a name, an id, a
 * tenant, or anything about what data exists. The key to this page is a code that can be
 * read over somebody's shoulder, so what a stranger holding it can learn is bounded to
 * what the person already told them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ErasureStatus } from './erasure.ts';

/**
 * The blocks this page is made of. All of them, or the page refuses.
 *
 * One key per sentence rather than one block of prose, so a change to the "we could not
 * find it" line does not invalidate the sign-off on the "your request was received" line.
 */
export const STATUS_BLOCK_KEYS = [
  'data_deletion_title',
  'data_deletion_intro',
  'data_deletion_code_label',
  'data_deletion_requested_label',
  'data_deletion_state_received',
  'data_deletion_state_completed',
  'data_deletion_state_failed',
  'data_deletion_not_found',
] as const;

export type StatusBlockKey = (typeof STATUS_BLOCK_KEYS)[number];
export type StatusBlocks = Record<StatusBlockKey, string>;

export type BlocksOutcome =
  | { ok: true; blocks: StatusBlocks }
  /** One or more blocks are absent or unsigned. The page must not render. */
  | { ok: false; reason: 'unsigned'; missing: string[] }
  | { ok: false; reason: 'unavailable'; detail: string };

/**
 * Load the signed platform blocks.
 *
 * `reviewed_at is not null` is in the WHERE clause rather than checked afterwards, so an
 * unsigned row is indistinguishable from an absent one at this boundary. That is the
 * intent: an unsigned block has not been approved for a customer to read, and there is no
 * code path on which it can be read anyway.
 */
export async function loadStatusBlocks(db: SupabaseClient): Promise<BlocksOutcome> {
  const { data, error } = await db
    .from('prompt_blocks')
    .select('block_key, body')
    .eq('scope', 'platform')
    .is('tenant_id', null)
    .not('reviewed_at', 'is', null)
    .in('block_key', [...STATUS_BLOCK_KEYS]);

  if (error) return { ok: false, reason: 'unavailable', detail: `prompt_blocks unreadable: ${error.message}` };

  const found = new Map<string, string>();
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>;
    const body = typeof r['body'] === 'string' ? r['body'].trim() : '';
    if (body !== '') found.set(String(r['block_key']), body);
  }

  const missing = STATUS_BLOCK_KEYS.filter((k) => !found.has(k));
  if (missing.length > 0) return { ok: false, reason: 'unsigned', missing: [...missing] };

  const blocks = Object.fromEntries(STATUS_BLOCK_KEYS.map((k) => [k, found.get(k) as string])) as StatusBlocks;
  return { ok: true, blocks };
}

/** Which sentence describes this state. `no_match` reads as `failed` to the person: we
 *  could not act on it, and the distinction between "wrong namespace" and "job error" is
 *  ours to fix, not theirs to interpret. */
export function stateBlockFor(status: ErasureStatus): StatusBlockKey {
  if (status === 'completed') return 'data_deletion_state_completed';
  if (status === 'no_match' || status === 'failed') return 'data_deletion_state_failed';
  // 'received' and 'matched' are both "in progress" from outside.
  return 'data_deletion_state_received';
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escape for HTML text and attributes.
 *
 * The block text is founder-signed, so this is not the boundary that stops an injection —
 * it is the one that stops a signed sentence containing an ampersand from breaking the
 * page. It runs over every interpolated value regardless of provenance, because "this
 * value is trusted" is a claim that stops being true when somebody adds a field.
 *
 * ascii-safe: the class is five ASCII punctuation characters, named individually. It
 * cannot match a Cyrillic codepoint.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

export type StatusView =
  | { found: true; code: string; status: ErasureStatus; requestedAt: Date | null }
  | { found: false };

/** UTC, ISO date only. A time would imply a precision the person does not need, and a
 *  local timezone would need one we do not have for them. */
function isoDate(d: Date | null): string {
  return d === null ? '—' : (d.toISOString().slice(0, 10) as string);
}

export function renderStatusPage(blocks: StatusBlocks, view: StatusView): string {
  const t = (k: StatusBlockKey) => escapeHtml(blocks[k]);

  const body = view.found
    ? `      <p class="state">${t(stateBlockFor(view.status))}</p>
      <dl>
        <dt>${t('data_deletion_code_label')}</dt><dd><code>${escapeHtml(view.code)}</code></dd>
        <dt>${t('data_deletion_requested_label')}</dt><dd>${escapeHtml(isoDate(view.requestedAt))}</dd>
      </dl>`
    : `      <p class="state">${t('data_deletion_not_found')}</p>`;

  // Inline CSS and no scripts: this page must render for somebody on a bad connection in
  // a Facebook in-app browser, and it has nothing to be interactive about.
  return `<!doctype html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${t('data_deletion_title')}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         max-width: 34rem; margin: 0 auto; padding: 2rem 1.25rem; line-height: 1.6; color: #111; }
  h1 { font-size: 1.4rem; }
  .state { font-weight: 600; }
  dt { font-weight: 600; margin-top: 1rem; }
  dd { margin: 0.2rem 0 0; }
  code { font-size: 1.05rem; letter-spacing: 0.08em; word-break: break-all; }
</style>
</head>
<body>
  <main>
    <h1>${t('data_deletion_title')}</h1>
    <p>${t('data_deletion_intro')}</p>
${body}
  </main>
</body>
</html>
`;
}
