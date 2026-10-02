/**
 * Ора asks for the invoice of one pack order (0081). Signed by Ора with
 * `ORA_PLATFORM_SECRET`; every decision is in `@/lib/billing/ora`, where a test reaches it.
 */
import { NextResponse } from 'next/server';
import { supabaseBilling } from '@/lib/supabase/clients';
import { ORA_BODY_LIMIT, runOraPackInvoiceJob } from '@/lib/billing/ora';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function POST(request: Request): Promise<NextResponse> {
  // A declared size over the limit is refused before the body is read.
  if (Number(request.headers.get('content-length') ?? '0') > ORA_BODY_LIMIT) {
    return NextResponse.json({ error: 'too_large' }, { status: 413, headers: NO_STORE });
  }
  try {
    const result = await runOraPackInvoiceJob({
      db: supabaseBilling,
      now: new Date(),
      rawBody: await request.text(),
      signature: request.headers.get('x-ora-signature'),
    });
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch {
    // Rule 2: anything unexpected (a missing database key, a body that cannot be read) is a
    // 503 Ора retries, never an invoice.
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }
}
