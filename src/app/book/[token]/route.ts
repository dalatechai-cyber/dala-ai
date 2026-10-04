/**
 * The deposit page for one held time (in-chat booking). The path segment is a signed link
 * (`@/lib/booking/links`); the page is `@/lib/booking/page`. Nothing in this file branches on
 * a decision: `@/lib/booking/jobs`.
 */
import { NextResponse } from 'next/server';
import { supabaseBookingIfSet } from '@/lib/supabase/clients';
import { payPageRoute } from '@/lib/booking/jobs';
import { bookingPortsFromEnv } from '@/lib/booking/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A settle (QPay token, a check per invoice, a calendar write) or a new code: under a minute.
export const maxDuration = 60;

const HTML = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
} as const;

async function respond(request: Request, context: { params: Promise<{ token: string }> }, method: 'GET' | 'POST'): Promise<NextResponse> {
  const { token } = await context.params;
  const url = new URL(request.url);
  let raw = token;
  try { raw = decodeURIComponent(token); } catch { /* a malformed escape: verified as given, so a 404 */ }
  const page = await payPageRoute(bookingPortsFromEnv, {
    token: raw, method, stateOnly: method === 'GET' && url.searchParams.get('state') === '1',
  }, supabaseBookingIfSet);
  if (page.redirect === true) {
    return new NextResponse(null, { status: 303, headers: { location: url.pathname, 'cache-control': 'no-store' } }) as NextResponse;
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
