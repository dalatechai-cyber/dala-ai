/**
 * What kind of silence is this?
 *
 * `silence.ts` answers "has this stream gone quiet, in open minutes". This answers the
 * question an operator actually has, which is **which thing is broken**, and it needs two
 * streams to do it because the obvious one is green during the worst failure.
 *
 * ## The standby trap, and why `last_webhook_at` alone is not the watchdog
 *
 * `03-meta-routing.md` §3.7 documents it exactly:
 *
 * > When a Page has the **Page Inbox app as the primary receiver** — the default for many
 * > Pages, and the state a Page enters the moment anyone touches "Automated responses" —
 * > our app is a *secondary* receiver. Meta then delivers messages in `entry[].standby`,
 * > not `entry[].messaging`. The webhook receives a well-formed, correctly-signed,
 * > correctly-routed event for the right tenant, drops it, and returns 200. **Reception AI
 * > answers nobody, and every health signal is green:** `last_webhook_at` is fresh, the
 * > reconciler sees a valid subscription, the token probe passes, `webhook.unrouted` is
 * > zero. The only symptom is the salon phoning the founder.
 *
 * §3.10.5's design for the absence watchdog keys on `last_webhook_at`, and against that
 * failure it is green. So this watches **two** clocks:
 *
 * | Webhooks | Inbound messages kept | Diagnosis | Remedy |
 * |---|---|---|---|
 * | arriving | arriving | healthy | — |
 * | arriving | **stopped** | we are a secondary receiver, or persistence is broken | primary-receiver setting; then the persist path |
 * | **stopped** | stopped | the token died, or Meta unsubscribed the app | re-auth the Page, re-subscribe |
 * | **never any** | never any | the subscription never worked | the app-level field subscription |
 *
 * The last row is `STATUS.md` §5 item 15's warning: a page-level subscribe returns
 * `{"success": true}` even when the app has never enabled that field, and no events are
 * ever delivered. Nothing else would ever notice, because "no events" is what a quiet
 * Tuesday looks like.
 *
 * ## Webhooks first, messages second
 *
 * The order is not cosmetic. If no webhooks are arriving then no messages can be either,
 * so reporting both would be one fault wearing two names — and the second name points at
 * the wrong remedy. The upstream failure wins.
 */
import { assessSilence, type SilenceInput, type SilenceVerdict } from './silence.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';

export type ChannelObservation = {
  channelId: string;
  tenantId: string;
  /** The Page id, for an alert that names something the founder can act on. */
  externalId: string;
  /** Latest webhook receipt of any kind, including ones we deliberately dropped. */
  lastWebhookAt: Date | null;
  /** Latest inbound customer message actually persisted. */
  lastInboundMessageAt: Date | null;
  /** When this channel started expecting traffic. */
  wentLiveAt: Date | null;
  /**
   * The newest delivery that named THIS PAGE and could not be attributed to a channel.
   *
   * `webhook_events` rows with `routing: 'unrouted'` carry `tenant_id` and `channel_id`
   * null, so the routed query that feeds `lastWebhookAt` cannot see them — by construction,
   * not by oversight. They still carry `entry_id`, which IS the Page id, and an event
   * naming this Page is proof that Meta is delivering for it whatever we then did with it.
   *
   * Without this the never-received branch below names the wrong screen: it tells an
   * operator to go and fix an app-level field subscription that is demonstrably working.
   */
  unattributedWebhookAt: Date | null;
  timezone: string;
  hours: readonly BusinessHours[];
  closures: readonly Closure[];
  thresholdOpenMinutes: number;
  now: Date;
};

export type ChannelDiagnosis =
  /**
   * Nothing to act on. `everReceived: false` means nothing has EVER arrived and the channel
   * has simply not been open long enough for that to be a finding — quiet, not proven well.
   * Absent means both streams have really been seen inside the threshold.
   */
  | { state: 'healthy'; reason: string; everReceived?: false }
  /** Nothing is arriving at all: the token, or the subscription. */
  | { state: 'no_webhooks'; reason: string; everReceived: boolean }
  /** Events arrive and none becomes a message: standby, or the persist path. */
  | { state: 'no_messages'; reason: string; everReceived: boolean }
  /**
   * Setup is unfinished, so nothing can be measured. Recorded, never alerted.
   *
   * `silence.ts` calls this `not_configured` because what is missing there is a schedule;
   * here the subject is the channel, so it is named for the gap the operator would close.
   * It is the same fact, and it is deliberately NOT `unknown`: a provisioning gap is not an
   * outage. Every tenant passes through this state between having a channel row and having
   * its hours entered, and alerting on it means the first live channel on the platform
   * raises an alert a day for a form nobody has filled in yet.
   */
  | { state: 'not_provisioned'; reason: string }
  /** Not measurable. Reported, never guessed at. */
  | { state: 'unknown'; reason: string };

