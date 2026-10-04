/**
 * The booking sweep, every minute by QStash: unpaid holds past their time are released (QPay
 * asked one last time), paid holds not yet in the calendar are written, late payments are
 * read. With `BOOKING_MODE` unset it answers "disabled". Nothing here branches.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseBooking } from '@/lib/supabase/clients';
import { sweepRoute } from '@/lib/booking/jobs';
import { liveBookingPorts } from '@/lib/booking/live';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  const result = await sweepRoute(
    () => liveBookingPorts(supabaseBooking()),
    (raw, signature) => verifyQStashSignature(raw, signature),
    await request.text(),
    request.headers.get('upstash-signature'),
  );
  return NextResponse.json(result.body, { status: result.status });
}
