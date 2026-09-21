/**
 * A successful send is the only thing that clears a credential failure.
 *
 * Founder's call, 2026-09-21: *"A successful send clears `tenant_channels.status`. Nothing
 * else clears it."* This is the other half of `haltChannelOutbound`, which has written
 * `status = 'authorization_error'` since §3.4.4 with nothing anywhere writing it back.
 *
 * ## Why it needed building at all
 *
 * Matrix carried `authorization_error` from 02:25 on 2026-09-21 while the credential
 * demonstrably worked: `tenant_secrets.last_ok_at` advanced to 03:28:45 and fourteen
 * messages sent with real `provider_message_id`s AFTER the flag was set. A column written
 * in one direction only reads as a live signal for exactly as long as nobody tests it —
 * D-064's shape, inverted. It does not gate the reply path, but `website/mintJob.ts`
 * refuses on it with `channel_inactive`, so a tenant whose token recovered stays locked
 * out of its own website channel for ever.
 *
 * ## The instruction is DELIBERATELY NARROWED, and this is the reasoning
 *
 * "Clears status" taken literally would move any value to `active`, and the CHECK allows
 * six: `pending, probing, active, authorization_error, suspended, offboarded`. Three of
 * those must never be cleared by traffic:
 *
 *  - **`suspended`** is an operator decision. A message already in flight must not undo it.
 *  - **`offboarded`** is a customer who left. A late send reactivating their channel is the
 *    worst outcome in the list.
 *  - **`pending` / `probing`** are provisioning states with their own gate; a send is not a
 *    probe run and must not be read as one.
 *
 * A successful send is evidence about exactly ONE thing: the credential works. That is what
 * `authorization_error` records and the only claim a send can retire. So this moves
 * `authorization_error → active` and nothing else.
 *
 * **The narrowing lives in the WHERE clause, not in an `if`.** `.eq('status',
 * 'authorization_error')` means the database itself matches no row in any other state, so a
 * future caller cannot widen this by reading the guard wrong — the query has no other
 * behaviour to reach. An `if` one layer up would have been a branch somebody could delete.
 *
 * ## What it must NOT touch
 *
 * `haltChannelOutbound` writes THREE columns — `status`, `token_status = 'revoked'` and
 * `delivery_mode = 'off'` — because the CHECK `delivery_mode <> 'live' or token_status =
 * 'active'` makes stopping delivery one transition rather than three. This clears only
 * `status`. It does not restore `delivery_mode`, and that is not an oversight: restoring
 * it would be Dala AI switching itself from `off` back toward live on the strength of its
 * own traffic, which is the one thing the founder has said repeatedly must never happen.
 * Bringing a halted channel back is a human action; this only removes the flag that
 * outlived the fault.
 *
 * Note the consequence, stated rather than hidden: after a FULL halt, `delivery_mode` is
 * `off`, so no send can occur, so this can never fire. It fires on the state Matrix was
 * actually in — a `status` left behind after the token was repaired and delivery restored
 * by hand.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** `haltChannelOutbound`'s value, and the only one a send may retire. */
export const CREDENTIAL_FAILURE_STATUS = 'authorization_error';

/** What a working credential means the channel is. */
export const RECOVERED_STATUS = 'active';

export type RecoverOutcome =
  /** The flag was set and is now cleared. */
  | { ok: true; cleared: true }
  /** Nothing to clear — the channel was not in a credential failure. */
  | { ok: true; cleared: false }
  | { ok: false; detail: string };

/**
 * Clear a credential failure after a send that actually reached Meta.
 *
 * The caller must only reach this on a real `sent` outcome with a `provider_message_id`.
 * A queued row, a draft withheld by the mirror, or a 200 from a retry that sent nothing
 * are all NOT evidence the credential works, and passing one here would clear the flag on
 * a channel that is still broken — which is worse than leaving it set, because the alert
 * has already been sent and nobody would look again.
 *
 * Failure is reported, never thrown. The customer has their message by the time this runs;
 * bookkeeping must not be able to undo that or to fail the job.
 */
export async function clearCredentialFailure(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string },
): Promise<RecoverOutcome> {
  const { data, error } = await db
    .from('tenant_channels')
    .update({ status: RECOVERED_STATUS })
    .eq('id', input.channelId)
    .eq('tenant_id', input.tenantId)
    // The narrowing. See the module note: no other status can be reached from here.
    .eq('status', CREDENTIAL_FAILURE_STATUS)
    .select('id');

  if (error) return { ok: false, detail: `clearCredentialFailure failed: ${error.message}` };
  // Zero rows is the ordinary case — the channel was already healthy. It is reported as
  // `cleared: false` rather than as success-with-a-write, because "the flag was set and I
  // removed it" and "there was nothing to remove" are different facts and the caller logs
  // only the first. Counting a no-op as a clear would put a recovery line in the log on
  // every single send.
  return { ok: true, cleared: Array.isArray(data) && data.length > 0 };
}
