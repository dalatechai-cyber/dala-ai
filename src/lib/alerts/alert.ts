/**
 * Founder alerts, deduplicated in Postgres.
 *
 * ## Why the dedup marker is a database row, not a Redis key
 *
 * The failure this prevents is specific: a tripped ceiling is hit by EVERY subsequent
 * inbound message, so a naive alert fires once per message — five hundred Telegram
 * notifications for one condition, which trains the founder to ignore the channel
 * exactly when it matters. The 05-spend-ledger design had to learn this once already for
 * the state-2 handoff notice, and chose a Postgres column over a Redis key for the same
 * reason: **with Redis down, every message re-sends.** A dedup store that fails open is
 * not a dedup store.
 *
 * The `alerts` row is therefore both the dedup marker and the audit trail. Insert-first,
 * send-after: if the send fails, the row still records that the condition occurred, and
 * `delivered` stays false so it is visible rather than lost.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env.ts';

export type Severity = 'info' | 'warn' | 'critical';

export type AlertInput = {
  tenantId: string | null;
  severity: Severity;
  /** Stable machine name, e.g. 'spend.ceiling_reached'. */
  kind: string;
  /**
   * What makes this alert THE SAME alert. Include the period, so a ceiling reached
   * again tomorrow is a new alert rather than silently suppressed forever.
   */
  dedupKey: string;
  body: string;
};

export type AlertOutcome =
  | { outcome: 'sent' }
  | { outcome: 'suppressed_duplicate' }
  | { outcome: 'recorded_undelivered'; detail: string }
  | { outcome: 'failed'; detail: string };

/**
 * Claim the dedup key. Returns the row id if this caller won, null if someone already
 * has it. The uniqueness is enforced by the insert losing a race, not by a read-then-write.
 */
async function claim(db: SupabaseClient, input: AlertInput): Promise<{ id: number } | null | 'error'> {
  const { data, error } = await db
    .from('alerts')
    .insert({
      tenant_id: input.tenantId,
      severity: input.severity,
      kind: input.kind,
      dedup_key: input.dedupKey,
      body: input.body,
      delivered: false,
    })
    .select('id')
    .maybeSingle();

  if (error) return error.code === '23505' ? null : 'error';
  return data === null ? 'error' : { id: Number((data as Record<string, unknown>)['id']) };
}

/** Whether an alert with this dedup key already exists. Used where no unique index exists. */
async function alreadyRaised(db: SupabaseClient, dedupKey: string): Promise<boolean | 'error'> {
  const { data, error } = await db
    .from('alerts')
    .select('id')
    .eq('dedup_key', dedupKey)
    .limit(1)
    .maybeSingle();
  if (error) return 'error';
  return data !== null;
}

export async function raiseAlert(db: SupabaseClient, input: AlertInput): Promise<AlertOutcome> {
  const seen = await alreadyRaised(db, input.dedupKey);
  if (seen === 'error') return { outcome: 'failed', detail: 'alerts table unreadable' };
  if (seen) return { outcome: 'suppressed_duplicate' };

  const claimed = await claim(db, input);
  if (claimed === null) return { outcome: 'suppressed_duplicate' };
  if (claimed === 'error') return { outcome: 'failed', detail: 'alerts insert failed' };

  // ALERTS_ENABLED=false is the documented dev/CI escape. It suppresses the SEND, never
  // the row — so a test still proves the condition was detected exactly once.
  if (process.env['ALERTS_ENABLED'] === 'false') {
    return { outcome: 'recorded_undelivered', detail: 'ALERTS_ENABLED=false' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${required('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: required('TELEGRAM_ALERT_CHAT_ID'),
        text: `${input.severity === 'critical' ? '🔴' : input.severity === 'warn' ? '🟠' : 'ℹ️'} ${input.body}`,
        disable_web_page_preview: true,
      }),
      cache: 'no-store',
    });
    if (!res.ok) {
      // A 2xx from a messaging provider means "accepted", never "delivered" — and a
      // non-2xx here means not even that. The row stays, undelivered and visible.
      return { outcome: 'recorded_undelivered', detail: `telegram ${res.status}` };
    }
    const payload = (await res.json()) as { result?: { message_id?: number } };
    await db
      .from('alerts')
      .update({ delivered: true, provider_message_id: String(payload.result?.message_id ?? '') })
      .eq('id', claimed.id);
    return { outcome: 'sent' };
  } catch (err) {
    return { outcome: 'recorded_undelivered', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dedup key for a spend threshold. The PERIOD is in the key on purpose: the same tenant
 * hitting the same ceiling tomorrow is a new alert, not a suppressed one.
 */
export function spendDedupKey(tenantId: string, surface: string, periodKey: string, threshold: string): string {
  return `spend:${tenantId}:${surface}:${periodKey}:${threshold}`;
}
