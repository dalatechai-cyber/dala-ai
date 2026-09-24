/**
 * The alert raised when QStash's quick retries are spent and the worker refused every one.
 *
 * It lived inline in `app/api/workers/reception/route.ts`, which made it the one decision in
 * the reception path no test could reach — and it is the decision that sent the founder 37
 * false criticals in two days. It is here now, with its effects passed in, for the same
 * reason `worker/reception.ts` is: a branch nothing checks is a branch nobody knows is wrong.
 *
 * ## Two outcomes, and the second is new
 *
 * **Page the founder** — `critical`, `route: 'now'`, once per event. A customer wrote to a
 * live business and Dala AI failed to answer them. Unchanged, including every wording that
 * depends only on values actually read (D-110).
 *
 * **Record a lost mirror draft** — `warn`, `route: 'digest'`, once per event. Only when the
 * channel would not have sent our reply anyway AND the Page answered the customer (see
 * `health/answered.ts`). Nobody was waiting, so nothing pages; but the mirror lost a turn,
 * and the 09:00 digest counts it. Silencing it entirely would make "the mirror is failing
 * on every message" look exactly like a quiet day, which is how `canned_stale` ran for two
 * and a half days with the only signal being the alerts this removes.
 *
 * ## "No retries left" was measured wrong, and the body no longer says it
 *
 * The old body said *"QStash has no retries left, so nothing else will pick it up."* On
 * 2026-09-24 events 731, 733, 735 and 737 each got a FOURTH delivery about 33 minutes after
 * the first (`attempts = 4`; Vercel logs at 05:48:39 and 05:49:06 show `reply_too_late`,
 * age 33 min). `retries: 3` is four deliveries. The alert still fires on the third, which is
 * right for Matrix — the fourth lands past its 15-minute limit — but the sentence was false.
 * (Event 266 on 2026-09-21 got no fourth; why is not established, which is one more reason
 * the body states the measurement rather than a rule.)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert } from '../alerts/alert.ts';
import {
  DRAFT_LOST_KIND, draftLostDedupKey, routeUnansweredAlert, type CustomerTurn,
} from '../health/answered.ts';

export type ExhaustedInput = {
  tenantId: string;
  eventId: number;
  attempts: number;
  /** NaN when `received_at` could not be read. Never reported as a number. */
  ageMinutes: number;
  /** NULL when the job refused before it read the tenant row — see `WorkerEffects`. */
  limitMinutes: number | null;
  /** The status code the worker answered QStash with, e.g. `worker.reception_retry`. */
  code: string;
  /** What that code meant this time, e.g. `canned_stale: …`. Null when none was recorded. */
  detail: string | null;
  channelId: string | null;
  /** `tenant_channels.delivery_mode`, or null when the job refused before reading it. */
  deliveryMode: string | null;
  /** `tenant_channels.meta_app_id` — Meta's id for OUR app, never the callback slug. */
  ourAppId: string | null;
  /** The customer messages in the event. Empty when the job refused before extracting. */
  turns: readonly CustomerTurn[];
};

export type ExhaustedOutcome = 'paged' | 'recorded_lost_draft' | 'alert_failed' | 'duplicate';

/** Clipped by code point: a detail can carry Mongolian, and half a character is mojibake. */
function clip(text: string, max: number): string {
  const cps = [...text.replace(/\s+/g, ' ').trim()];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max - 1).join('')}…`;
}

export async function raiseDeliveryExhausted(db: SupabaseClient, input: ExhaustedInput): Promise<ExhaustedOutcome> {
  const reason = input.detail === null || input.detail === ''
    ? input.code
    : `${input.code} — ${clip(input.detail, 160)}`;

  const route = await routeUnansweredAlert(db, {
    tenantId: input.tenantId, channelId: input.channelId, deliveryMode: input.deliveryMode,
    ourAppId: input.ourAppId, turns: input.turns,
  });

  if (!route.page) {
    const res = await raiseAlert(db, {
      tenantId: input.tenantId,
      severity: 'warn',
      kind: DRAFT_LOST_KIND,
      dedupKey: draftLostDedupKey(input.eventId),
      route: 'digest',
      repeat: 'daily',
      body: `Inbound event ${input.eventId}: the shadow draft was lost after ${input.attempts} deliveries `
        + `(${reason}). The Page answered the customer ${Math.round(route.slowestSeconds)}s after they wrote, `
        + 'so nobody was waiting on Dala AI.',
    });
    if (res.outcome === 'failed') return 'alert_failed';
    return res.outcome === 'suppressed_duplicate' ? 'duplicate' : 'recorded_lost_draft';
  }

  const age = Number.isFinite(input.ageMinutes) ? Math.floor(input.ageMinutes) : null;
  const limit = input.limitMinutes;
  // Every arm below is reachable only from values that were actually READ. A NaN age or a
  // limit the job never got to is reported as unknown rather than substituted: the platform
  // default (30) is twice Matrix's real limit (15), so a substitution would print a deadline
  // that is wrong in the generous direction.
  const outcome = limit === null
    ? 'This delivery failed before the tenant\'s reply limit could be read, so how long a human '
      + 'has is UNKNOWN from here — read tenants.max_reply_age_minutes. Assume little time.'
    : age === null
      ? `Age unreadable, so whether this is still inside the tenant's ${limit}-minute reply `
        + 'limit is unknown; a human reply now beats a late bot reply.'
      : age < limit
        ? `A human can still answer: about ${limit - age} min left of this tenant's ${limit}-minute reply limit.`
        : `Past this tenant's ${limit}-minute reply limit; a human reply now beats a late bot reply.`;

  const res = await raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'critical',
    kind: 'webhook.delivery_exhausted',
    dedupKey: `delivery_exhausted:${input.eventId}`,
    // Passed rather than defaulted. Both happen to be the defaults today, and this alert's
    // whole character — one Telegram message, once, never resolving — would change silently
    // if either default moved.
    route: 'now',
    repeat: 'daily',
    body: `Inbound event ${input.eventId} was delivered to the worker ${input.attempts} time(s) and refused `
      + `every time (last: ${reason}). QStash has one retry left, measured at about 33 min after the first `
      + `delivery. ${age === null ? 'Age unreadable' : `${age} min old`}. ${outcome} `
      + `${route.note === null ? '' : `${route.note} `}The delivery is in webhook_events.raw_payload.`,
  });
  if (res.outcome === 'failed') return 'alert_failed';
  return res.outcome === 'suppressed_duplicate' ? 'duplicate' : 'paged';
}
