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
  timezone: string;
  hours: readonly BusinessHours[];
  closures: readonly Closure[];
  thresholdOpenMinutes: number;
  now: Date;
};

export type ChannelDiagnosis =
  | { state: 'healthy'; reason: string }
  /** Nothing is arriving at all: the token, or the subscription. */
  | { state: 'no_webhooks'; reason: string; everReceived: boolean }
  /** Events arrive and none becomes a message: standby, or the persist path. */
  | { state: 'no_messages'; reason: string; everReceived: boolean }
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

  // Unknown upstream stops the analysis: without a usable schedule neither stream can be
  // measured, and running the second one would produce the same non-answer twice.
  if (webhooks.verdict === 'unknown') return { state: 'unknown', reason: webhooks.detail };

  if (webhooks.verdict === 'silent') {
    return {
      state: 'no_webhooks',
      everReceived: webhooks.everReceived,
      reason: webhooks.everReceived
        ? `no webhook of any kind for ${describe(webhooks)} — the token or the subscription`
        : `this channel has NEVER received a webhook (${describe(webhooks)}) — the app-level field subscription probably never worked`,
    };
  }

  const messages = assessSilence(inputFor(o, o.lastInboundMessageAt));
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

  return { state: 'healthy', reason: `webhooks and messages both within ${hours(o.thresholdOpenMinutes)} of open time` };
}
