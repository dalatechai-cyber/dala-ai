/**
 * The stranded-event sweep: an inbound event that was claimed and never queued.
 *
 * This is §3.6.3's sweeper, built. The design called for it in place of the ancestor's
 * degraded inline path — *"a cron … selects `inbound_events where state in
 * ('pending_enqueue','persist_deferred')` … re-publishing with the same
 * `deduplicationId`. Older rows → `state='expired_unqueued'`"* — and it was the last
 * unbuilt piece of H7's second floor. The state names moved as the schema was built:
 * here `pending_enqueue` is written *after* a successful publish, so the two states that
 * mean "claimed, never published" are `received` and `failed`, which is what
 * `UNQUEUED_STATES` holds.
 *
 * ## The failure it exists for happened, on the first real webhook
 *
 * 2026-09-06 01:17:26 UTC. Meta delivered, the signature verified, the tenant resolved,
 * the row was claimed — and the enqueue was refused because the deduplication id carried a
 * colon. The route 500'd, Meta retried twice, both retries were skipped as duplicates and
 * answered **200**, Meta stopped, and event 1 sat in `failed` with `attempts 0` and
 * `replied_at null`. Nothing existed that would ever pick it up again. The colon is fixed
 * and a redelivery is now re-enqueued, but both of those depend on Meta trying again;
 * this does not.
 *
 * ## Why the silence watchdog cannot see it
 *
 * `health/watch.ts` measures whether webhooks and customer messages are *arriving*. In this
 * incident they arrived: `last_webhook_at` was fresh, the channel read healthy, and the
 * customer was still waiting. Silence and strandedness are different faults, and a
 * watchdog that only watches arrivals reports green through the whole of this one.
 *
 * ## Two CLASSES of candidate, and they fail differently (D-040)
 *
 * **Claimed and never published** — `received`, `failed`. Nothing else in the system was
 * ever going to act on these; the story above is one of them.
 *
 * **Published and never delivered** — `pending_enqueue`. QStash accepted the message and
 * the worker never ran it. Until D-040 this class was swept by nothing and alerted by
 * nothing: `pending_enqueue` is written *after* a successful publish, so it is correctly
 * absent from `neverReachedQueue`, and the sweep read its candidate list from that same
 * constant. §3.6.3's original text DID name `pending_enqueue`; the state's meaning moved
 * during implementation and the sweep followed it, which left the gap.
 *
 * The two get different graces, and that is the whole safety argument. A `received` row is
 * nobody's job after five minutes. A `pending_enqueue` row is QStash's job until QStash
 * gives up, and re-publishing before then races a retry that is still coming. Every
 * completed worker run leaves a terminal state, so a row still reading `pending_enqueue`
 * past that horizon has not been processed and never will be.
 *
 * ## Two arms, split at the tenant's own reply-age limit
 *
 * **Younger than the limit → re-publish.** The job body is five ids the candidate row
 * already carries, so a rescue costs one QStash publish. It is safe to repeat: the
 * deduplication id is derived from the same `(provider, dedup_key)`, so a publish racing
 * the original collapses to one message, and past QStash's dedup window the worker still
 * refuses to answer an event that already has a reply.
 *
 * **Older than the limit → expire.** `tenants.max_reply_age_minutes` is the same knob
 * `worker/freshness.ts` refuses on: past it no reply would be sent anyway, so re-publishing
 * would only spend a model call to produce a `reply_too_late`. The row is marked
 * `expired_unqueued` — the state `0001` named for exactly this and nothing had ever
 * written — and flagged to the founder. `expired_unqueued` is deliberately not in
 * `neverReachedQueue`, so a later redelivery is skipped rather than re-driven; the
 * customer's text is not lost either way, because `raw_payload` still holds the delivery.
 *
 * ## It alerts whenever it finds anything at all
 *
 * §3.6.3's rule, and the reason is that this sweep is the SECOND floor: finding a row here
 * means the first one — the webhook route publishing inline — failed. A rescue that heals
 * silently would hide a recurring fault behind a working system. Each alert is keyed on
 * the event id, so it is said once and never repeated.
 *
 * ## An unreadable sweep is a failed run, never an empty one
 *
 * Same rule as `watch.ts`: reporting "0 stranded" because a read failed is the watchdog
 * acquiring the defect it exists to detect. Both reads refuse the whole run instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert } from '../alerts/alert.ts';
import { markEventState, QUEUED_STATES, UNQUEUED_STATES } from '../webhook/events.ts';
import type { EnqueueResult } from '../queue/qstash.ts';
import { DEFAULT_REPLY_AGE_LIMIT_MINUTES, replyAgeLimitMinutes } from '../worker/freshness.ts';

/**
 * How many events one run will handle. §3.6.3 asks for a row ceiling; this is it.
 *
 * A bound rather than a page: if a run ever finds more than this, something systemic is
 * broken and the first hundred alerts say so as clearly as a thousand would. The next run
 * takes the rest, because every event this one touches changes state and drops out of the
 * candidate set.
 */
