/**
 * The client's pay page for one DalaTech invoice (D-156). The path segment is a signed
 * link (`@/lib/billing/links`); the page is `@/lib/billing/page`. A route handler returning
 * HTML, as `/data-deletion/status` does: this app has no React tree.
 */
import { NextResponse } from 'next/server';
import { supabaseBilling } from '@/lib/supabase/clients';
import { payPagePath, runPayPageJob } from '@/lib/billing/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Asking QPay about the invoice, then making a code: two QPay calls of up to 15 s each.
export const maxDuration = 60;

const HTML = {
  'content-type': 'text/html; charset=utf-8',
  // The state changes when the client pays, and every code is made for one visit: never cache.
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
} as const;

async function respond(request: Request, context: { params: Promise<{ token: string }> }, method: 'GET' | 'POST'): Promise<NextResponse> {
  const { token } = await context.params;
  const url = new URL(request.url);
  const page = await runPayPageJob({
    db: supabaseBilling, now: new Date(), token: decodeURIComponent(token), method,
    stateOnly: method === 'GET' && url.searchParams.get('state') === '1',
  });
  if (page.redirect === true) {
    const location = payPagePath(request.headers.get('host'), decodeURIComponent(token), url.pathname);
    return new NextResponse(null, { status: 303, headers: { location, 'cache-control': 'no-store' } }) as NextResponse;
  }
  const headers = page.contentType === 'json' ? { ...HTML, 'content-type': 'application/json; charset=utf-8' } : HTML;
  return new NextResponse(page.html, { status: page.status, headers }) as NextResponse;
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  return respond(request, context, 'GET');
}

/** «Шинэ QR код авах»: a new code, then back to GET. */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  return respond(request, context, 'POST');
}
