/**
 * Ора asks for the invoice of one pack order (0081). Signed by Ора with
 * `ORA_PLATFORM_SECRET`; every decision is in `@/lib/billing/ora`, where a test reaches it.
 */
import { NextResponse } from 'next/server';
import { supabaseBilling } from '@/lib/supabase/clients';
import { runOraPackInvoiceJob } from '@/lib/billing/ora';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runOraPackInvoiceJob({
    db: supabaseBilling,
    now: new Date(),
    rawBody: await request.text(),
    signature: request.headers.get('x-ora-signature'),
  });
  return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
}