export const SWEEP_LIMIT = 100;

/**
 * How long an event is left alone before the sweep will touch it.
 *
 * `received` has two meanings — "the route died between the claim and the publish" and
 * "another request is still in flight" — and only the age tells them apart. Meta's own
 * retries arrive within seconds, and the route's lease is 60 s, so five minutes is well
 * clear of both while still being far shorter than any tenant's reply-age limit.
 */
export const RETRY_GRACE_MINUTES = 5;

/**
 * How long a PUBLISHED event is left to QStash before the sweep will touch it.
 *
 * **MEASURED 2026-09-21, and the previous value was 15x too long.** This said the horizon
 * was "tens of minutes, not hours", sized from Upstash's documented shape because their
 * docs are unreachable from this environment, and it carried an explicit [UNVERIFIED] note
 * saying that if the horizon were ever measured AND LONGER this number should move. It was
 * measured and it is far shorter. Event 266, published with the same `retries: 3` every
 * reception job uses, was delivered at 02:02:24, 02:02:47 and 02:05:27 and never again:
 * the entire retry horizon is about **three minutes**.
 *
 * Ten is a bit over three times the measured horizon. The asymmetry the old text described
 * is real — too short means re-publishing on top of a retry still in flight — but it was
 * being paid at 45 minutes against a 3-minute risk, and the cost was a customer going
 * unnoticed for 57 minutes.
 *
 * **Double-answering does not rest on this number alone**, which is what makes tightening
 * it safe. `worker/reception.ts` asks `findReplyFor` whether this exact inbound message
 * already produced a reply and skips it if so (D-029). The grace avoids the wasted work of
 * a racing re-publish; the reply guard is what prevents a second answer, and it holds at
 * any grace.
 *
 * ## This is now the BACKSTOP, not the detector
 *
 * Since D-110 the worker raises `webhook.delivery_exhausted` itself on QStash's final
 * delivery, about three minutes in, with the real delivery count and the real refusal. What
 * reaches this sweep is the narrower class the worker cannot speak for: events that never
 * arrived at the worker at all. Those are still found no sooner than the next run of the
 * health worker, which is hourly and scheduled in the QStash console rather than here — so
 * the floor on detecting a never-delivered event is that cadence, not this constant.
 */
export const QUEUED_GRACE_MINUTES = 10;

export type SweepAction =
  /** Re-published to QStash, and the row now reads `pending_enqueue`. */
  | 'requeued'
  /**
   * QStash answered 200 and REFUSED the duplicate: it still holds the original message
   * under the same `deduplicationId`, so nothing new was queued. Distinct from `requeued`
   * because the two have opposite consequences and one wording covering both is how this
   * sweep came to tell the founder something untrue (D-110).
   */
  | 'requeue_deduplicated'
  /** The publish was refused. The row is untouched, so the next run tries again. */
  | 'requeue_failed'
  /** Past the reply-age limit: marked `expired_unqueued`, founder told. */
  | 'expired'
  /** Past the limit, but the alert could not be recorded — so the row was left visible. */
  | 'expire_deferred';

export type SweptEvent = {
  eventId: number;
  tenantId: string;
  channelId: string | null;
  provider: string;
  dedupKey: string;
  state: string;
  ageMinutes: number;
  limitMinutes: number;
  action: SweepAction;
  detail: string | null;
};

export type SweepOutcome =
  | { ok: true; candidates: number; swept: SweptEvent[] }
  | { ok: false; detail: string };

