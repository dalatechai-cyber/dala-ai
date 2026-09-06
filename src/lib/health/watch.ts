/**
 * The silence watchdog's loader and its run.
 *
 * `silence.ts` measures, `channel.ts` diagnoses; this reads the rows, records the verdict
 * and raises the alert. The split is the one `reception/handle.ts` and `reception/load.ts`
 * already use: the decisions are pure and fully testable, and what is left here is which
 * table, which clock, which alert.
 *
 * ## Every failed read makes the channel `unknown`, never skipped
 *
 * A read error here is tempting to `continue` past — it is only monitoring, after all. But
 * a watchdog that silently drops a channel it could not measure has acquired the exact
 * defect it exists to detect: something is wrong and nothing says so. So a failed read
 * produces an `unknown` verdict with the error in it, which is recorded and visible.
 *
 * ## Only `live` channels
 *
 * A channel in `shadow` is mirroring, not answering; its silence is a question about the
 * mirror's quality rather than an outage, and `went_live_at` is not stamped until the
 * cutover anyway. Watching them would produce a stream of `unknown` verdicts that teach an
 * operator to skim past the ones that matter.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert } from '../alerts/alert.ts';
import { diagnoseChannel, type ChannelDiagnosis } from './channel.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';
import { MAX_LOOKBACK_DAYS } from './silence.ts';

/**
 * Open minutes of silence that count as a fault.
 *
 * Three hours of trading. For Matrix, whose measured traffic is 60.5 replies/day across a
 * ten-hour day (D-016), three open hours would normally carry around eighteen replies — so
 * zero is a strong signal rather than a slow afternoon. It is deliberately a platform
 * constant rather than a column: a per-tenant knob invites tuning a real alert into silence
 * one channel at a time, and there is no measurement yet that would justify a number.
 */
export const DEFAULT_THRESHOLD_OPEN_MINUTES = 180;

export type ChannelVerdict = { channelId: string; tenantId: string; externalId: string; diagnosis: ChannelDiagnosis };

export type WatchOutcome =
  | { ok: true; checked: number; verdicts: ChannelVerdict[] }
  | { ok: false; detail: string };

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  // An unparseable timestamp is not a time. Treating NaN as a Date makes every comparison
  // false and the watchdog silently healthy.
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The later of two times, either of which may be absent. */
function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Run the watchdog over every live channel.
 *
 * Reads are per channel rather than one big join because PostgREST is not a join engine and
 * the number of live channels is, by design, small — two today, and a hundred is still one
 * quiet query per channel per run.
 */
export async function runSilenceWatch(
  db: SupabaseClient,
  input: { now: Date; thresholdOpenMinutes?: number },
): Promise<WatchOutcome> {
  const threshold = input.thresholdOpenMinutes ?? DEFAULT_THRESHOLD_OPEN_MINUTES;

  const { data: channelData, error: channelErr } = await db
    .from('tenant_channels')
    .select('id, tenant_id, external_id, last_webhook_at, went_live_at')
    .eq('delivery_mode', 'live')
    .order('id');
  if (channelErr) return { ok: false, detail: `tenant_channels unreadable: ${channelErr.message}` };

  const verdicts: ChannelVerdict[] = [];

  for (const raw of rows(channelData)) {
    const channelId = str(raw['id']);
    const tenantId = str(raw['tenant_id']);
    const externalId = str(raw['external_id']);
    const verdict = async (diagnosis: ChannelDiagnosis): Promise<void> => {
      verdicts.push({ channelId, tenantId, externalId, diagnosis });
      await record(db, { tenantId, channelId, externalId, diagnosis, now: input.now });
    };

    const [tenant, hoursRes, closuresRes, webhookRes, conversationRes] = await Promise.all([
      db.from('tenants').select('timezone').eq('id', tenantId).maybeSingle(),
      db.from('business_hours').select('weekday, opens, closes, closed').eq('tenant_id', tenantId).order('weekday'),
      // Only closures that could overlap the lookback window. An ancient one cannot change
      // a measurement that never reaches back to it.
      db.from('tenant_closures')
        .select('starts_on, ends_on, title, message')
        .eq('tenant_id', tenantId)
        .gte('ends_on', lookbackDate(input.now))
        .order('starts_on'),
      db.from('webhook_events')
        .select('received_at')
        .eq('tenant_id', tenantId)
        .eq('channel_id', channelId)
        .order('received_at', { ascending: false })
        .limit(1),
      db.from('conversations')
        .select('last_message_at')
        .eq('tenant_id', tenantId)
        .eq('channel_id', channelId)
        .order('last_message_at', { ascending: false })
        .limit(1),
    ]);

    const failed = ([
      ['tenants', tenant], ['business_hours', hoursRes], ['tenant_closures', closuresRes],
      ['webhook_events', webhookRes], ['conversations', conversationRes],
    ] as const).find(([, res]) => res.error);
    if (failed !== undefined) {
      await verdict({ state: 'unknown', reason: `${failed[0]} unreadable: ${failed[1].error?.message ?? ''}` });
      continue;
    }
    if (tenant.data === null) {
      await verdict({ state: 'unknown', reason: 'no such tenant' });
      continue;
    }

    const hours: BusinessHours[] = rows(hoursRes.data).map((r) => ({
      weekday: Number(r['weekday']),
      opens: r['opens'] === null ? null : str(r['opens']),
      closes: r['closes'] === null ? null : str(r['closes']),
      closed: r['closed'] === true,
    }));
    const closures: Closure[] = rows(closuresRes.data).map((r) => ({
      startsOn: str(r['starts_on']), endsOn: str(r['ends_on']),
      title: str(r['title']), message: str(r['message']),
    }));

    const observedWebhookAt = date(rows(webhookRes.data)[0]?.['received_at']);
    // `webhook_events` is subject to retention (`purge_after`), so the events proving this
    // channel once worked can be deleted while the channel is still live. Reading the
    // cached column too means a purge cannot turn "stopped receiving" — a dead token — into
    // "never received", which points at a different screen entirely.
    const lastWebhookAt = latest(observedWebhookAt, date(raw['last_webhook_at']));

    const diagnosis = diagnoseChannel({
      channelId, tenantId, externalId,
      lastWebhookAt,
      lastInboundMessageAt: date(rows(conversationRes.data)[0]?.['last_message_at']),
      wentLiveAt: date(raw['went_live_at']),
      timezone: str((tenant.data as Record<string, unknown>)['timezone']) || 'Asia/Ulaanbaatar',
      hours, closures, thresholdOpenMinutes: threshold, now: input.now,
    });

    await verdict(diagnosis);

    // Persist what the events said, so the fact survives their retention. Written after the
    // verdict so a write failure cannot change one, and best-effort for the same reason:
    // this is a cache, and a stale cache is recoverable where a missed alert is not.
    if (observedWebhookAt !== null) {
      await db.from('tenant_channels').update({ last_webhook_at: observedWebhookAt.toISOString() }).eq('id', channelId);
    }
  }

  return { ok: true, checked: verdicts.length, verdicts };
}

