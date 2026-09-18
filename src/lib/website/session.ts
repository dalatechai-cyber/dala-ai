/**
 * Deriving the tenant for a website MESSAGE, and bounding what one session may spend.
 *
 * The mint (`mint.ts`) is where a tenant's server proves who it is. This is the other half:
 * the browser sends back only the opaque token the platform issued, and the tenant comes
 * from looking that token up. No field of a message request names a tenant, so there is
 * nothing for a caller to choose.
 *
 * ## Every refusal here is closed
 *
 * Rule 2: identity → entitlement → budget, in order, each refusing on error, helpers
 * returning 503 on any error. Never `try { check() } catch { continue }`. A read that fails
 * yields `session_unavailable`, never a session — the failure mode of guessing is another
 * tenant's conversation, and the failure mode of refusing is a retry.
 *
 * ## The turn cap, and what it is actually protecting
 *
 * A website session shares the `reception` spend surface with the tenant's Messenger
 * traffic, by design: same staff, same budget, same prompt, and `effectiveDailyCeiling`
 * already bounds the pair at `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY`. What that ceiling
 * cannot do is tell one anonymous visitor in a loop from a busy day — both look like spend
 * against `reception`, and the day's allowance is gone either way, taking the DM path down
 * with it.
 *
 * So the bound that matters here is per SESSION, and it is checked before the model is
 * called rather than after: a ceiling checked after the call is not a ceiling (rule 3).
 * `turn_cap` is a column rather than a constant because it is the kind of number that
 * differs between a tenant selling one service and a tenant with a catalogue — a row, like
 * everything else that distinguishes one customer from another.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sha256 } from './mint.ts';

export type SessionRefusal =
  | 'session_unknown'      // no row for this token — also what an expired-and-purged one looks like
  | 'session_expired'
  | 'session_revoked'
  | 'session_exhausted'    // the turn cap is spent
  | 'session_unavailable'; // we could not decide; fail closed

export type ResolvedSession = {
  id: string;
  tenantId: string;
  channelId: string;
  turns: number;
  turnCap: number;
  expiresAt: Date;
};

export type SessionOutcome =
  | { ok: true; session: ResolvedSession }
  | { ok: false; refusal: SessionRefusal; detail?: string };

/**
 * The columns this reads. Named once so `scripts/verify/postgrest.ts` parses a single
 * select and D-038's column check covers every one of them.
 */
const SESSION_COLUMNS = 'id, tenant_id, channel_id, turns, turn_cap, expires_at, revoked_at';

/**
 * Resolve a presented token to a tenant, or refuse.
 *
 * @param token  exactly what the browser sent; never logged, never stored
 * @param now    injected — a clock read inside a gate cannot be tested
 */
export async function resolveSession(
  db: SupabaseClient,
  token: string,
  now: Date,
): Promise<SessionOutcome> {
  // A token of the wrong shape is refused without a query. Not an optimisation: it keeps
  // junk out of the lookup, and it means an empty string cannot match a row whose hash
  // happened to be computed over one.
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) { // ascii-safe: a base64url token this platform minted, never customer text
    return { ok: false, refusal: 'session_unknown' };
  }

  const { data, error } = await db
    .from('web_sessions')
    .select(SESSION_COLUMNS)
    .eq('token_sha256', `\\x${sha256(token).toString('hex')}`)
    .maybeSingle();

  // Rule 2: 503 on any error. The tempting reading of a failed lookup is "no such session",
  // and that reading turns a database blip into every customer being told their session
  // ended.
  if (error) return { ok: false, refusal: 'session_unavailable', detail: error.message };
  if (data === null) return { ok: false, refusal: 'session_unknown' };

  const row = data as Record<string, unknown>;
  const expiresAt = new Date(String(row['expires_at']));
  if (!Number.isFinite(expiresAt.getTime())) {
    return { ok: false, refusal: 'session_unavailable', detail: 'expires_at unparsable' };
  }

  // Revocation beats expiry in the ordering, because a revoked session is a decision
  // somebody made and an expired one is just time passing; reporting the weaker of the two
  // would hide the stronger.
  if (row['revoked_at'] !== null && row['revoked_at'] !== undefined) {
    return { ok: false, refusal: 'session_revoked' };
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, refusal: 'session_expired' };
  }

  // `Number(null)` is 0, NOT NaN — so coercing first and validating after reads a null
  // `turns` as "zero turns used", i.e. a fresh session, which is the exact inversion of
  // what an unreadable counter should mean. The raw type is checked BEFORE any coercion.
  const rawTurns = row['turns'];
  const rawCap = row['turn_cap'];
  const turns = typeof rawTurns === 'number' ? rawTurns : NaN;
  const turnCap = typeof rawCap === 'number' ? rawCap : NaN;
  if (!Number.isInteger(turns) || !Number.isInteger(turnCap) || turnCap < 1 || turns < 0) {
    // A cap that cannot be read is not a cap. Refusing is the only safe reading: treating
    // an unreadable bound as "no bound" is the exact shape of the depth-read that cost
    // Core Language $12.43.
    return { ok: false, refusal: 'session_unavailable', detail: 'turns/turn_cap unreadable' };
  }
  if (turns >= turnCap) return { ok: false, refusal: 'session_exhausted' };

  return {
    ok: true,
    session: {
      id: String(row['id']),
      tenantId: String(row['tenant_id']),
      channelId: String(row['channel_id']),
      turns,
      turnCap,
      expiresAt,
    },
  };
}

/**
 * Claim one turn, atomically, before the model is called.
 *
 * The increment is conditional on the row still being under its cap — `.lt('turns',
 * turnCap)` in the same statement as the update — so two requests arriving together cannot
 * both read `turns = cap - 1` and both proceed. `resolveSession` reading the cap is a
 * courtesy that produces a good error message; THIS is the check that binds, and the
 * difference between the two is the difference between a cap and a number in a log.
 *
 * Returns the turn number claimed, so the caller can record which turn a reply belongs to.
 */
export async function claimTurn(
  db: SupabaseClient,
  session: ResolvedSession,
  now: Date,
): Promise<{ ok: true; turn: number } | { ok: false; refusal: SessionRefusal; detail?: string }> {
  const { data, error } = await db
    .from('web_sessions')
    .update({ turns: session.turns + 1, last_seen_at: now.toISOString() })
    .eq('id', session.id)
    .eq('turns', session.turns) // optimistic: somebody else moved it, so this claim is stale
    .lt('turns', session.turnCap)
    .is('revoked_at', null)
    .select('turns')
    .maybeSingle();

  if (error) return { ok: false, refusal: 'session_unavailable', detail: error.message };
  if (data === null) {
    // Either the cap is now spent or a concurrent request took this turn. Both mean "not
    // yours", and the honest answer to the customer is the same.
    return { ok: false, refusal: 'session_exhausted' };
  }
  return { ok: true, turn: Number((data as Record<string, unknown>)['turns']) };
}
