/**
 * The client's pay page for one DalaTech invoice (D-156). The path segment is a signed
 * link (`@/lib/billing/links`); the page is `@/lib/billing/page`. A route handler returning
 * HTML, as `/data-deletion/status` does: this app has no React tree.
 */
import { NextResponse } from 'next/server';
import { supabaseBilling } from '@/lib/supabase/clients';
import { runPayPageJob } from '@/lib/billing/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const HTML = {
  'content-type': 'text/html; charset=utf-8',
  // The state changes when the client pays; never serve a cached unpaid page.
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
} as const;

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await context.params;
  const page = await runPayPageJob({ db: supabaseBilling, now: new Date(), token: decodeURIComponent(token) });
  return new NextResponse(page.html, { status: page.status, headers: HTML }) as NextResponse;
}
