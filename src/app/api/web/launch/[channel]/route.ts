/**
 * `GET /api/web/launch/<channel>` — which services are live, for the tenant's website (D-154).
 *
 * Everything this route decides lives in `@/lib/website/launchJob`; what is left here is
 * the binding, and the rule from `api/workers/reception/route.ts` holds: nothing in this file
 * may branch.
 *
 * GET-only, so rule 8 applies: the shared client's no-store fetch is what keeps the snapshot
 * read fresh, and `force-dynamic` keeps Next from rendering this at build time. The answer's
 * own cache is the CDN's, for `LAUNCH_CACHE_SECONDS`, set in the response headers.
 *
 * The worker's key: this is the website channel's surface, the same one `/api/web/message`
 * reads snapshots with, and it reads nothing that route does not.
 */
import { NextResponse } from 'next/server';
import { supabaseWorker } from '@/lib/supabase/clients';
import { launchHeaders, runLaunchJob } from '@/lib/website/launchJob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ channel: string }> },
): Promise<NextResponse> {
  const { channel } = await context.params;
  const result = await runLaunchJob(supabaseWorker(), {
    channelId: channel,
    log: (event, fields) => console.warn(`[web] ${event}`, fields),
  });
  return NextResponse.json(result.body, { status: result.status, headers: launchHeaders(result) });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' },
  });
}
