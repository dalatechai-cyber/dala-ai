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
 * **How the events reach both systems is an open question, and this file has now been
 * wrong about it twice.** It first asserted "Meta delivers the same event to every
 * subscribed app (§3.10.5)" — §3.10.5 is *Back off the tenant, not the worker*, about
 * rate-limit backoff, and establishes nothing of the kind. The correction then said there
 * was only ONE Meta app, so there could be no second subscriber. **That was also wrong**,
 * and for an instructive reason: `tenant_channels.app_slug` for tenant #0 reads `dalatech`
 * and names the wrong Meta app (D-041), so the database said one app while the console
 * said two.
 *
 * The facts, read from the console on 2026-09-06:
 *
 * | app | App ID | holds |
 * |---|---|---|
 * | `dalatech` | 1380702870025418 | Matrix's Page 1520409424715591; the ancestor's callback |
 * | `DALA_AI`  | 1562862634970492 | tenant #0's Page 863503883522801; this app's callback |
 *
 * So a **second subscription is available** — Matrix's Page can be subscribed to `DALA_AI`
 * as well, which is what D-023's open question was asking. What is still **[UNVERIFIED]**
 * is whether both apps then receive `entry.messaging`. §3.7 says a non-primary receiver
 * gets `entry.standby` instead, and `worker/reception.ts` refuses those terminally and
 * alerts — so if the Handover Protocol works the way §3.7 describes, a second subscription
 * yields a mirror that generates nothing and pages the founder daily.
 *
 * That is now directly testable, and §3.15 already lists it as needing exactly this:
 * subscribe the second app, send one real message, and read which array it lands in.
 * `webhook_events.source` (D-039) distinguishes a forwarded delivery from a direct one if
 * the answer turns out to be that forwarding is the only route.
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
