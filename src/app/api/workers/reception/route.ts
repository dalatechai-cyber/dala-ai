/**
 * The reception worker. QStash calls this; customers never do.
 *
 * ## Track 2 state: the meter is in place before the thing it meters
 *
 * The chokepoint runs here, in full — identity, entitlement, consent, budget — and a
 * reservation is taken. What comes AFTER the reservation is still absent: no Anthropic
 * client is constructed and no reply is generated. That is Track 3.
 *
 * The ordering is the point. By building the meter first, the first model call this
 * platform ever makes is already metered — there is no window in which the code can
 * spend before it can count. The reservation taken here is released immediately, because
 * there is nothing yet to spend it on.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { markEventState } from '@/lib/webhook/events';
import { withTenantRole } from '@/lib/guard/withTenantRole';
import { release } from '@/lib/spend/reserve';
import { usdToNano } from '@/lib/money';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * What one Reception reply is expected to cost, reserved before the call and settled
 * against the real `usage` afterwards. From D-016's measured $0.0090/reply, rounded up:
 * an under-estimate lets a burst slip past the ceiling between reserve and settle.
 */
const RECEPTION_REPLY_ESTIMATE = usdToNano(0.012);

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();

  if (!(await verifyQStashSignature(raw, request.headers.get('upstash-signature')))) {
    return NextResponse.json({ error: 'worker.signature_invalid' }, { status: 401 });
  }

  let job: { eventId?: unknown; tenantId?: unknown; conversationId?: unknown };
  try {
    job = JSON.parse(raw) as typeof job;
  } catch {
    // Malformed after a VALID signature means we published it wrong. Retrying cannot fix
    // that, so 200 to stop the redelivery loop and let the alert carry it.
    console.error('[worker] job_not_json');
    return NextResponse.json({ ok: true, dropped: 'job_not_json' }, { status: 200 });
  }

  const eventId = typeof job.eventId === 'number' ? job.eventId : null;
  const tenantId = typeof job.tenantId === 'string' ? job.tenantId : null;
  if (eventId === null || tenantId === null) {
    console.error('[worker] job_missing_fields');
    return NextResponse.json({ ok: true, dropped: 'job_missing_fields' }, { status: 200 });
  }

  const db = supabaseWorker();
  const now = new Date();

  // The chokepoint. Nothing downstream may re-implement any part of this.
  const guard = await withTenantRole(db, {
    tenantId,
    role: 'reception',
    surface: 'reception',
    channel: 'facebook_page',
    estimate: RECEPTION_REPLY_ESTIMATE,
    conversationId: typeof job.conversationId === 'string' ? job.conversationId : null,
    webhookEventId: eventId,
    now,
  });

  if (!guard.ok) {
    const { refusal } = guard;
    console.warn('[worker] refused', { code: refusal.code, tenantId, eventId });

    // 503 means "we could not determine" — QStash must retry, so the message is not lost.
    if (refusal.status === 503) {
      return NextResponse.json({ error: refusal.code }, { status: 503 });
    }
    // 403/429 are determinate. Retrying cannot change them, so ACK and let the §5.7
    // degradation ladder answer the customer (Track 3). Never silence.
    await markEventState(db, eventId, refusal.status === 429 ? 'shed' : 'blocked_no_token');
    return NextResponse.json({ ok: true, refused: refusal.code }, { status: 200 });
  }

  // ---- Track 3 goes here: the model call, the boundary gate, the send. ----
  // Until it exists there is nothing to spend, so the hold is given straight back rather
  // than left to expire and distort the tenant's headroom for five minutes.
  await release(db, guard.reservation.id);

  await markEventState(db, eventId, 'processed');
  return NextResponse.json({ ok: true, eventId, reserved: guard.reservation.id }, { status: 200 });
}
