/**
 * Client billing, hourly (D-156). QStash calls this; nobody else can (signature). The
 * schedule is ONE QStash schedule, `0 * * * *`, and like the purge and the digest it lives
 * in the QStash console, not in this repository.
 *
 * Nothing here may branch — the decisions are in `@/lib/billing/jobs` and `engine`. With
 * `BILLING_MODE` unset or `off` this answers 200 and does nothing, so the schedule can
 * exist before billing is switched on.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseBilling } from '@/lib/supabase/clients';
import { runBillingWorkerJob } from '@/lib/billing/jobs';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runBillingWorkerJob({
    db: supabaseBilling,
    now: new Date(),
    rawBody: await request.text(),
    signature: request.headers.get('upstash-signature'),
    verifySignature: (raw, signature) => verifyQStashSignature(raw, signature),
  });
  return NextResponse.json(result.body, { status: result.status });
}
