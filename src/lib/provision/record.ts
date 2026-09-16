/**
 * Incompleteness, recorded.
 *
 * A half-provisioned tenant is the normal state, not an error. Matrix's chemistry answers
 * were in flight for days while the rest of the config was finished, and a pipeline that
 * refuses to write anything until every field is present would have written nothing at all.
 * So `assessReadiness` puts the tenant at the last stage it satisfies and names what is
 * missing — and this file is what makes that visible to a human tomorrow morning rather
 * than only in the terminal of whoever happened to run the validator.
 *
 * ## It is an episode, and that is the whole design
 *
 * D-063's question is "does this condition recur, or does it persist?" A tenant waiting on
 * its price list does not become newly incomplete every morning; it is the same fact,
 * continuing. That is an `on_change` episode — it opens, it holds, it resolves — so the
 * dedup key carries NO date, and `resolveOpenAlerts` closes it the moment the tenant is
 * ready. A `daily` row here would be the six-criticals-in-six-days failure rebuilt for
 * onboarding.
 *
 * `route: 'digest'` and severity `info`: nobody is paged. The row IS the deliverable, and
 * 09:00 is when a human meets it. Telegram is shared with Core Language's customers
 * (CLAUDE.md), so an onboarding checklist has no business interrupting it — and `info`
 * keeps it out of the three-day critical re-escalation too.
 *
 * Nothing here decides what is missing. `assessReadiness` does, once, and this records its
 * verdict. The digest then reads the row. A summary that recomputed readiness would be a
 * second implementation of the validator, which is the shape of most of this repository's
 * incident list.
 */
import { raiseAlert, resolveOpenAlerts, type AlertOutcome } from '../alerts/alert.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Readiness } from './validate.ts';
import { readinessDigestLine } from './validate.ts';

/** `kind` is per-tenant so the hourly unique index buckets one tenant's states separately. */
export function readinessKind(slug: string): string {
  return `provisioning.readiness:${slug}`;
}

/**
 * What makes this THE SAME readiness fact.
 *
 * The stage alone is not enough. A tenant can sit at `knowledge` while its waiting-on list
 * goes from «services, contacts» to «contacts», and a digest still naming services the
 * client has since sent is worse than one saying nothing — it sends the operator to chase
 * something already done. So the key carries the waiting-on list too, and a change to it
 * closes one episode and opens the next.
 *
 * No date, ever. That is D-063's rule and the reason this repeats nothing.
 */
export function readinessDedupKey(slug: string, r: Readiness): string {
  // Already sorted by `assessReadiness`; joined on a character that cannot occur in a
  // waiting-on phrase, so two different lists cannot collide into one key.
  return `provisioning:${slug}:${r.stage}:${r.waitingOn.join('|')}`;
}

export type ReadinessRecord =
  | { recorded: 'open'; outcome: AlertOutcome; resolved: number }
  | { recorded: 'ready'; resolved: number }
  | { recorded: 'failed'; detail: string };

/**
 * Record where a tenant's provisioning stands.
 *
 * Idempotent by construction: called twice with the same readiness, the second call is
 * suppressed as a duplicate and closes nothing, so the digest keeps the one episode.
 */
export type ReadinessEffects = {
  raise: typeof raiseAlert;
  resolve: typeof resolveOpenAlerts;
};

/** The real ones. Injectable so the ordering rule below can be tested rather than asserted. */
export const LIVE_EFFECTS: ReadinessEffects = { raise: raiseAlert, resolve: resolveOpenAlerts };

export async function recordReadiness(
  db: SupabaseClient,
  slug: string,
  readiness: Readiness,
  now: Date,
  effects: ReadinessEffects = LIVE_EFFECTS,
): Promise<ReadinessRecord> {
  const prefix = `provisioning:${slug}:`;

  // A finished tenant is not news. Close whatever is open and say nothing further.
  if (readiness.stage === 'ready') {
    const closed = await effects.resolve(db, { keyPrefix: prefix, now });
    return closed.ok
      ? { recorded: 'ready', resolved: closed.resolved.length }
      : { recorded: 'failed', detail: closed.detail };
  }

  const dedupKey = readinessDedupKey(slug, readiness);
  const body = readinessDigestLine(slug, readiness) ?? `${slug}: ${readiness.stage}`;

  // RAISE FIRST, resolve second, and never resolve unless this raise left an episode open.
  //
  // `alerts_dedup_hourly` is unique on (kind, dedup_key, hour). So a tenant that returns to
  // a state it held earlier in the same hour — a service added and removed — gets 23505 and
  // `suppressed_duplicate`, with the earlier row already RESOLVED. Resolving the others on
  // that outcome would leave the tenant with no open episode at all, and an absent readiness
  // line reads exactly like a ready tenant. Stale by up to an hour beats invisible.
  const outcome = await effects.raise(db, {
    tenantId: null, // A tenant being provisioned may have no `tenants` row yet.
    severity: 'info',
    kind: readinessKind(slug),
    dedupKey,
    body,
    route: 'digest',
    repeat: 'on_change',
  });
  if (outcome.outcome === 'failed') return { recorded: 'failed', detail: outcome.detail };
  if (outcome.outcome === 'suppressed_duplicate') {
    return { recorded: 'open', outcome, resolved: 0 };
  }

  const closed = await effects.resolve(db, { keyPrefix: prefix, exceptKey: dedupKey, now });
  return closed.ok
    ? { recorded: 'open', outcome, resolved: closed.resolved.length }
    : { recorded: 'failed', detail: closed.detail };
}
