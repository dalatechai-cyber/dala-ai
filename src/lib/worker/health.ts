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
import { checkSecretExpiry, raiseExpiryAlerts } from '../health/secretExpiry.ts';
import { catchUpHeldMessages } from '../channel/catchup.ts';
import { quietRoute, raiseAlert } from '../alerts/alert.ts';
import type { EnqueueResult } from '../queue/qstash.ts';

export type HealthEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (rawBody: string, signature: string | null) => Promise<boolean>;
  /**
   * How the sweep re-publishes a job that never reached the queue, and how the catch-up
   * hands a held message back to the worker (`catchUpMid`).
   */
  enqueue: (job: Parameters<SweepInput['enqueue']>[0] & { catchUpMid?: string }) => Promise<EnqueueResult>;
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

  // Third cheap read on the same schedule, and the only one that is about the FUTURE: the
  // other two ask whether something already went wrong. A credential with a date on it is
  // the one fault this platform can see coming, and until `0035` it could not (D-109).
  //
  // Unreadable is a 503 like the others. "No credential is expiring" and "I could not ask"
  // must not be spelled the same way — that equivalence is what let Matrix go live on a
  // token with forty minutes left.
  const expiry = await checkSecretExpiry(effects.db, { now: effects.now });
  if (!expiry.ok) return { status: 503, body: { error: 'unavailable', detail: expiry.detail } };
  const expiryAlerts = await raiseExpiryAlerts(effects.db, expiry.findings, { now: effects.now });

  // Fourth: a channel that has come back after a halt answers the customers it left waiting
  // (founder, 2026-09-26). Hourly is the latency: the halt page says so. Unreadable is a 503
  // like the rest — "nobody is waiting" and "I could not look" must not read the same.
  const caught = await catchUpHeldMessages(effects.db, { now: effects.now, enqueue: effects.enqueue });
  if (!caught.ok) return { status: 503, body: { error: 'unavailable', detail: caught.detail } };
  const caughtCounts: Record<string, number> = {};
  for (const r of caught.results) caughtCounts[r.action] = (caughtCounts[r.action] ?? 0) + 1;
  for (const r of caught.results.filter((x) => x.action === 'enqueued')) {
    // For the daily report, not a page: the halt already paged, and the founder should not
    // answer by hand a customer the platform has just answered.
    await raiseAlert(effects.db, {
      tenantId: null, severity: 'info', kind: 'channel.catch_up',
      dedupKey: `channel_catch_up:${r.externalId}`, route: quietRoute(), repeat: 'once',
      body: `A message held while its channel was halted was answered after it came back (conversation ${r.conversationId}).`,
    });
  }

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
    body: {
      checked: run.checked, states: counts, swept: sweptCounts, catch_up: caughtCounts,
      // `unknown` is reported beside the findings rather than folded into them: a run that
      // examined ten credentials and knows the expiry of none is not a clean run, and the
      // receipt should not read like one.
      secrets: {
        checked: expiry.checked, unknown: expiry.unknown,
        expiring: expiry.findings.length, alerted: expiryAlerts.raised, alert_failures: expiryAlerts.failed,
        // Episodes closed because the credential stopped being classified that way (D-128),
        // and whether that close could be written — both counts, like the rest.
        resolved: expiryAlerts.resolved, resolve_failures: expiryAlerts.resolveFailed ? 1 : 0,
      },
    },
  };
}
