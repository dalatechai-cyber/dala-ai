/**
 * Warn, early, that a stored credential is going to die. Renew NOTHING.
 *
 * ## The incident this exists for
 *
 * Matrix went live on 2026-09-21 on a short-lived Graph API Explorer Page token. It sealed
 * cleanly, `scripts/kek/verify.ts` opened it cleanly through the runtime loader, and about
 * forty minutes later Meta answered `401 code=190 subcode=463` — expired. Three consecutive
 * credential failures tripped the breaker and halted the channel. The platform's first
 * knowledge of the expiry was a customer not getting an answer.
 *
 * Nothing could have warned, because `tenant_secrets` carried no expiry at all until
 * `0035`. `unusableBecause` in the runtime loader rejects an empty secret, control
 * characters and stray whitespace — that is the entire test a credential passes, and an
 * expired token passes it (D-109).
 *
 * ## Two clocks, and the second one is the trap
 *
 * `expires_at` is when the token stops authenticating. A Page token minted from a
 * long-lived user token reports `expires_at: 0` — never — and it is genuinely never.
 *
 * `data_access_expires_at` is a different promise: about ninety days after the last
 * authorization, Meta stops returning data to a token that still authenticates perfectly.
 * So "never expires" and "never needs the human again" are different claims, and a checker
 * that tracked only the first would reproduce the same surprise on a longer fuse. Matrix's
 * current token never expires and its data access lapses around 2026-12-20.
 *
 * ## WARN ONLY — this is a product decision, not an omission
 *
 * On the founder's call, 2026-09-21: nothing here may refresh, re-authorize, or exchange a
 * credential. An automatic refresh is a write to the one thing whose loss is unrecoverable
 * (D-107), performed by a scheduled job at whatever hour it happens to notice. The product
 * is a person told early enough to act.
 *
 * ## Silence is never safety
 *
 * A NULL is "not known", never "never". Every row written before `0035` reads NULL, and so
 * does any credential sealed without the `debug_token` values. Those are counted and
 * reported as UNKNOWN rather than passed over, because a checker that reports zero problems
 * when it knows nothing is the shape D-070 is named for.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, resolveOpenAlerts } from '../alerts/alert.ts';

/**
 * How long before a lapse is worth a line in the daily digest.
 *
 * Thirty days is enough to schedule a re-authorization with a client who is not sitting at
 * their desk. It goes to the DIGEST, not to Telegram: `CLAUDE.md` is explicit that the
 * alert chat is shared with the people who send demo requests, so a month of daily pages
 * about a date in December is how a real alert gets missed.
 */
export const EXPIRY_WARN_DAYS = 30;

/**
 * When it stops being a note and becomes a message. Seven days is one working week — the
 * last point at which a person can still act without it being an emergency.
 */
export const EXPIRY_URGENT_DAYS = 7;

const DAY_MS = 86_400_000;

export type ExpiryClock = 'expires_at' | 'data_access_expires_at';

export type ExpiryFinding = {
  tenantId: string;
  kind: string;
  clock: ExpiryClock;
  /** Negative once it has already lapsed. */
  daysLeft: number;
  severity: 'warn' | 'critical';
  route: 'digest' | 'now';
};

export type ExpiryOutcome =
  | { ok: false; detail: string }
  | {
      ok: true;
      checked: number;
      /** Rows whose clocks are both NULL: nothing is known about them, and that is reported. */
      unknown: number;
      findings: ExpiryFinding[];
    };

/** Whole days, rounded toward zero from the future side so "0 days left" means today. */
function daysUntil(at: string, now: Date): number | null {
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor((ms - now.getTime()) / DAY_MS);
}

function classify(daysLeft: number): { severity: 'warn' | 'critical'; route: 'digest' | 'now' } | null {
  if (daysLeft <= EXPIRY_URGENT_DAYS) return { severity: 'critical', route: 'now' };
  if (daysLeft <= EXPIRY_WARN_DAYS) return { severity: 'warn', route: 'digest' };
  return null;
}

/**
 * Read every live credential's two clocks and warn on the ones running out.
 *
 * Only `active` and `rotating` rows: a `revoked` credential is already halted and alerting
 * that it will also expire is noise about a fault somebody is holding.
 */
