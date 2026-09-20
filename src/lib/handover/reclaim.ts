/**
 * Taking a thread back when the handover went nowhere.
 *
 * `docs/handover.md` step 3 is the whole reason the Handover Protocol is worth building
 * here: the founder's stated motive is a phone that went unanswered for two days, and a
 * pass into an inbox nobody reads is that same failure with better plumbing — worse, in
 * fact, because the customer now gets silence from a bot that deliberately stopped
 * talking. So the reclaim ships with the pass or the pass does not ship.
 *
 * ## `passed` is the whole design, and it is why this could not be built before
 *
 * The blocker `docs/handover.md` records is arithmetic: the reclaim window is 15 minutes
 * and `human_takeover_cooldown_minutes` is 30, so a sweeper that reclaims ANY `human`
 * thread takes it back before the cooldown has run and the cooldown becomes unreachable.
 * The design answer is to reclaim only threads WE passed — and `thread_control_source`
 * could not express that, because `handover` was written both when this platform passes a
 * thread and when a receptionist takes one through Meta's own UI.
 *
 * `0033` adds `passed`. Everything below turns on it: a thread a person took is never
 * ours to take back, at any age, and the only rows this sweeper can reach are the ones
 * this platform handed away itself. Widening that test to `handover` would silence the
 * cooldown for every tenant at once — the same shape as widening check 4 to refuse on
 * `unknown` (see `control.ts`).
 *
 * ## The SQL filter is not the decision
 *
 * `sweepReclaimable` narrows in the query AND re-decides every row with `decideReclaim`.
 * That looks redundant and is the point: D-064 found a `.is('replied_at', null)` filter
 * that could not exclude a single row because nothing ever wrote the column, harmless
 * only because a filter beside it happened to carry the load. A filter is an optimisation;
 * the verdict is the rule, it is pure, and it is what the tests assert.
 *
 * ## An unknown age is not an expired one
 *
 * A `human` thread with a null `thread_control_at` is a real state — `0027` shipped every
 * pre-existing conversation with no timestamp. `humanHoldsThread` reads that as "assume
 * control is current" and refuses to answer; this reads it the same way and refuses to
 * reclaim. Both resolve towards leaving the person alone, which is the only direction
 * where being wrong is cheap.
 */
import type { ControlSource } from './record.ts';
import type { ThreadControl } from './control.ts';

/**
 * How long to wait before concluding nobody is coming. Founder's call, 2026-09-19 (D-091).
 *
 * Matrix's own corpus is the argument for minutes rather than hours — «Утсаа авахгүй
 * байна», then «2 өдөр залгаж байна», then a customer asking for a human rather than an
 * AI. A customer who has been told a person is coming and then waits an hour has learned
 * that asking for a person does not work.
 */
export const RECLAIM_WINDOW_MINUTES = 15;

/** The canned row the customer is sent when the window expires. Served whole, no model. */
export const RECLAIM_KIND = 'handover_reclaim';

/** One conversation, as the sweeper reads it. */
export type ReclaimCandidate = {
  readonly conversationId: string;
  readonly control: ThreadControl;
  /** Null for every conversation that predates `0027`. */
  readonly source: ControlSource | null;
  /** When control last changed hands. Null is a real state, not a missing field. */
  readonly at: Date | null;
};

export type ReclaimVerdict =
  | { readonly reclaim: true; readonly waitedMinutes: number }
  | {
      readonly reclaim: false;
      readonly reason:
        /** Control is `bot` or `unknown`; there is nothing to take back. */
        | 'not_human'
        /** A person took this thread. Never ours to reclaim, at any age. */
        | 'not_ours_to_reclaim'
        /** `human` with no timestamp — read as current, exactly as check 4 reads it. */
        | 'no_timestamp'
        /** Passed by us, and the window has not run out yet. */
        | 'window_open';
      readonly waitedMinutes: number | null;
    };

/**
 * May this thread be taken back?
 *
 * Pure, and ordered so that every refusal names the narrowest true reason. `not_human`
 * before `not_ours_to_reclaim` because a `bot` thread with `source = 'passed'` is a
 * thread already reclaimed, and reporting that as "not ours" would read as a bug in the
 * discriminator rather than as a no-op.
 */
export function decideReclaim(
  candidate: ReclaimCandidate,
  now: Date,
  windowMinutes: number = RECLAIM_WINDOW_MINUTES,
): ReclaimVerdict {
  if (candidate.control !== 'human') return { reclaim: false, reason: 'not_human', waitedMinutes: null };
  if (candidate.source !== 'passed') {
    return { reclaim: false, reason: 'not_ours_to_reclaim', waitedMinutes: null };
  }
  if (candidate.at === null) return { reclaim: false, reason: 'no_timestamp', waitedMinutes: null };

  const waited = (now.getTime() - candidate.at.getTime()) / 60_000;
  // `>=` so a window of 0 means "reclaim immediately" rather than "never", matching how
  // `humanHoldsThread` reads a cooldown of 0 as "resume immediately". A window nobody can
  // switch off is a window somebody will work around.
  if (waited >= windowMinutes) return { reclaim: true, waitedMinutes: Math.floor(waited) };
  return { reclaim: false, reason: 'window_open', waitedMinutes: Math.floor(waited) };
}

/* ------------------------------------------------------------------------- *
 * The sweep
 * ------------------------------------------------------------------------- */

import type { SupabaseClient } from '@supabase/supabase-js';
import { applyThreadControl } from './record.ts';

/** Why a candidate was not reclaimed, counted rather than logged one line each. */
export type ReclaimSkip = ReclaimVerdict extends { reclaim: false; reason: infer R } ? R : never;

