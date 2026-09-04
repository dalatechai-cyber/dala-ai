/**
 * The status page for a data deletion request. The URL Meta hands the person.
 *
 * A route handler rather than a page component because this app has no UI, no root layout
 * and no React tree — adding one so that a single server-rendered page could exist would
 * be more moving parts, not fewer. It returns HTML directly.
 *
 * Every sentence is a signed platform block. When one is missing this returns 503 rather
 * than a partly-English page: see `lib/privacy/statusPage.ts` for why there is no
 * fallback string anywhere in this path.
 */
import { NextResponse } from 'next/server';
import { readErasureStatus } from '@/lib/privacy/erasure';
import { loadStatusBlocks, renderStatusPage, type StatusView } from '@/lib/privacy/statusPage';
import { supabasePrivacy } from '@/lib/supabase/clients';

export const runtime = 'nodejs';
export const maxDuration = 15;

const HTML = {
  'content-type': 'text/html; charset=utf-8',
  // Nothing here may be cached: the state changes, and a shared cache keyed on the path
  // would serve one person's page to the next. (Rule 8's cousin — a GET-only route.)
  'cache-control': 'no-store, max-age=0',
  // The code is in the query string; keep it out of any onward Referer.
  'referrer-policy': 'no-referrer',
} as const;

export async function GET(request: Request): Promise<NextResponse> {
  const db = supabasePrivacy();

  const blocks = await loadStatusBlocks(db);
  if (!blocks.ok) {
    if (blocks.reason === 'unsigned') {
      // A submission blocker that announces itself, which is the only kind that gets
      // fixed before it costs a review cycle.
      console.error('[privacy] status_page_unsigned', { missing: blocks.missing });
      return NextResponse.json(
        { error: 'privacy.status_page_unsigned', missing: blocks.missing },
        { status: 503 },
      );
    }
    console.error('[privacy] status_blocks_unavailable', { detail: blocks.detail });
    return NextResponse.json({ error: 'privacy.unavailable' }, { status: 503 });
  }

  const code = new URL(request.url).searchParams.get('code') ?? '';
  const found = await readErasureStatus(db, code);

  if (found.outcome === 'unavailable') {
    // "We could not look" is not "there is no such request". Telling somebody their
    // deletion request does not exist because a read blipped is the wrong answer, and it
    // is the one they would act on.
    console.error('[privacy] erasure_status_unavailable', { detail: found.detail });
    return NextResponse.json({ error: 'privacy.unavailable' }, { status: 503 });
  }

  const view: StatusView =
    found.outcome === 'found'
      ? { found: true, code, status: found.status, requestedAt: found.requestedAt }
      : { found: false };

  // 404 for a code that matches nothing, so a scanner cannot enumerate valid codes by
  // status alone; the page still explains itself to a person who mistyped one.
  return new NextResponse(renderStatusPage(blocks.blocks, view), {
    status: view.found ? 200 : 404,
    headers: HTML,
  }) as NextResponse;
}