export async function checkSecretExpiry(
  db: SupabaseClient,
  input: { now: Date },
): Promise<ExpiryOutcome> {
  const { data, error } = await db
    .from('tenant_secrets')
    .select('tenant_id, kind, status, expires_at, data_access_expires_at')
    .in('status', ['active', 'rotating']);
  // Unreadable is reported as unreadable and never as "nothing expiring". The caller turns
  // this into a 503 so the run is visibly incomplete rather than quietly clean.
  if (error) return { ok: false, detail: `tenant_secrets unreadable: ${error.message}` };

  const rows = (data ?? []) as Record<string, unknown>[];
  const findings: ExpiryFinding[] = [];
  let unknown = 0;

  for (const row of rows) {
    const tenantId = String(row['tenant_id'] ?? '');
    const kind = String(row['kind'] ?? '');
    let known = false;

    for (const clock of ['expires_at', 'data_access_expires_at'] as const) {
      const raw = row[clock];
      if (typeof raw !== 'string' || raw === '') continue;
      const daysLeft = daysUntil(raw, input.now);
      // An unparseable timestamp is NOT treated as absent: something wrote a value and we
      // cannot read it, which is a different fault from never having one, and burying it
      // in `unknown` would make a corrupted date indistinguishable from an honest blank.
      if (daysLeft === null) {
        findings.push({ tenantId, kind, clock, daysLeft: Number.NaN, severity: 'warn', route: 'digest' });
        known = true;
        continue;
      }
      known = true;
      const level = classify(daysLeft);
      if (level !== null) findings.push({ tenantId, kind, clock, daysLeft, ...level });
    }

    if (!known) unknown += 1;
  }

  return { ok: true, checked: rows.length, unknown, findings };
}

/** Every expiry episode's key starts with this. */
const EXPIRY_KEY_PREFIX = 'secret_expiring:';

/** One builder, so the raise and the resolve name the same key. */
export function expiryDedupKey(f: Pick<ExpiryFinding, 'tenantId' | 'kind' | 'clock' | 'severity'>): string {
  return `${EXPIRY_KEY_PREFIX}${f.tenantId}:${f.kind}:${f.clock}:${f.severity}`;
}

/**
 * Raise one alert per finding, and close every episode that is no longer a finding.
 *
 * ## Episodes, not once-ever events (D-128)
 *
 * The dedup key carries the clock and NO period, so a standing condition is one alert rather
 * than a daily drumbeat — D-063's rule. Until 2026-09-25 that was spelled `daily` under a
 * dateless key, which is "once in the life of the project": a credential re-sealed and then
 * run down again a quarter later was silent the second time, and the 30-day warning, routed
 * to a digest that lists only `on_change` rows, was written and shown nowhere at all (the
 * 2026-09-25 inventory, B9). Both severities are `on_change` now. The warning is an open
 * episode the daily digest lists every morning until it clears; the critical pages once and
 * then re-escalates every three days while it holds.
 *
 * ## Resolution is by re-evaluation, and needs the WHOLE set
 *
 * This runs hourly over every `active`/`rotating` credential, so the findings passed in are
 * the complete truth for this run: any open `secret_expiring:` episode whose key is not
 * among them has stopped being classified that way — re-sealed with a later date, crossed
 * from warn into critical (the warn closes as the critical opens), or no longer live. The
 * caller must therefore pass the findings of a read that SUCCEEDED; `runHealthJob` 503s
 * before reaching here otherwise, and an unreadable table must never read as "all clear".
 *
 * A credential whose clocks were re-sealed as NULL closes too — it is no longer known to be
 * expiring — and is counted in `unknown` by `checkSecretExpiry`, never passed over.
 */
export async function raiseExpiryAlerts(
  db: SupabaseClient,
  findings: readonly ExpiryFinding[],
  input: { now: Date },
): Promise<{ raised: number; failed: number; resolved: number; resolveFailed: boolean }> {
  let raised = 0;
  let failed = 0;
  for (const f of findings) {
    const res = await raiseAlert(db, {
      tenantId: f.tenantId,
      severity: f.severity,
      kind: 'secret.expiring',
      // The severity is in the key on purpose: crossing from the 30-day note into the
      // 7-day message is a DIFFERENT condition, and without it the earlier suppression
      // would swallow the one that matters.
      dedupKey: expiryDedupKey(f),
      route: f.route,
      repeat: 'on_change',
      body: expiryAlertBody(f),
    });
    if (res.outcome === 'failed') failed += 1;
    else raised += 1;
  }

  const closed = await resolveOpenAlerts(db, {
    keyPrefix: EXPIRY_KEY_PREFIX,
    exceptKeys: findings.map(expiryDedupKey),
    now: input.now,
  });
  if (!closed.ok) {
    // Left open, which the digest keeps listing: the safe direction. Reported, not thrown —
    // the raises above already happened and a 503 would re-run them for nothing.
    console.error('[health] could not resolve expiry episodes', { detail: closed.detail });
    return { raised, failed, resolved: 0, resolveFailed: true };
  }
  return { raised, failed, resolved: closed.resolved.length, resolveFailed: false };
}

/** The alert's words. Exported so a rendered sample shows the sentence a finding produces. */
export function expiryAlertBody(f: ExpiryFinding): string {
  const clockName = f.clock === 'expires_at' ? 'token expiry' : 'data access';
  const when = Number.isNaN(f.daysLeft)
    ? 'carries an UNREADABLE date'
    : f.daysLeft < 0
      ? `lapsed ${Math.abs(f.daysLeft)} day(s) ago`
      : `lapses in ${f.daysLeft} day(s)`;
  return `Credential ${f.kind} for tenant ${f.tenantId}: ${clockName} ${when}. `
    + 'Re-authorize and re-seal before then — nothing here renews it automatically. '
    + '`debug_token` gives both clocks; `scripts/kek/seal.ts` records them.';
}