export type ReclaimOutcome = {
  /** Threads taken back, with a line drafted for each. */
  readonly reclaimed: number;
  /** Verdict counts, including the ones the SQL filter was supposed to have excluded. */
  readonly skipped: Record<string, number>;
  /** Candidates the sweep could not finish. Each is retried on the next run. */
  readonly failed: Record<string, number>;
  readonly retry: boolean;
};

export type ReclaimDeps = {
  readonly db: SupabaseClient;
  readonly now: Date;
  /**
   * The reviewed `handover_reclaim` body, or null when the tenant has no row or the row is
   * unreviewed. Resolved by the caller so this function never decides what a customer reads.
   */
  readonly reclaimLine: (tenantId: string) => Promise<string | null | 'unreadable'>;
  /**
   * `take_thread_control` against Graph. `accepted` is the only outcome that proceeds:
   * `graph.ts` is explicit that an INDETERMINATE take means "assume it did not happen,
   * stay quiet", the opposite of how an indeterminate SEND is read, because a bot talking
   * over a person is the failure this whole feature exists to prevent.
   */
  readonly takeControl: (input: { tenantId: string; conversationId: string }) => Promise<'accepted' | 'refused' | 'indeterminate'>;
  readonly draft: (input: {
    tenantId: string; conversationId: string; dedupKey: string; body: string;
  }) => Promise<{ ok: true } | { ok: false; detail: string }>;
};

const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

/**
 * Take back every thread this platform passed and nobody picked up.
 *
 * ## Why a reviewed line is REQUIRED, and what that costs
 *
 * A tenant with no reviewed `handover_reclaim` row is skipped entirely — the thread stays
 * `human` and the bot stays quiet. That is the worse outcome for the customer in the
 * moment, and it is still the right rule: reclaiming silently means the customer was told
 * a person was coming, got nobody, and then gets a bot answering as if nothing happened.
 * The sentence is the thing that makes the reclaim honest, so a reclaim without it is not
 * a degraded reclaim, it is a different and worse behaviour.
 *
 * It is stated rather than discovered because the skip is invisible from outside: with no
 * row, this returns `reclaimed: 0` and a clean-looking sweep. `no_reviewed_line` in
 * `failed` is what tells an operator the feature is switched off rather than idle.
 *
 * ## The order is take → draft → flip, and each step is safe to repeat
 *
 * Flipping first would leave a thread marked `bot` with nothing sent if the process died,
 * which is the silent reclaim above arrived at by accident. Drafting first is safe because
 * `draftOnce`'s dedup key makes the insert idempotent, and the key carries the PASS
 * INSTANT — so a thread passed again tomorrow gets its own line rather than finding
 * yesterday's row and sending nothing.
 */
export async function sweepReclaimable(
  deps: ReclaimDeps,
  input: { tenantId: string; windowMinutes?: number; limit?: number },
): Promise<ReclaimOutcome> {
  const windowMinutes = input.windowMinutes ?? RECLAIM_WINDOW_MINUTES;
  const out = { reclaimed: 0, skipped: {} as Record<string, number>, failed: {} as Record<string, number>, retry: false };

  const cutoff = new Date(deps.now.getTime() - windowMinutes * 60_000);
  const { data, error } = await deps.db
    .from('conversations')
    .select('id, thread_control, thread_control_source, thread_control_at')
    .eq('tenant_id', input.tenantId)
    .eq('thread_control', 'human')
    .eq('thread_control_source', 'passed')
    .lte('thread_control_at', cutoff.toISOString())
    .order('thread_control_at')
    .limit(input.limit ?? 100);
  if (error) {
    // Unreadable is never "nothing to do". D-062 is eleven days of exactly that reading.
    return { ...out, failed: { conversations_unreadable: 1 }, retry: true };
  }
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return out;

  const line = await deps.reclaimLine(input.tenantId);
  if (line === 'unreadable') return { ...out, failed: { reclaim_line_unreadable: rows.length }, retry: true };
  if (line === null) return { ...out, failed: { no_reviewed_line: rows.length } };

  for (const row of rows) {
    const at = row['thread_control_at'];
    const candidate: ReclaimCandidate = {
      conversationId: String(row['id']),
      control: String(row['thread_control'] ?? 'unknown') as ThreadControl,
      source: (row['thread_control_source'] ?? null) as ControlSource | null,
      at: typeof at === 'string' ? new Date(at) : null,
    };
    // Re-decided, not trusted from the query. See the module header: a filter is an
    // optimisation and the verdict is the rule.
    const verdict = decideReclaim(candidate, deps.now, windowMinutes);
    if (!verdict.reclaim) { bump(out.skipped, verdict.reason); continue; }

    const taken = await deps.takeControl({ tenantId: input.tenantId, conversationId: candidate.conversationId });
    if (taken !== 'accepted') { bump(out.failed, `take_${taken}`); out.retry = true; continue; }

    const drafted = await deps.draft({
      tenantId: input.tenantId,
      conversationId: candidate.conversationId,
      // The pass instant, so a thread passed twice is reclaimed twice.
      dedupKey: `reclaim:${candidate.conversationId}:${candidate.at?.toISOString() ?? 'null'}`,
      body: line,
    });
    if (!drafted.ok) { bump(out.failed, 'draft_failed'); out.retry = true; continue; }

    const applied = await applyThreadControl(deps.db, {
      tenantId: input.tenantId,
      conversationId: candidate.conversationId,
      control: 'bot',
      source: 'reclaim',
      at: deps.now,
    });
    if (!applied.ok) { bump(out.failed, 'control_not_written'); out.retry = true; continue; }
    out.reclaimed += 1;
  }
  return out;
}