export type SweepInput = {
  now: Date;
  /** Injected so a test proves the re-publish without a queue. */
  enqueue: (job: {
    provider: string; dedupKey: string; eventId: number; tenantId: string; channelId: string;
  }) => Promise<EnqueueResult>;
  limit?: number;
};

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export async function sweepStrandedEvents(db: SupabaseClient, input: SweepInput): Promise<SweepOutcome> {
  const graceIso = new Date(input.now.getTime() - RETRY_GRACE_MINUTES * 60_000).toISOString();
  const queuedGraceMs = input.now.getTime() - QUEUED_GRACE_MINUTES * 60_000;

  const { data, error } = await db
    .from('webhook_events')
    // Both state lists come from `webhook/events.ts` rather than being spelled again here:
    // this query and `neverReachedQueue` are two halves of one definition, and a third
    // state added to one and not the other is a class of event nothing ever sweeps. That
    // is not hypothetical — it is exactly how `pending_enqueue` went unswept (D-040).
    .select('id, provider, dedup_key, tenant_id, channel_id, state, received_at, attempts')
    .in('state', [...UNQUEUED_STATES, ...QUEUED_STATES])
    // `replied_at` was READ here and written by nothing until 2026-09-14, so this filter
    // could not exclude a single row: every row in the table satisfied it. Harmless only
    // because the state list above carried the entire load — and it would have become
    // load-bearing the moment somebody widened that list trusting this. An assertion that
    // cannot fail, sitting inside the sweep built to break a silence, which is the shape
    // D-057 is named for. `markEventState` stamps it now when an entry produced a reply,
    // so the two filters are independent again and this one means what it says.
    .is('replied_at', null)
    // An UNROUTED event is claimed for diagnosis and deliberately never queued — a Page we
    // do not serve. Without this every one of them would look stranded forever, and the
    // alert that matters would arrive among them.
    .neq('routing', 'unrouted')
    .lt('received_at', graceIso)
    .order('received_at')
    .limit(input.limit ?? SWEEP_LIMIT);
  if (error) return { ok: false, detail: `webhook_events unreadable: ${error.message}` };

  // The longer grace for the published class, applied here rather than in the filter.
  // PostgREST can express a per-state cutoff with `.or()`, and this is more legible: the
  // query already returns oldest-first, so what this drops is the NEWEST `pending_enqueue`
  // rows — precisely the ones QStash may still be retrying. They come back next run.
  const candidates = rows(data).filter((r) => {
    if (!(QUEUED_STATES as readonly string[]).includes(str(r['state']))) return true;
    const at = new Date(str(r['received_at'])).getTime();
    // An unreadable timestamp reads as infinitely old in the loop below, and must not be
    // excluded here — that would restore the silence this sweep exists to break.
    return Number.isNaN(at) || at < queuedGraceMs;
  });
  if (candidates.length === 0) return { ok: true, candidates: 0, swept: [] };

  // One read for every tenant named by a candidate. A tenant we cannot read falls back to
  // the platform default rather than skipping the event — an event whose tenant is missing
  // is more suspicious than one whose tenant is present, not less.
  const tenantIds = [...new Set(candidates.map((r) => str(r['tenant_id'])).filter((id) => id !== ''))];
  const limits = new Map<string, number>();
  if (tenantIds.length > 0) {
    const { data: tenantData, error: tenantErr } = await db
      .from('tenants')
      .select('id, max_reply_age_minutes')
      .in('id', tenantIds);
    if (tenantErr) return { ok: false, detail: `tenants unreadable: ${tenantErr.message}` };
    for (const t of rows(tenantData)) limits.set(str(t['id']), replyAgeLimitMinutes(t['max_reply_age_minutes']));
  }

  const swept: SweptEvent[] = [];
  for (const raw of candidates) {
    const receivedAt = new Date(str(raw['received_at']));
    // An unparseable timestamp is not a time. Treating NaN as a date makes every comparison
    // false and the event invisible forever, which is the bug this file exists to prevent —
    // so it reads as infinitely old and is expired rather than left.
    const ageMinutes = Number.isNaN(receivedAt.getTime())
      ? Number.POSITIVE_INFINITY
      : (input.now.getTime() - receivedAt.getTime()) / 60_000;

    const eventId = Number(raw['id']);
    const tenantId = str(raw['tenant_id']);
    const channelId = str(raw['channel_id']) === '' ? null : str(raw['channel_id']);
    const provider = str(raw['provider']);
    const dedupKey = str(raw['dedup_key']);
    const state = str(raw['state']);
    const limitMinutes = limits.get(tenantId) ?? DEFAULT_REPLY_AGE_LIMIT_MINUTES;

    // The two classes fail at different places, and an alert that names the wrong one
    // sends the reader to the wrong system. "Never queued" points at this route; "never
    // delivered" points at QStash; "delivered and refused" points at the worker — at US.
    //
    // That third case used to be unsayable and was therefore said wrong. `pending_enqueue`
    // was read as "QStash never delivered it", on the premise that every completed worker
    // run leaves a terminal state. A run that returns 503 leaves NO terminal state on
    // purpose, so the state means "no run completed" and never "no run happened". On
    // 2026-09-21 the founder was told event 266 was never delivered; production logs show
    // three deliveries in three minutes, all refused by our own matcher (D-110).
    //
    // `attempts` is now written on every delivery, so the count is read rather than
    // inferred. A row from before that column went live reads 0 and takes the old wording,
    // which is the honest answer for an event nothing counted.
    //
    // The zero case is deliberately NOT written as "never delivered". `attempts` is written
    // by the worker after it reads the event row, so a delivery that died before that — an
    // unreadable row, a rejected signature, or the counter write itself failing — leaves the
    // column at 0 while QStash's log shows a delivery. Asserting the stronger claim is the
    // original defect with a new cause, so the branch names both places to look. Splitting a
    // verdict and leaving the new branch covering two states is D-062's third turn of the
    // screw; this one says so instead.
    const attempts = typeof raw['attempts'] === 'number' ? raw['attempts'] : 0;
    const fault = !(QUEUED_STATES as readonly string[]).includes(state)
      ? 'was claimed and never queued'
      : attempts > 0
        ? `was delivered to the worker ${attempts} time(s) and refused every time`
        : 'has no recorded delivery attempt — either QStash never delivered it, or every '
          + 'delivery failed before the worker could read the row. Check QStash\'s message '
          + 'log before concluding which';

    const record = (action: SweepAction, detail: string | null): void => {
      swept.push({
        eventId, tenantId, channelId, provider, dedupKey, state,
        ageMinutes: Number.isFinite(ageMinutes) ? Math.floor(ageMinutes) : -1,
        limitMinutes, action, detail,
      });
    };

    // ── Still answerable: re-publish ────────────────────────────────────────────────
    // A routed event without a channel cannot be turned back into a job, so it waits for
    // the expiry arm rather than being dropped here.
    if (ageMinutes < limitMinutes && channelId !== null) {
      const again = await input.enqueue({ provider, dedupKey, eventId, tenantId, channelId });
      // Three outcomes, not two. A deduplicated publish returns `ok` and queues NOTHING —
      // QStash still holds the original message under the same id — so reading it as a
      // rescue would report a customer as saved who is not. The state is still advanced,
      // because `pending_enqueue` is exactly true of a row QStash holds a message for.
      let outcome: string;
      if (!again.ok) {
        // The row is left exactly as it was, so the next run tries again. Marking it
        // anything else would retire an event that never reached the queue.
        record('requeue_failed', again.detail);
        outcome = `and REFUSED: ${again.detail}`;
      } else if (again.deduplicated) {
        const marked = await markEventState(db, eventId, 'pending_enqueue');
        record('requeue_deduplicated', marked.ok ? null : `state not advanced: ${marked.detail ?? ''}`);
        outcome = 'and QStash REFUSED THE DUPLICATE — it still holds the original message, '
          + 'so nothing new was queued and nothing new will be delivered';
      } else {
        const marked = await markEventState(db, eventId, 'pending_enqueue');
        record('requeued', marked.ok ? null : `state not advanced: ${marked.detail ?? ''}`);
        outcome = 'successfully';
      }
      // §3.6.3: alert whenever anything is found. A rescue means the primary floor failed.
      await raiseAlert(db, {
        tenantId,
        severity: 'warn',
        kind: 'webhook.requeued',
        dedupKey: `requeued_event:${eventId}`,
        body: `Inbound event ${eventId} (${provider} ${dedupKey}) ${fault}; `
          + `re-published ${outcome}. `
          + `State was ${state}, ${Math.floor(ageMinutes)} min old.`,
      });
      continue;
    }

    // ── Past the limit: expire ──────────────────────────────────────────────────────
    // The body carries ids, never message text: since D-039 `dedup_key` is page id, entry
    // index, a digest of Meta's own ids and the app slug, and nothing a customer wrote.
    const alert = await raiseAlert(db, {
      tenantId,
      severity: 'critical',
      kind: 'webhook.stranded_event',
      dedupKey: `stranded_event:${eventId}`,
      body: `Inbound event ${eventId} (${provider} ${dedupKey}) ${fault}. `
        + `State ${state}, ${Number.isFinite(ageMinutes) ? `${Math.floor(ageMinutes)} min old` : 'age unreadable'}, `
        + `past this tenant's ${limitMinutes}-minute reply limit. `
        + `The customer was not answered; the delivery is in webhook_events.raw_payload.`,
    });

    // Expire only once the condition is recorded. `failed` is the one outcome where the
    // `alerts` row does not exist, so leaving the event unmarked is what gets it swept
    // again on the next run instead of disappearing into a state nobody was told about.
    if (alert.outcome === 'failed') {
      record('expire_deferred', alert.detail);
      continue;
    }
    const marked = await markEventState(db, eventId, 'expired_unqueued');
    record(marked.ok ? 'expired' : 'expire_deferred', marked.ok ? null : marked.detail);
  }

  return { ok: true, candidates: candidates.length, swept };
}
