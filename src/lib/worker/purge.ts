/**
 * The retention worker: the scheduled half of D-044's closure.
 *
 * Same shape as `worker/health.ts` and for the same reason — a Next.js route handler is
 * awkward to test for uninteresting reasons, so everything that branches lives here and
 * returns `{ status, body }`, and the route becomes an adapter thin enough that reading it
 * is the same as verifying it.
 *
 * ## What it does, and what it deliberately does not
 *
 * It calls one function. `ops.purge_expired` nulls `webhook_events.raw_payload` past the
 * tenant's `retention_days_raw_events` and deletes the row past 30 days, and everything
 * about WHICH rows and HOW MANY is decided in SQL, where it can be tested against real
 * rows rather than against a stub. This file decides only what to do about the answer.
 *
 * **It reaches no provider.** No Anthropic, no Meta, no Graph. That is what makes a
 * schedule appropriate at all: the sibling repo's `NOTHING SPENDS ON A SCHEDULE` is about
 * unattended model calls, and this makes none. The ceiling here is rows, not dollars —
 * which is also why it needs no `tenant_budgets` row and nothing founder-gated.
 *
 * ## The ceiling is an alert, not a failure
 *
 * A bounded job that quietly does its maximum every run is a backlog nobody sees, and a
 * retention promise that has silently become false. `p_max_rows` is therefore reported by
 * the function, and hitting it raises a **warn** — not a 503, because the run itself
 * succeeded and retrying immediately would just do another `p_max_rows` and alert again.
 * The dedup key carries the day, so a persistent backlog says so once a day rather than
 * once an hour.
 *
 * ## 503 when the call fails, never 200
 *
 * The failure this guards is the one D-044 describes: a retention mechanism that looks
 * present and does nothing. A purge that could not run must be retried and must be
 * visible, and a 200 with `{purged: 0}` is indistinguishable from a database with nothing
 * due — which is the exact ambiguity `audit_log` and this branch exist to remove.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert } from '../alerts/alert.ts';
import { PLATFORM_TIMEZONE } from '../../config/platform.ts';
import { tenantClock } from '../time/clock.ts';

/** What `ops.purge_expired` returns. Mirrored here so a shape change fails typecheck. */
export type PurgeCounts = {
  payloads_purged: number;
  rows_deleted: number;
  /** `messages.body` nulled past the tenant's own `message_retention_days` (`0021`). */
  bodies_redacted: number;
  ceiling_hit: boolean;
  max_rows: number;
};

export type PurgeEffects = {
  db: SupabaseClient;
  now: Date;
  verifySignature: (rawBody: string, signature: string | null) => Promise<boolean>;
  /** Rows per run. Bounded so one pathological run cannot hold a long transaction open. */
  maxRows?: number;
};

export type PurgeJobResult = { status: number; body: Record<string, unknown> };

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export async function runPurgeJob(
  effects: PurgeEffects,
  input: { rawBody: string; signature: string | null },
): Promise<PurgeJobResult> {
  if (!(await effects.verifySignature(input.rawBody, input.signature))) {
    return { status: 401, body: { error: 'bad_signature' } };
  }

  const maxRows = effects.maxRows ?? 50_000;

  // The PUBLIC wrapper, never `ops.purge_expired` — every client in `supabase/clients.ts`
  // is built with no `db: { schema }`, so PostgREST is asked for `public.<name>`. Asking
  // for a function that lives only in another schema is D-029's third bug exactly, and it
  // refused every reply for every tenant for a day before anyone saw it.
  const { data, error } = await effects.db.rpc('purge_expired', { p_max_rows: maxRows });

  if (error) {
    return { status: 503, body: { error: 'unavailable', detail: `purge_expired failed: ${error.message}` } };
  }
  if (data === null || typeof data !== 'object') {
    // A null answer is not a purge of nothing. It means the function did not report, and
    // reading it as zero is how a broken purge would look healthy for ever.
    return { status: 503, body: { error: 'unavailable', detail: 'purge_expired returned no counts' } };
  }

  const raw = data as Record<string, unknown>;
  const counts: PurgeCounts = {
    payloads_purged: int(raw['payloads_purged']),
    rows_deleted: int(raw['rows_deleted']),
    bodies_redacted: int(raw['bodies_redacted']),
    ceiling_hit: raw['ceiling_hit'] === true,
    max_rows: int(raw['max_rows']),
  };

  if (counts.ceiling_hit) {
    // Per day, not per run: a backlog persists across runs by definition, and an hourly
    // repetition of the same true statement is how the channel gets ignored (the reasoning
    // `alerts/alert.ts` gives for putting the period in the key).
    // The PLATFORM's calendar, not any tenant's: the purge sweeps every tenant's rows in
    // one run, so "once a day" here is one platform day. UTC was a third convention, and
    // the UTC day rolls at 08:00 in Ulaanbaatar — mid-morning, which is when somebody
    // would be reading the alert.
    const dayKey = tenantClock(effects.now, PLATFORM_TIMEZONE).date;
    await raiseAlert(effects.db, {
      tenantId: null,
      severity: 'warn',
      kind: 'retention.purge_backlog',
      dedupKey: `purge_backlog:${dayKey}`,
      body:
        `The retention purge hit its per-run ceiling of ${counts.max_rows} rows `
        + `(nulled ${counts.payloads_purged} payloads, deleted ${counts.rows_deleted} rows, `
        + `redacted ${counts.bodies_redacted} message bodies). `
        + 'There is a backlog, so customer text is living past its retention.',
    });
  }

  return { status: 200, body: counts as unknown as Record<string, unknown> };
}
