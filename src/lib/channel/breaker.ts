/**
 * The credential circuit breaker (D-036).
 *
 * A channel whose stored credential will not open fails every send, and until this existed
 * it failed them **expensively**: the reply is drafted before the token is read, so every
 * message for a broken channel cost a model call — $0.0159 at the measured rate — and
 * delivered nothing. Measured, not hypothetical: on 2026-09-06 a `secret_undecryptable`
 * consumed $0.0161 for a message nobody received.
 *
 * D-034 made the SECOND such message free, by moving the delivery gate ahead of the model
 * call: once a channel is out of `live`, nothing is generated for it. This closes the other
 * half — what puts a channel out of `live` when nothing is talking to Meta at all.
 *
 * ## Three failures, not one, and the reason is the founder's
 *
 * Halting on the first failure was refused, in these words: *"a KEK deployment slip halting
 * every channel at once is a self-inflicted outage from a config mistake"* — from somebody
 * who had made two KEK mistakes that day. So N is not sizing a flake window. Every code
 * this counts is terminal by construction: the same bytes under the same KEK fail
 * identically next time, so one failure already proves the channel is broken. What N buys
 * is evidence that the cause is **this channel** and not **the platform**:
 *
 *  - **1** cannot tell a bad row from an environment variable briefly wrong on one warm
 *    lambda — which is precisely the mistake that would halt a working channel.
 *  - **2** can still be one bad deploy observed twice inside its own rollout.
 *  - **3 consecutive**, with the streak broken by any successful send, means three separate
 *    messages arrived and every one failed on this channel's own row. At Matrix's measured
 *    60.5 replies/day that is roughly an hour of traffic — long enough to span a rollback,
 *    and it bounds the cost at 3 × $0.0159 ≈ $0.05 per broken channel **once**, rather than
 *    per message for ever.
 *
 * ## One halt per hour, and the alarm that stops it hiding a mass revocation
 *
 * The cap is what makes a global cause structurally unable to cascade: if the KEK is wrong,
 * every channel trips its third strike within minutes and only the first one halts.
 *
 * But a global EXTERNAL event looks identical from here — Meta revoking tokens across many
 * Pages — and there the cap is exactly wrong: it would leave forty-nine channels paying
 * full model cost for two days while one halted per hour, and nothing would say so, because
 * each individual suppression is a correct decision. **So the suppression is the signal.**
 * The first time the cap holds a halt back, `channel.credential_halt_suppressed` fires with
 * the number of distinct channels currently failing credentials, deduplicated per hour.
 * Two channels failing to open a credential in the same hour is already anomalous; fifty is
 * the incident, and it reaches a person on the first hour rather than the fiftieth.
 *
 * ## `kek_unavailable` never counts, and that is the load-bearing exclusion
 *
 * Its own definition says it is not one tenant: *"the platform cannot decrypt ANYTHING
 * sealed under that version"*. Counting it would count the global cause as if it were
 * local, and the cap would then be rescuing the breaker from a state the breaker should
 * never have entered. `secret_unreadable` is excluded for the opposite reason — it is the
 * one retryable code, a failed read rather than a failed credential.
 *
 * Neither one BREAKS a streak either: a KEK blip between two undecryptable failures does
 * not make the channel healthy, and treating it as evidence in either direction would be
 * inventing a fact from an absence.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { haltChannelCredential } from './halt.ts';

/** Consecutive channel-local credential failures before a channel stops drafting. */
export const CREDENTIAL_FAILURES_BEFORE_HALT = 3;

/** How long a halt suppresses the next one, platform-wide. */
export const HALT_INTERVAL_MINUTES = 60;

/** How `deliverOutbound` writes a credential failure into `outbound_messages`. */
export const CREDENTIAL_REFUSAL_PREFIX = 'no credential: ';

/**
 * Codes that say nothing about THIS channel, so they neither count nor break a streak.
 * See the module note — this exclusion is the reason the cap is a backstop and not a
 * load-bearing control.
 */
export const NOT_THIS_CHANNEL: ReadonlySet<string> = new Set(['kek_unavailable', 'secret_unreadable']);