function inputFor(o: ChannelObservation, lastAt: Date | null): SilenceInput {
  return {
    lastInboundAt: lastAt,
    liveSince: o.wentLiveAt,
    now: o.now,
    timezone: o.timezone,
    hours: o.hours,
    closures: o.closures,
    thresholdOpenMinutes: o.thresholdOpenMinutes,
  };
}

/** Round for humans: an alert saying "184.99999 open minutes" reads as a machine failing. */
function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

function describe(v: SilenceVerdict): string {
  if (v.verdict === 'silent') return `at least ${hours(v.openMinutesAtLeast)} of open time with nothing, since ${v.since.toISOString()}`;
  if (v.verdict === 'ok') return `${hours(v.openMinutes)} of open time`;
  return v.detail;
}

export function diagnoseChannel(o: ChannelObservation): ChannelDiagnosis {
  const webhooks = assessSilence(inputFor(o, o.lastWebhookAt));

  // An unmeasurable upstream stops the analysis: without a usable schedule neither stream
  // can be measured, and running the second one would produce the same non-answer twice.
  if (webhooks.verdict === 'not_configured') return { state: 'not_provisioned', reason: webhooks.detail };
  if (webhooks.verdict === 'unknown') return { state: 'unknown', reason: webhooks.detail };

  if (webhooks.verdict === 'silent') {
    return {
      state: 'no_webhooks',
      everReceived: webhooks.everReceived,
      reason: webhooks.everReceived
        ? `no webhook of any kind for ${describe(webhooks)} — the token or the subscription`
        // NOT "the subscription never worked" when we have a delivery that named this Page.
        //
        // Measured on Matrix, 2026-09-12: five consecutive days of this alert saying the
        // app-level field subscription probably never worked, while `webhook_events` held
        // two deliveries with `entry_id 1520409424715591` — Matrix's own Page — from
        // 01:12 UTC on 2026-09-07. They were `unrouted`, correctly, because the channel row
        // did not exist until 01:23. Meta WAS delivering. The remedy the alert named would
        // have sent the founder to re-subscribe a working subscription, and the real fault
        // — that nothing since has been attributed to this channel — went unnamed.
        : o.unattributedWebhookAt !== null
          ? `no webhook has ever been attributed to this channel, but a delivery naming Page `
            + `${o.externalId} arrived at ${o.unattributedWebhookAt.toISOString()} and could not be `
            + `routed — Meta IS delivering, so this is channel identity, not the subscription`
          : `this channel has NEVER received a webhook (${describe(webhooks)}) — the app-level field subscription probably never worked`,
    };
  }

  const messages = assessSilence(inputFor(o, o.lastInboundMessageAt));
  // Reachable independently of the webhook stream: the schedule is shared, but the clock is
  // not, so a channel with webhooks but no message ever has nothing to measure the second
  // stream from.
  if (messages.verdict === 'not_configured') return { state: 'not_provisioned', reason: messages.detail };
  if (messages.verdict === 'unknown') return { state: 'unknown', reason: messages.detail };

  if (messages.verdict === 'silent') {
    return {
      state: 'no_messages',
      everReceived: messages.everReceived,
      // Webhooks ARE arriving — that is what makes this the standby case rather than a
      // dead token, and it is the sentence that stops an operator rotating a healthy token.
      reason: `webhooks are arriving but nothing became a message for ${describe(messages)} — a secondary-receiver (standby) Page, or the persist path`,
    };
  }

  // NOT ONE SENTENCE FOR TWO STATES.
  //
  // `ok` means "arriving" OR "nothing yet, and not open long enough to complain" — its own
  // type comment says so. Reported as one string, the second reads as the first: an
  // operator seeing "healthy — webhooks and messages both within 3.0h of open time" on a
  // channel that has never received a webhook in its life concludes the subscription works.
  //
  // Measured on Matrix at 03:00 UTC 2026-09-08, 1.0h into its first watched trading day:
  // `last_webhook_at` null, zero events, and this line said webhooks were within 3.0h. The
  // DECISION was right — 1.0h is not yet evidence of anything, and alerting would be noise.
  // The sentence was false, and the sentence is what a human reads.
  const seen = webhooks.verdict === 'ok' && webhooks.everReceived
    && messages.verdict === 'ok' && messages.everReceived;
  return seen
    ? { state: 'healthy', reason: `webhooks and messages both within ${hours(o.thresholdOpenMinutes)} of open time` }
    : {
        state: 'healthy',
        everReceived: false,
        // Says the quiet part: nothing has arrived, and this is not yet a finding. Naming
        // the clock lets a reader see how long is left before silence becomes a verdict.
        reason: `nothing received yet, and only ${hours(webhooks.verdict === 'ok' ? webhooks.openMinutes : 0)} `
          + `of open time so far — under the ${hours(o.thresholdOpenMinutes)} threshold, so too early to tell`,
      };
}