/**
 * The earliest date a closure could still matter, so older ones need not be read.
 *
 * Computed in UTC with a day of slack rather than on the tenant's clock, because the
 * tenant's timezone arrives in the same batch of reads as this filter and waiting for it
 * would cost a second round trip per channel. No offset on earth is more than 26 hours
 * wide, so one extra day cannot exclude a closure the walk could reach.
 *
 * This is a read-narrowing filter, not the correctness boundary: `activeClosure` still
 * matches on the tenant's own local date. Over-reading by a day is free; under-reading
 * would silently turn a holiday into an outage alert.
 */
function lookbackDate(now: Date): string {
  return new Date(now.getTime() - (MAX_LOOKBACK_DAYS + 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

/**
 * Record the verdict and, when it is a fault, alert.
 *
 * `channel_health` is upserted every run — including on healthy — because "this channel was
 * checked at 14:00 and was fine" and "this channel has not been checked since Tuesday" must
 * not look the same. `observed_at` is what tells them apart, and a watchdog that only writes
 * on failure cannot be distinguished from one that stopped running.
 *
 * ## Recorded and alerted are two different questions
 *
 * `not_provisioned` is written like any other verdict and raises nothing. A channel whose
 * tenant has no `business_hours` yet cannot be measured, and saying so once a day forever
 * is not information — it is the alarm learning to be ignored, on the one channel the
 * founder is currently using to decide whether the alerting can be trusted. The row still
 * carries the reason, so the gap is visible to anyone who looks; it just does not page.
 *
 * `healthy` stays false for it, because it is not a channel proven to be working. Nothing
 * reads that column today. The first thing that does must branch on the state in `reason`,
 * or it will re-make in a dashboard the exact conflation this function stopped making in
 * the alert.
 */
async function record(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; externalId: string; diagnosis: ChannelDiagnosis; now: Date },
): Promise<void> {
  const healthy = input.diagnosis.state === 'healthy';
  // A provisioning gap is not an outage: recorded below, never alerted.
  const fault = !healthy && input.diagnosis.state !== 'not_provisioned';

  const { error } = await db.from('channel_health').upsert({
    tenant_id: input.tenantId,
    channel_id: input.channelId,
    healthy,
    reason: input.diagnosis.reason,
    observed_at: input.now.toISOString(),
  }, { onConflict: 'tenant_id,channel_id' });
  if (error) console.error('[health] channel_health write failed', { channelId: input.channelId, detail: error.message });

  if (!fault) return;

  // The day key means a condition that persists re-alerts once tomorrow rather than every
  // run — the same reasoning `alerts/alert.ts` gives for putting the period in the key. The
  // state is in the key too, so a channel that degrades from `no_messages` to `no_webhooks`
  // says so immediately instead of being suppressed as a duplicate of a different fault.
  const dayKey = input.now.toISOString().slice(0, 10);
  await raiseAlert(db, {
    tenantId: input.tenantId,
    severity: input.diagnosis.state === 'unknown' ? 'warn' : 'critical',
    kind: `channel.${input.diagnosis.state}`,
    dedupKey: `channel_silence:${input.channelId}:${input.diagnosis.state}:${dayKey}`,
    body: `Page ${input.externalId}: ${input.diagnosis.reason}`,
  });
}