export type Attempt = { state: string; refusedReason: string | null };

/** The credential code inside a refusal reason, or null when it is not one. */
export function credentialCode(a: Attempt): string | null {
  if (a.state !== 'failed') return null;
  const reason = a.refusedReason ?? '';
  return reason.startsWith(CREDENTIAL_REFUSAL_PREFIX) ? reason.slice(CREDENTIAL_REFUSAL_PREFIX.length).trim() : null;
}

/**
 * Consecutive channel-local credential failures, newest first.
 *
 * A streak, not a rate. A rate over a window is a number somebody has to tune and re-tune;
 * consecutive-with-reset-on-success is a property of the sequence, and the reset is the
 * strongest possible evidence that the credential works — the provider accepted it.
 */
export function credentialStreak(newestFirst: readonly Attempt[]): number {
  let streak = 0;
  for (const attempt of newestFirst) {
    const code = credentialCode(attempt);
    if (code === null) break;                 // a send, or a failure of another kind
    if (NOT_THIS_CHANNEL.has(code)) continue; // neither evidence for nor against
    streak += 1;
  }
  return streak;
}

export type BreakerFacts = {
  /** The code of the failure that just happened. */
  code: string;
  /** Including the failure that just happened. */
  streak: number;
  /** Channels this breaker has halted inside the interval, platform-wide. */
  haltsInInterval: number;
  /** Distinct channels with a credential failure inside the interval, platform-wide. */
  failingChannels: number;
};

export type BreakerDecision =
  /** Stop drafting for this channel. */
  | { action: 'halt'; streak: number }
  /** It earned a halt and the cap held it. Somebody is told, with the scale. */
  | { action: 'suppressed'; streak: number; failingChannels: number }
  /** Nothing yet. */
  | { action: 'none'; streak: number; reason: 'below_threshold' | 'not_this_channel' };

export function decideBreaker(facts: BreakerFacts): BreakerDecision {
  if (NOT_THIS_CHANNEL.has(facts.code)) {
    return { action: 'none', streak: facts.streak, reason: 'not_this_channel' };
  }
  if (facts.streak < CREDENTIAL_FAILURES_BEFORE_HALT) {
    return { action: 'none', streak: facts.streak, reason: 'below_threshold' };
  }
  if (facts.haltsInInterval >= 1) {
    return { action: 'suppressed', streak: facts.streak, failingChannels: facts.failingChannels };
  }
  return { action: 'halt', streak: facts.streak };
}

// ---------------------------------------------------------------------------
// The runner: reads the facts, acts on the decision.
// ---------------------------------------------------------------------------

/** How many recent attempts to read. More than the threshold, so excluded rows can be skipped. */
const RECENT_ATTEMPTS = 12;

/** Bound on the platform-wide scan. Fifty tenants is the scale this is sized for. */
const FAILING_SCAN_LIMIT = 500;

