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
 * **How the events reach both systems was an open question, and this file was wrong about
 * it twice before it was measured.** It first asserted "Meta delivers the same event to
 * every subscribed app (§3.10.5)" — §3.10.5 is *Back off the tenant, not the worker*,
 * about rate-limit backoff, and establishes nothing of the kind. The correction then said
 * there was only ONE Meta app, so there could be no second subscriber. **That was also
 * wrong**, and for an instructive reason: `tenant_channels.app_slug` for tenant #0 reads
 * `dalatech` and names the wrong Meta app (D-041), so the database said one app while the
 * console said two.
 *
 * The facts, read from the console on 2026-09-06:
 *
 * | app | App ID | holds |
 * |---|---|---|
 * | `dalatech` | 1380702870025418 | Matrix's Page 1520409424715591; the ancestor's callback |
 * | `DALA_AI`  | 1562862634970492 | tenant #0's Page 863503883522801; this app's callback |
 *
 * ## MEASURED 2026-09-07: both subscribed apps receive `entry.messaging` (D-043)
 *
 * The founder subscribed tenant #0's Page `863503883522801` to **both** apps at once and
 * sent one real message. It arrived at `DALA_AI` in **`entry.messaging`**, not
 * `entry.standby` — `has_messaging: true`, `has_standby: false` — and the platform
 * answered it end to end (`webhook_events` id 8, `dedup_key`
 * `863503883522801:0:mfc9ea15…:dalatech`, reply sent with a real `provider_message_id`).
 * **No Handover demotion happened.** So the fan-out claim is true after all; what was
 * false was the citation, and the fix was to measure it rather than find a better section
 * number.
 *
 * **The mirror is therefore a second subscription, not a forwarding hop.** Nothing needs
 * to relay Matrix's traffic to this platform: subscribe `DALA_AI` to their Page alongside
 * `dalatech` and both systems receive the identical event. `webhook_events.source` (D-039)
 * stays, because it distinguishes `meta` from `mirror` for free and the day forwarding is
 * needed is not a day to be adding a column.
 *
 * ## What the measurement does NOT settle, and must not be read as settling
 *
 * It was taken on **tenant #0's Page**, not Matrix's. It proves that *being a second
 * subscribed app is not itself a Handover demotion*. It says nothing about whether
 * Matrix's own Page has the Handover Protocol configured with a primary receiver — if it
 * does, `DALA_AI` lands in `standby` there regardless. §3.7's branch and
 * `worker/reception.ts`'s terminal refusal stay exactly as they are: they cover the Page
 * Inbox case, which is a different mechanism from two apps on one Page and was never
 * tested by this.
 *
 * The consequence of being wrong about Matrix's Page is a mirror that generates nothing
 * and alerts once a day. It is not an outage, and it is discoverable with one message.
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

/**
 * The COMMENT surface's own switch (D-122), independent of the DM `delivery_mode`.
 *
 * `comment_delivery_mode` is `off`, `shadow` or `live`. Shadow drafts every public reply and
 * private message it would send, and sends none — so comments can be rehearsed while DMs
 * are live, which the founder asked for and the single shared switch could not give.
 *
 * `live` sends only while the channel's token is `active`. Both halts in `halt.ts` write
 * `token_status` (`revoked` or `error`), so a halted channel stops posting publicly through
 * this check alone. `halt.ts` deliberately does NOT also write this column: a halt is the
 * one statement that must never fail, and every extra column it names is one more way for
 * it to. An unrecognised value is refused, as `canDeliver` refuses one.
 */
export function canDeliverComments(commentMode: string, tokenStatus: string): DeliveryVerdict {
  if (commentMode === 'live') {
    if (tokenStatus === 'active') return { deliver: true, generate: true };
    return {
      deliver: false, generate: false, reason: 'not_live',
      detail: `comments are live but the token is ${JSON.stringify(tokenStatus)}; nothing is posted`,
    };
  }
  if (commentMode === 'shadow') {
    return { deliver: false, generate: true, reason: 'mirror', detail: 'comment shadow: replies are drafted and deliberately not posted' };
  }
  return {
    deliver: false, generate: false, reason: 'not_live',
    detail: commentMode === 'off' ? 'comments are off for this channel' : `unrecognised comment_delivery_mode ${JSON.stringify(commentMode)}`,
  };
}
