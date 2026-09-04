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
 * the thing answering that Page. Meta delivers the same event to every subscribed app
 * (§3.10.5), so both systems see every message.
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
  | { deliver: true }
  | { deliver: false; reason: 'not_live'; detail: string };

const WHY: Record<string, string> = {
  off: 'delivery is off for this channel',
  shadow_routing: 'routing is being rehearsed; nothing is generated or sent',
  shadow: 'the mirror phase: replies are generated and deliberately not sent',
  live: '',
};

/**
 * Exactly one mode delivers.
 *
 * An unrecognised value is refused rather than assumed live — the same posture
 * `loadTenantSecret` takes on an unrecognised `status`. A row that says something this
 * code does not understand is not a row to send a customer a message on.
 */
export function canDeliver(mode: string): DeliveryVerdict {
  if (mode === 'live') return { deliver: true };
  return {
    deliver: false,
    reason: 'not_live',
    detail: WHY[mode] ?? `unrecognised delivery_mode ${JSON.stringify(mode)}`,
  };
}