export type BreakerDeps = {
  alert: (input: { severity: 'warn' | 'critical'; kind: string; dedupKey: string; body: string }) => Promise<unknown>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Read the facts and act.
 *
 * Every read failure produces `unreadable` rather than a guess. A breaker that cannot see
 * its own evidence must not halt a channel — that is the direction where a mistake costs an
 * outage, and the cost of not halting is a bounded number of model calls.
 */
export async function runCredentialBreaker(
  db: SupabaseClient,
  deps: BreakerDeps,
  input: { tenantId: string; channelId: string; code: string; now: Date },
): Promise<BreakerDecision | { action: 'unreadable'; detail: string }> {
  const since = new Date(input.now.getTime() - HALT_INTERVAL_MINUTES * 60_000).toISOString();

  const [recentRes, haltRes, failingRes] = await Promise.all([
    db.from('outbound_messages')
      .select('state, refused_reason')
      .eq('tenant_id', input.tenantId)
      .eq('channel_id', input.channelId)
      .order('created_at', { ascending: false })
      .limit(RECENT_ATTEMPTS),
    db.from('alerts')
      .select('dedup_key')
      .eq('kind', 'channel.credential_halt')
      .gte('at', since),
    db.from('outbound_messages')
      .select('channel_id')
      .eq('state', 'failed')
      .like('refused_reason', `${CREDENTIAL_REFUSAL_PREFIX}%`)
      .gte('created_at', since)
      .limit(FAILING_SCAN_LIMIT),
  ]);

  const failed = ([['outbound_messages', recentRes], ['alerts', haltRes], ['outbound_messages', failingRes]] as const)
    .find(([, res]) => res.error);
  if (failed !== undefined) {
    return { action: 'unreadable', detail: `${failed[0]} unreadable: ${failed[1].error?.message ?? ''}` };
  }

  const streak = credentialStreak(
    rows(recentRes.data).map((r) => ({ state: str(r['state']), refusedReason: str(r['refused_reason']) || null })),
  );
  const failingChannels = new Set(rows(failingRes.data).map((r) => str(r['channel_id']))).size;

  const decision = decideBreaker({
    code: input.code,
    streak,
    haltsInInterval: rows(haltRes.data).length,
    failingChannels,
  });

  if (decision.action === 'none') {
    deps.log('warn', 'credential_failure', {
      tenantId: input.tenantId, channelId: input.channelId, code: input.code,
      streak: decision.streak, reason: decision.reason,
    });
    // The immediate alert. `deliverOutbound` already pages loudly for `kek_unavailable` and
    // `secret_undecryptable`; `token_missing` and `secret_malformed` were silent, which is
    // a channel that answers nobody and says nothing. Once per channel per day, because the
    // condition persists until somebody re-seals a row.
    if (decision.reason === 'below_threshold') {
      await deps.alert({
        severity: 'warn',
        kind: 'channel.credential_failure',
        dedupKey: `channel_credential_failure:${input.channelId}:${input.now.toISOString().slice(0, 10)}`,
        body: `Channel ${input.channelId}: credential failure (${input.code}), ${decision.streak} in a row. `
          + `Drafting stops at ${CREDENTIAL_FAILURES_BEFORE_HALT}.`,
      });
    }
    return decision;
  }

  if (decision.action === 'suppressed') {
    deps.log('error', 'credential_halt_suppressed', {
      channelId: input.channelId, failingChannels: decision.failingChannels,
    });
    // Hourly, and CRITICAL, because the thing it describes is not one channel. Each
    // individual suppression is a correct decision; the pattern of them is an incident, and
    // without this the difference between "one bad row" and "Meta revoked fifty tokens"
    // is invisible until somebody reads the bill.
    await deps.alert({
      severity: 'critical',
      kind: 'channel.credential_halt_suppressed',
      dedupKey: `channel_credential_halt_suppressed:${input.now.toISOString().slice(0, 13)}`,
      body: `${decision.failingChannels} channel(s) are failing credentials and the one-halt-per-`
        + `${HALT_INTERVAL_MINUTES}-minute cap is holding them. One cause, or many? Channel `
        + `${input.channelId} earned a halt and did not get one.`,
    });
    return decision;
  }

  const halted = await haltChannelCredential(db, { tenantId: input.tenantId, channelId: input.channelId });
  if (!halted.ok) {
    deps.log('error', 'credential_halt_failed', { channelId: input.channelId, detail: halted.detail });
    return { action: 'unreadable', detail: halted.detail };
  }
  deps.log('error', 'credential_halt', { channelId: input.channelId, code: input.code, streak: decision.streak });
  // The alert row is also the cap's clock: `haltsInInterval` counts these. There is no
  // `halted_at` on `tenant_channels`, and inventing one would be a second place for the
  // same fact to drift from. This row is written by the halt and by nothing else.
  await deps.alert({
    severity: 'critical',
    kind: 'channel.credential_halt',
    dedupKey: `channel_credential_halt:${input.channelId}:${input.now.toISOString().slice(0, 13)}`,
    body: `Channel ${input.channelId} stopped: ${decision.streak} consecutive credential failures `
      + `(${input.code}). Nothing further is generated for it until the credential is re-sealed `
      + `and delivery_mode is set back to live.`,
  });
  return decision;
}
