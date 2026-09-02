/**
 * The reception worker. QStash calls this; customers never do.
 *
 * Track 1 stops here deliberately: this endpoint proves the durable hand-off works and
 * NOTHING MORE. No model is called and no money is spent — that is Track 2 (the ledger)
 * and Track 3 (the reply), in that order, so that the first model call the platform ever
 * makes is already metered.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { markEventState } from '@/lib/webhook/events';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  // The raw text, before parsing — QStash signs the body it sent.
  const raw = await request.text();

  if (!(await verifyQStashSignature(raw, request.headers.get('upstash-signature')))) {
    // An unverified caller here is an open endpoint that will later spend money.
    return NextResponse.json({ error: 'worker.signature_invalid' }, { status: 401 });
  }

  let job: { eventId?: unknown; tenantId?: unknown };
  try {
    job = JSON.parse(raw) as typeof job;
  } catch {
    // Malformed after a VALID signature means we published it wrong. Retrying cannot fix
    // that, so 200 to stop the redelivery loop and let the alert carry it.
    console.error('[worker] job_not_json');
    return NextResponse.json({ ok: true, dropped: 'job_not_json' }, { status: 200 });
  }

  const eventId = typeof job.eventId === 'number' ? job.eventId : null;
  if (eventId === null) {
    console.error('[worker] job_missing_event_id');
    return NextResponse.json({ ok: true, dropped: 'job_missing_event_id' }, { status: 200 });
  }

  // Redelivery safety: a crash mid-flight redelivers, and marking processed is idempotent.
  // When Track 3 adds the reply, the send is claimed separately and re-sends the STORED
  // text rather than re-generating — at-least-once generation and at-most-once delivery.
  await markEventState(supabaseWorker(), eventId, 'processed');

  return NextResponse.json({ ok: true, eventId }, { status: 200 });
}
