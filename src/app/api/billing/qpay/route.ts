/**
 * QPay's `callback_url` for DalaTech invoices (D-156). The signed `t` in the URL names the
 * invoice; the request body is never read. The handler asks QPay itself and records only
 * what QPay's own payment check reports, so a forged callback can at most make the platform
 * look sooner. GET and POST both, because which one QPay uses is not documented; the hourly
 * check catches a payment even if this never fires.
 */
import { NextResponse } from 'next/server';
import { supabaseBilling } from '@/lib/supabase/clients';
import { runQpayCallbackJob } from '@/lib/billing/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: Request): Promise<NextResponse> {
  const result = await runQpayCallbackJob({
    db: supabaseBilling,
    now: new Date(),
    token: new URL(request.url).searchParams.get('t') ?? '',
  });
  return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
