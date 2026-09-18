/**
 * Per-window rate limiting for anonymous website traffic, in Postgres.
 *
 * ## Why not in memory
 *
 * `dalatech-chatbot/lib/rateLimiter.js` is a module-scope `new Map()`, and its own second
 * line says *"For production, consider Redis-based solution for distributed systems."* On
 * Vercel that Map is one counter per warm instance, so the effective limit is
 * `maxRequests × instances` and it resets whenever a lambda is recycled — a limiter whose
 * number means nothing, reported as a limiter. `dala-ai` had no limiter at all, which is at
 * least honest: every inbound request until now was signed by Meta.
 *
 * Shared storage is the whole requirement, and we have shared storage.
 *
 * ## Windows are fixed, not sliding, and the reason is the same one D-063 gives
 *
 * A ceiling is a number AND a period. `window_start` is floored by the caller and is part
 * of the primary key, so a request either lands in an existing window or opens a new one —
 * there is no arithmetic that could drift, and two requests in the same second cannot end
 * up in two different windows. A sliding window would be more precise at the boundary and
 * would need either a row per request or a read-modify-write, and neither is worth it for a
 * bound whose job is to stop a flood rather than to meter a customer.
 *
 * The known give, stated rather than discovered: a caller can send `limit` requests at the
 * end of one window and `limit` again at the start of the next, so the true worst case is
 * `2 × limit` across a window boundary. That is a property of fixed windows, not a defect,
 * and it is bounded — which an in-process Map was not.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type RateDecision =
  | { ok: true; count: number; limit: number }
  | { ok: false; reason: 'rate_limited'; count: number; limit: number }
  | { ok: false; reason: 'rate_unavailable'; detail: string };

/** Floor an instant to the start of its window. Exported so tests do not re-derive it. */
export function windowStart(now: Date, windowMs: number): Date {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`windowStart: windowMs must be positive, got ${windowMs}`);
  }
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Count this request against `bucketKey`, and say whether it may proceed.
 *
 * The increment and the test happen in ONE statement, via an upsert whose returned `count`
 * is the value after this request. Reading then writing would let two concurrent requests
 * both read `limit - 1` and both proceed — the same race `claimTurn` avoids, for the same
 * reason, and the reason a limiter that "mostly works" is not a limiter.
 *
 * Fails CLOSED. Rule 2: a limiter that cannot be consulted must refuse, because the thing
 * on the other side of it is anonymous traffic against a paid model. `dalatech-english` has
 * the same posture and one documented exception list, and this surface is not on it.
 */
export async function consumeRate(
  db: SupabaseClient,
  input: { tenantId: string; bucketKey: string; limit: number; windowMs: number },
  now: Date,
): Promise<RateDecision> {
  const { tenantId, bucketKey, limit, windowMs } = input;
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, reason: 'rate_unavailable', detail: `limit must be a positive integer, got ${limit}` };
  }

  let start: Date;
  try {
    start = windowStart(now, windowMs);
  } catch (err) {
    return { ok: false, reason: 'rate_unavailable', detail: err instanceof Error ? err.message : String(err) };
  }

  const { data, error } = await db.rpc('bump_web_rate', {
    p_tenant_id: tenantId,
    p_bucket_key: bucketKey,
    p_window_start: start.toISOString(),
  });

  if (error) return { ok: false, reason: 'rate_unavailable', detail: error.message };

  // A count that cannot be read is not a count. Treating it as 0 would open the gate
  // exactly when the thing that reads the gate is broken.
  const count = typeof data === 'number' ? data : NaN;
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, reason: 'rate_unavailable', detail: `bump_web_rate returned ${JSON.stringify(data)}` };
  }

  return count > limit
    ? { ok: false, reason: 'rate_limited', count, limit }
    : { ok: true, count, limit };
}
