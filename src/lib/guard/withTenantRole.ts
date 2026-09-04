/**
 * The chokepoint. Every cost-bearing path goes through here, and no path re-implements
 * it locally.
 *
 * ## Four steps, in this order, each failing closed
 *
 *   1. **identity**    — a tenant resolved SERVER-SIDE, per webhook entry. Never from a
 *                        body, a header, or an env var, and there is no default tenant.
 *   2. **entitlement** — the tenant actually bought this role, and the role is available.
 *   3. **consent**     — the person has not withdrawn. Checked for EVERY role, not just
 *                        the ones that send outbound.
 *   4. **budget**      — reserved before the call, never after.
 *
 * The order is not cosmetic. Each step is cheaper and more certain than the next, so a
 * refusal happens as early as it can be known — and budget is last because it is the only
 * one with a side effect: reserving for a request that identity would have rejected
 * leaks another tenant's headroom.
 *
 * ## Never `try { check() } catch { continue }`
 *
 * That exact pattern was the HIGH finding next door. Every failure below returns 503,
 * including — especially — the ones where we simply could not find out. A 503 costs a
 * retry. Failing open costs money, and here it is another tenant's money.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NanoUsd } from '../money.ts';
import { reserve, type ReserveOutcome, type Reservation, type Surface } from '../spend/reserve.ts';

/** HTTP status a caller should return. 503 for anything undetermined. */
export type GuardRefusal =
  | { status: 403; code: 'role_not_entitled' }
  | { status: 403; code: 'consent_withdrawn' }
  | { status: 429; code: 'ceiling_reached' }
  | { status: 503; code: 'guard_unavailable'; detail: string };

export type GuardResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; refusal: GuardRefusal };

export type GuardInput = {
  /** Already resolved server-side from channel_identity. Never supplied by a caller. */
  tenantId: string;
  role: 'reception' | 'care' | 'analytics' | 'quality';
  surface: Surface;
  /** The person this reply is for, when one is known. Consent is checked when it is. */
  personId?: string | null;
  channel: string;
  estimate: NanoUsd;
  conversationId?: string | null;
  webhookEventId?: number | null;
  now: Date;
};

const unavailable = (detail: string): GuardResult => ({
  ok: false, refusal: { status: 503, code: 'guard_unavailable', detail },
});

export async function withTenantRole(db: SupabaseClient, input: GuardInput): Promise<GuardResult> {
  // ---- 1. identity ---------------------------------------------------------
  // Structural, not a lookup: this function cannot be called without a tenant id, and
  // the only thing that produces one is server-side resolution from channel_identity.
  // An empty string is a programming error, not a request we should try to serve.
  if (!input.tenantId) return unavailable('no tenant id: identity was never resolved');

  // ---- 2. entitlement ------------------------------------------------------
  const ent = await db
    .from('tenant_roles')
    .select('state, roles!inner(status)')
    .eq('tenant_id', input.tenantId)
    .eq('role', input.role)
    .maybeSingle();

  if (ent.error) return unavailable(`tenant_roles unreadable: ${ent.error.message}`);
  if (ent.data === null) return { ok: false, refusal: { status: 403, code: 'role_not_entitled' } };

  const entRow = ent.data as Record<string, unknown>;
  const state = entRow['state'];
  // 'trial' and 'active' may spend. 'off' and 'suspended' may not. An unrecognised state
  // is refused rather than assumed benign.
  if (state !== 'active' && state !== 'trial') {
    return { ok: false, refusal: { status: 403, code: 'role_not_entitled' } };
  }
  const roleRow = entRow['roles'] as { status?: unknown } | undefined;
  if (roleRow?.status !== 'available') {
    // A gated role (Voice, Care without a transport) must not spend even if a tenant row
    // says active — the platform-level gate outranks the per-tenant grant.
    return { ok: false, refusal: { status: 403, code: 'role_not_entitled' } };
  }

  // ---- 3. consent ----------------------------------------------------------
  // Checked for every role, not only the ones that send outbound. D-007 makes this
  // structural so that the day a transport exists, the compliance model is not new work.
  if (input.personId) {
    const consent = await db
      .from('consent_records')
      .select('state')
      .eq('tenant_id', input.tenantId)
      .eq('person_id', input.personId)
      .eq('channel', input.channel)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (consent.error) return unavailable(`consent_records unreadable: ${consent.error.message}`);
    // No record is NOT consent withdrawn — inbound Messenger consent is implied by the
    // person messaging us first. An explicit withdrawal is what refuses.
    const cState = consent.data === null ? null : (consent.data as Record<string, unknown>)['state'];
    if (cState === 'withdrawn' || cState === 'inferred_withdrawn') {
      return { ok: false, refusal: { status: 403, code: 'consent_withdrawn' } };
    }
  }

  // ---- 4. budget -----------------------------------------------------------
  // Last, because it is the only step with a side effect. Reserved BEFORE the call.
  let reserved: ReserveOutcome;
  try {
    reserved = await reserve(db, {
      tenantId: input.tenantId,
      surface: input.surface,
      estimate: input.estimate,
      conversationId: input.conversationId ?? null,
      webhookEventId: input.webhookEventId ?? null,
      now: input.now,
    });
  } catch (err) {
    // A throw here is still a refusal. It is never a reason to continue.
    return unavailable(`reserve threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (reserved.outcome === 'unavailable') return unavailable(reserved.detail);
  if (reserved.outcome === 'refused') {
    return { ok: false, refusal: { status: 429, code: 'ceiling_reached' } };
  }
  return { ok: true, reservation: reserved.reservation };
}
