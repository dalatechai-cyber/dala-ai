/**
 * May this channel actually deliver right now? (§3.7, and Track 4's mirror phase.)
 *
 * `tenant_channels.delivery_mode` and `tenant_channels.status` are orthogonal —
 * reconciliation item 4 settled that: `status` is health, `delivery_mode` is cutover. A
 * channel can be perfectly healthy and deliberately not delivering, which is the entire
 * mirror phase.
 *
 * ## The mode this exists for is `shadow`
 *
 * Track 4 runs Matrix for 14 days in the incumbent's shadow: Dala AI receives the
 * webhooks, persists, generates, and **does not send**, because `Matrix-Chatbot` is still
 * the thing answering that Page.
 *
 * **How the events reach both systems is an open question, and this file used to assert an
 * answer it could not support.** It said "Meta delivers the same event to every subscribed
 * app (§3.10.5)". §3.10.5 is *Back off the tenant, not the worker* — rate-limit backoff. It
 * says nothing about multi-app delivery, and the claim it was cited for is **[UNVERIFIED]**.
 * It had propagated into `V1.md`, `STATUS.md` and two test comments as settled fact.
 *
 * Two things bear on it. The founder confirmed on 2026-09-06 that `Matrix-Chatbot` runs on
 * **the same `dalatech` app**, and one app has one callback URL — so on this deployment
 * there is no second subscriber to deliver to, whatever Meta does with two apps. And §3.7
 * records that a non-primary receiver gets `entry.standby`, which `worker/reception.ts`
 * refuses terminally and alerts on, so even two apps would not produce two `messaging`
 * deliveries. The likely shape of a mirror is therefore that the incumbent FORWARDS each
 * delivery — which is why `webhook_events.source` is now written (D-039).
 *
 * What would settle it: `GET /{page-id}/subscribed_apps` with a Page token, the App
 * Dashboard's Webhooks page, and — for the standby half — subscribing a second app and
 * reading which array one real message lands in. §3.15 already lists that as needing
 * verification.
 *
 * None of it changes what `shadow` is FOR.
 *
 * If the send path treated `shadow` as deliverable, every Matrix customer would get two
 * replies from the same salon for two weeks, and the phase whose purpose is *zero risk*
 * would be the highest-risk thing in the plan. So this is a positive allow-list of one
 * value, not a check for `off`: a new mode added later is non-delivering until somebody
 * decides otherwise, which is the safe direction for a default to fail in.
 */

/** The `delivery_mode` CHECK constraint on `tenant_channels`. */
export type DeliveryMode = 'off' | 'shadow_routing' | 'shadow' | 'live';

export type DeliveryVerdict =
  /** Live: generate a reply and put it on the wire. */
  | { deliver: true; generate: true }
  /** The mirror phase: generate, and deliberately do not send. */
  | { deliver: false; generate: true; reason: 'mirror'; detail: string }
  /**
   * Neither generated nor sent.
   *
   * Distinct from the mirror because the cost differs and nothing was measuring it: a
   * reply generated for a channel that will never send it is a model call spent on text
   * no customer can receive.
   */
  | { deliver: false; generate: false; reason: 'not_live'; detail: string };

const WHY: Record<string, string> = {
  off: 'delivery is off for this channel',
  shadow_routing: 'routing is being rehearsed; nothing is generated or sent',
  shadow: 'the mirror phase: replies are generated and deliberately not sent',
  live: '',
};

/**
 * Exactly one mode delivers, and exactly two generate.
 *
 * An unrecognised value is refused rather than assumed live — the same posture
 * `loadTenantSecret` takes on an unrecognised `status`. A row that says something this
 * code does not understand is not a row to send a customer a message on, and it is not a
 * row to spend a model call on either.
 *
 * ## Why "may it send" was not enough
 *
 * The caller evaluated this AFTER generating, so every non-live mode paid for a reply it
 * then discarded. Two of them are supposed to be free:
 *
 *  - **`shadow_routing`'s own description is «nothing is generated or sent»** — the string
 *    two lines above this one — and it generated. The code and its documentation had
 *    disagreed since the mode existed, and nothing could notice, because the only symptom
 *    is a bill.
 *  - **A halted channel is `off`.** `haltChannelOutbound` sets `delivery_mode = 'off'` on
 *    a Graph `190`, so after a token dies every further message drafted a reply that could
 *    not be sent, at the measured $0.0159 each, until somebody re-authorised the Page.
 *
 * `shadow` is the one that must keep generating, and it is the whole reason this is a
 * three-way answer rather than a second boolean on the same axis: Track 4 runs Matrix for
 * fourteen days generating replies nobody sends, and that phase is how the final
 * conversation band gets measured. A blanket "do not generate when you cannot deliver"
 * would delete it.
 */
export function canDeliver(mode: string): DeliveryVerdict {
  if (mode === 'live') return { deliver: true, generate: true };
  if (mode === 'shadow') return { deliver: false, generate: true, reason: 'mirror', detail: WHY['shadow'] ?? '' };
  return {
    deliver: false,
    generate: false,
    reason: 'not_live',
    detail: WHY[mode] ?? `unrecognised delivery_mode ${JSON.stringify(mode)}`,
  };
}
