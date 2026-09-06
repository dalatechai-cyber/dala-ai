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
import { markEventState, UNQUEUED_STATES } from '../webhook/events.ts';
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

export type SweepAction =
  /** Re-published to QStash, and the row now reads `pending_enqueue`. */
  | 'requeued'
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

  const { data, error } = await db
    .from('webhook_events')
    // The state list comes from `webhook/events.ts` rather than being spelled again here:
    // this query and `neverReachedQueue` are two halves of one definition, and a third
    // state added to one and not the other is a class of event nothing ever sweeps.
    .select('id, provider, dedup_key, tenant_id, channel_id, state, received_at')
    .in('state', [...UNQUEUED_STATES])
    .is('replied_at', null)
    // An UNROUTED event is claimed for diagnosis and deliberately never queued — a Page we
    // do not serve. Without this every one of them would look stranded forever, and the
    // alert that matters would arrive among them.
    .neq('routing', 'unrouted')
    .lt('received_at', graceIso)
    .order('received_at')
    .limit(input.limit ?? SWEEP_LIMIT);
  if (error) return { ok: false, detail: `webhook_events unreadable: ${error.message}` };

  const candidates = rows(data);
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
      if (!again.ok) {
        // The row is left exactly as it was, so the next run tries again. Marking it
        // anything else would retire an event that never reached the queue.
        record('requeue_failed', again.detail);
      } else {
        const marked = await markEventState(db, eventId, 'pending_enqueue');
        record('requeued', marked.ok ? null : `state not advanced: ${marked.detail ?? ''}`);
      }
      // §3.6.3: alert whenever anything is found. A rescue means the primary floor failed.
      await raiseAlert(db, {
        tenantId,
        severity: 'warn',
        kind: 'webhook.requeued',
        dedupKey: `requeued_event:${eventId}`,
        body: `Inbound event ${eventId} (${provider} ${dedupKey}) was claimed and never queued; `
          + `re-published ${again.ok ? 'successfully' : `and REFUSED: ${again.detail}`}. `
          + `State was ${state}, ${Math.floor(ageMinutes)} min old.`,
      });
      continue;
    }

    // ── Past the limit: expire ──────────────────────────────────────────────────────
    // The body carries ids, never message text: `dedup_key` is page id, entry index,
    // payload size and app slug, and nothing a customer wrote.
    const alert = await raiseAlert(db, {
      tenantId,
      severity: 'critical',
      kind: 'webhook.stranded_event',
      dedupKey: `stranded_event:${eventId}`,
      body: `Inbound event ${eventId} (${provider} ${dedupKey}) was claimed and never queued. `
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
