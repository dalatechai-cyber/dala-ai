/**
 * QPay's `callback_url` for in-chat booking deposits. The signed `t` names the hold; the body
 * is never read. The handler asks QPay itself (`settleHold`), so a forged callback can at most
 * make the platform look sooner. GET and POST, as billing's: QPay's method is not documented.
 */
import { NextResponse } from 'next/server';
import { callbackRoute } from '@/lib/booking/jobs';
import { bookingPortsFromEnv } from '@/lib/booking/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: Request): Promise<NextResponse> {
  const result = await callbackRoute(bookingPortsFromEnv, new URL(request.url).searchParams.get('t') ?? '');
  return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
