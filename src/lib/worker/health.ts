/**
 * The health worker's decision logic — the scheduled half of the silence watchdog, and
 * since 2026-09-06 the stranded-event sweep that runs beside it.
 *
 * Same shape as `worker/reception.ts` and for the same reason: a Next.js route handler is
 * awkward to test for uninteresting reasons, so anything that branches lives here and
 * returns `{ status, body }`, and the route becomes an adapter thin enough that reading it
 * is the same as verifying it.
 *
 * ## It is scheduled through QStash, and that is deliberate
 *
 * QStash already schedules and already signs, the verifier already exists, and both signing
 * keys are already required by `preflight`. A cron with a bearer secret would add a third
 * authentication path and a credential to rotate, to do a thing one of the existing paths
 * does. **Nothing here spends money at a provider** — it reads rows and may send one
 * Telegram message — which is what makes a scheduled trigger appropriate at all; the
 * sibling repo's rule (`NOTHING SPENDS ON A SCHEDULE`) is about unattended model calls, and
 * this makes none.
 *
 * ## 503 rather than 200 when the run cannot read
 *
 * A watchdog that cannot read its own inputs must be retried, not marked done. Reporting
 * "0 channels checked" with a 200 is the watchdog failing exactly the way it exists to
 * catch: quietly, with everything green.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { runSilenceWatch } from '../health/watch.ts';
import { sweepStrandedEvents, type SweepInput } from '../health/stranded.ts';

export type HealthEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (rawBody: string, signature: string | null) => Promise<boolean>;
  /** How the sweep re-publishes a job that never reached the queue. */
  enqueue: SweepInput['enqueue'];
};

export type HealthJobResult = { status: number; body: Record<string, unknown> };

export async function runHealthJob(
  effects: HealthEffects,
  input: { rawBody: string; signature: string | null },
): Promise<HealthJobResult> {
  if (!(await effects.verifySignature(input.rawBody, input.signature))) {
    return { status: 401, body: { error: 'bad_signature' } };
  }

  const run = await runSilenceWatch(effects.db, { now: effects.now });
  if (!run.ok) return { status: 503, body: { error: 'unavailable', detail: run.detail } };

  // Two different faults, both scheduled here because both are cheap reads and neither
  // spends anything: the watch asks whether messages are ARRIVING, the sweep asks whether
  // an arrived one was ever picked up. The first real webhook was lost in the gap between
  // those questions — arriving fine, never queued, and every silence signal green.
  const sweep = await sweepStrandedEvents(effects.db, { now: effects.now, enqueue: effects.enqueue });
  if (!sweep.ok) return { status: 503, body: { error: 'unavailable', detail: sweep.detail } };

  // The counts, not the verdicts: this body goes to QStash's delivery log, and a channel's
  // health belongs in `channel_health` and the alert rather than in a queue receipt.
  const counts: Record<string, number> = {};
  for (const v of run.verdicts) counts[v.diagnosis.state] = (counts[v.diagnosis.state] ?? 0) + 1;

  // Counts by action, for the same reason: which events were rescued and which were
  // retired is in `webhook_events` and in the alerts, not in a queue receipt.
  const sweptCounts: Record<string, number> = {};
  for (const e of sweep.swept) sweptCounts[e.action] = (sweptCounts[e.action] ?? 0) + 1;

  return {
    status: 200,
    body: { checked: run.checked, states: counts, swept: sweptCounts },
  };
}
