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
 * ## Every channel that EXPECTS traffic, not only the ones that answer
 *
 * This used to select `delivery_mode = 'live'`, reasoning that a channel in `shadow` is
 * mirroring rather than answering, so its silence is a question about the mirror's quality
 * rather than an outage — and that `went_live_at` is not stamped until the cutover anyway.
 *
 * **The second half was true and made the first half wrong.** Matrix ran fourteen days of
 * `shadow` against real customer traffic; if that subscription broke, the only symptom is
 * an empty table, and the channel was not being looked at. A mirror measuring nothing does
 * not report a bad number — it reports a good one, from no data.
 *
 * So the filter is now every mode that expects webhooks: `shadow_routing`, `shadow`,
 * `live`. `shadow_routing` is included for the strongest reason of the three — its entire
 * purpose is proving that routing works, so silence is precisely the fault it exists to
 * surface. The stream of `unknown` verdicts the old note feared does not appear, because a
 * tenant parked there before its Page is subscribed lands on `not_provisioned`, which is
 * recorded and never paged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { quietRoute, raiseAlert, resolveOpenAlerts } from '../alerts/alert.ts';
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
    .select('id, tenant_id, external_id, last_webhook_at, expects_traffic_since')
    // `in`, not `neq('off')`: a positive allow-list, so a delivery_mode added later is
    // unwatched until somebody decides otherwise rather than watched by accident. Same
    // direction `canDeliver` fails in, for the same reason.
    .in('delivery_mode', ['shadow_routing', 'shadow', 'live'])
    .order('id');
  if (channelErr) return { ok: false, detail: `tenant_channels unreadable: ${channelErr.message}` };

  const verdicts: ChannelVerdict[] = [];

  for (const raw of rows(channelData)) {
    const channelId = str(raw['id']);
    const tenantId = str(raw['tenant_id']);
    const externalId = str(raw['external_id']);
    let tenantTimezone = 'Asia/Ulaanbaatar';
    const verdict = async (diagnosis: ChannelDiagnosis): Promise<void> => {
      verdicts.push({ channelId, tenantId, externalId, diagnosis });
      await record(db, { tenantId, channelId, externalId, diagnosis, now: input.now });
    };

    const [tenant, hoursRes, closuresRes, webhookRes, conversationRes, unroutedRes] = await Promise.all([
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
      // DELIVERIES WE COULD NOT ATTRIBUTE, by Page id.
      //
      // The query above filters on tenant_id and channel_id; an unrouted row has both null,
      // so it is invisible there by construction. Those rows still carry `entry_id`, which
      // is the Page id, and one naming this Page proves Meta is delivering for it whatever
      // happened next. Without this the never-received branch tells an operator to fix a
      // subscription that works — which is what it told the founder five days running.
      db.from('webhook_events')
        .select('received_at')
        .eq('entry_id', externalId)
        .is('tenant_id', null)
        .order('received_at', { ascending: false })
        .limit(1),
    ]);

    const failed = ([
      ['tenants', tenant], ['business_hours', hoursRes], ['tenant_closures', closuresRes],
      ['webhook_events', webhookRes], ['conversations', conversationRes],
      ['webhook_events (unattributed)', unroutedRes],
    ] as const).find(([, res]) => res.error);
    if (failed !== undefined) {
      await verdict({ state: 'unknown', reason: `${failed[0]} unreadable: ${failed[1].error?.message ?? ''}` });
      continue;
    }
    if (tenant.data === null) {
      await verdict({ state: 'unknown', reason: 'no such tenant' });
      continue;
    }
    // Assigned the moment it is known. `verdict()` is also reachable from the two failure
    // paths above, which run before this read has been interpreted — those keep the default,
    // which is the only honest answer when the tenant row could not be read.
    tenantTimezone = str((tenant.data as Record<string, unknown>)['timezone']) || 'Asia/Ulaanbaatar';

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
      unattributedWebhookAt: date(rows(unroutedRes.data)[0]?.['received_at']),
      // `expects_traffic_since`, not `went_live_at` (0023). A shadow channel has no go-live
      // time by definition, and measuring from a null is what made it invisible.
      wentLiveAt: date(raw['expects_traffic_since']),
      timezone: tenantTimezone,
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
 * `healthy` stays false for it, because it is not a channel proven to be working — and the
 * row carries `state` alongside it (0017) so a reader can tell an unfinished form from a
 * dead token without parsing the prose in `reason`. Storing only the boolean would have
 * left the conflation this function stopped making in the alert waiting one layer down for
 * the first dashboard to ask how many channels are unhealthy.
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
    // Both, because they are two spellings of one fact and a CHECK holds them together.
    state: input.diagnosis.state,
    reason: input.diagnosis.reason,
    observed_at: input.now.toISOString(),
  }, { onConflict: 'tenant_id,channel_id' });
  if (error) console.error('[health] channel_health write failed', { channelId: input.channelId, detail: error.message });

  // THE DATE IS GONE FROM THE KEY, and that is the change (0025).
  //
  // It used to be `channel_silence:{channel}:{state}:{localDate}`, and the day was moved
  // from UTC to the tenant's clock because a channel silent across a Ulaanbaatar morning
  // raised two alerts for one trading day. That fix was right about the boundary and wrong
  // about there being a boundary at all: measured 2026-09-14, one unchanged condition had
  // produced a critical Telegram every morning for six days, which is ten of the eleven
  // rows the table then held. A daily alert about yesterday's unchanged fact is the same
  // "trains the operator to skim past it" failure the dated key was introduced to avoid,
  // arriving from a fourth direction — and it lands in the chat that also carries
  // `dalatech-online`'s demo-request notifications, so it was burying messages with a
  // customer on the other end.
  //
  // `on_change` is the policy now: one alert per EPISODE. The state stays in the key, so a
  // channel degrading from `no_messages` to `no_webhooks` still says so immediately rather
  // than being suppressed as a duplicate of a different fault.
  const prefix = `channel_silence:${input.channelId}:`;
  const stateKey = `${prefix}${input.diagnosis.state}`;

  if (healthy) {
    // RECOVERY IS AN EVENT AND HAS TO BE SAID. Closing the episode silently would mean an
    // operator who was paged about a dead channel is never told it came back — and cannot
    // tell that from an alarm that quietly stopped working, which is D-062's whole subject.
    const closed = await resolveOpenAlerts(db, { keyPrefix: prefix, now: input.now });
    if (!closed.ok) {
      console.error('[health] could not resolve open alerts', { channelId: input.channelId, detail: closed.detail });
      return;
    }
    for (const episode of closed.resolved) {
      await raiseAlert(db, {
        tenantId: input.tenantId,
        severity: 'info',
        kind: 'channel.recovered',
        // Keyed on the episode it closes, so it is unrepeatable by construction rather than
        // by a period. `once`, because a recovery is an event: it happened and it is over,
        // and it must never become a standing item in the digest.
        dedupKey: `channel_recovered:${episode.id}`,
        body: `Page ${input.externalId}: recovered — ${episode.kind} is clear.`,
        // The fault it closes went to the digest (founder, 2026-09-20), so an immediate
        // «recovered» is usually news of an outage nobody was told about (inventory B12).
        // Under DAILY_REPORT_V2 the recovery joins it in the daily report.
        route: quietRoute(),
        repeat: 'once',
      });
    }
    return;
  }

  // A provisioning gap is not an outage — and it is not a recovery either. An open episode
  // stays open: losing the ability to measure a channel is no evidence the channel is well,
  // and closing it here would let deleting a `business_hours` row silence a real fault.
  if (!fault) return;

  // A degrade closes the episode it replaces, so one channel cannot appear twice in the
  // digest with one of the entries naming a fault it no longer has.
  const superseded = await resolveOpenAlerts(db, { keyPrefix: prefix, exceptKey: stateKey, now: input.now });
  if (!superseded.ok) {
    console.error('[health] could not supersede open alerts', { channelId: input.channelId, detail: superseded.detail });
  }

  await raiseAlert(db, {
    tenantId: input.tenantId,
    severity: input.diagnosis.state === 'unknown' ? 'warn' : 'critical',
    kind: `channel.${input.diagnosis.state}`,
    dedupKey: stateKey,
    body: `Page ${input.externalId}: ${input.diagnosis.reason}`,
    // DIGEST, NOT `now` — founder's call, 2026-09-20, on measured noise.
    //
    // It paged immediately until then, on the argument that a first fire is genuinely news.
    // Measured over eight days that produced EIGHT criticals, every one of them an ordinary
    // quiet morning: fired 06:00–16:00, cleared one to five hours later, six of the eight
    // with a matching recovery. D-063's addendum predicted exactly this and named the
    // arithmetic — `DEFAULT_THRESHOLD_OPEN_MINUTES = 180` argues from D-016's 60.5
    // replies/day that three open hours carry ~18 replies, and the ancestor's own worker
    // invocations measure 37, 30 and 9 over three days. At 0.9–3.7/hour a three-hour gap is
    // a morning, not a fault.
    //
    // THE THRESHOLD IS NOT TOUCHED, deliberately. D-063 makes re-deriving D-016's 60.5 the
    // precondition for moving it, that is a measurement against the ancestor's logs, and
    // guessing a new number here would be the third tuning of a constant nobody has
    // re-measured. Demoting the route stops the noise without deciding anything early.
    //
    // What this costs, stated rather than discovered: time-to-detect on a REAL outage goes
    // from ~3h to the digest's daily cadence. What stops it being unbounded is the
    // escalation already in `planDigest` — an open critical older than ESCALATE_AFTER_DAYS
    // gets its own Telegram message on every run, so an eleven-day silence like D-062's is
    // still caught, with a three-day ceiling instead of a three-hour one.
    //
    // The RECOVERY above stays `now`. It is `info`, once per episode, and it names the
    // fault it closes — so nothing goes silent, which is the one thing D-063 forbids. The
    // net is eight criticals plus six recoveries a week becoming six info lines.
    //
    // Telegram is shared with `dalatech-online`'s demo requests, so this is not merely
    // tidiness: a daily false critical buries the only messages with a person behind them.
    route: 'digest',
    repeat: 'on_change',
  });
}
