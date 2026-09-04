/**
 * Halt outbound on one channel after Graph `190` (§3.4.4).
 *
 * §1's rule reads: *"on Graph `190`, set `status='revoked'` and `token_status='revoked'`,
 * stop all outbound on that binding, keep persisting inbound, alert."* Three of those are
 * writes to two tables and the fourth is the caller's.
 *
 * ## The constraint makes "stop all outbound" atomic, and finding that took running it
 *
 * `tenant_channels` carries
 * `check (delivery_mode <> 'live' or token_status = 'active')`. So the obvious
 * implementation — one column, `set token_status = 'revoked'` — **is rejected by the
 * database** on precisely the channels this matters for: the live ones. Verified against
 * PostgreSQL 16.13:
 *
 *     ERROR:  new row for relation "tenant_channels" violates check constraint
 *             "live_requires_active_token"
 *
 * That is the constraint working. A revoked token with `delivery_mode` still `live` is a
 * channel the platform believes it can send on and cannot, so the schema refuses to hold
 * that state at all — and the fix is not to relax it but to write what was meant:
 * revoking the token and stopping delivery are one transition, not two.
 *
 * `status = 'authorization_error'` completes it. It is the `tenant_channels.status` value
 * that exists for exactly this, and it is what makes the channel visible as broken rather
 * than merely quiet — §3.4.4's whole point being that a dead token is otherwise silent.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch inbound. §3.4.5 is explicit: *persist everything, generate nothing,
 * deliver nothing, flag it all.* Webhook handling, `contacts`, `conversations` and
 * `messages` all keep working; the customer's question is kept, and it reaches the Quality
 * layer as an unanswered question rather than being dropped.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type HaltOutcome = { ok: true } | { ok: false; detail: string };

/**
 * Stop delivery on a channel whose credential is no longer valid.
 *
 * Idempotent by construction: re-running it writes the same three values. It does not
 * filter on the current `delivery_mode`, because a second `190` arriving from a request
 * already in flight must not fail just because the first one already halted the channel.
 */
export async function haltChannelOutbound(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string },
): Promise<HaltOutcome> {
  const { error } = await db
    .from('tenant_channels')
    .update({
      token_status: 'revoked',
      // Not optional, and not cosmetic — see the module note. Without it the CHECK
      // rejects the whole statement on a live channel.
      delivery_mode: 'off',
      status: 'authorization_error',
    })
    .eq('id', input.channelId)
    .eq('tenant_id', input.tenantId);

  return error ? { ok: false, detail: `haltChannelOutbound failed: ${error.message}` } : { ok: true };
}
