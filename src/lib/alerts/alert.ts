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
 *
 * ## Two axes: where it goes, and whether it may speak again (0025)
 *
 * The dedup-in-Postgres above solved "five hundred messages for one condition". It did not
 * solve "one message a day, for eleven days, about a condition that has not changed" — and
 * measured on 2026-09-14, that was ten of the eleven rows this table held. The founder's
 * words for it are the ones that matter: *it trains me to ignore Telegram.* The same chat
 * carries `dalatech-online`'s demo-request notifications, so a health alarm nobody reads is
 * not merely useless; it is burying the messages with a customer on the other end.
 *
 * `route` says how the FIRST notification is delivered. `repeat_policy` says whether the
 * condition may raise another row at all. Both defaulted, both reproducing today's
 * behaviour, so a call site that has not been touched is unchanged.
 *
 * The distinction that makes the rest coherent:
 *
 *   * **`on_change` rows are EPISODES.** They open, they hold, they resolve. While one is
 *     open the condition is silent — that is the whole point — and `resolved_at` is what
 *     "open" means. The daily digest lists exactly these, so a condition that alerts once
 *     and then goes quiet cannot be forgotten.
 *   * **`once` and `daily` rows are EVENTS.** A stranded message, a recovery, an erasure
 *     request: it happened, it was sent, it is over. `resolved_at` is meaningless for them
 *     and stays null, and neither the digest nor the re-escalation sweep looks at them.
 *
 * Without that split, "resolved_at is null" would mean "every alert ever raised" and the
 * digest would grow without bound — which is the daily-repeat failure again, wearing the
 * fix's clothes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env.ts';

export type Severity = 'info' | 'warn' | 'critical';

/** Where the FIRST notification goes. `digest` records it and says nothing until the daily report. */
export type AlertRoute = 'now' | 'digest';

/** Whether this condition may raise another row. See the module docstring. */
export type RepeatPolicy = 'once' | 'on_change' | 'daily';

export type AlertInput = {
  tenantId: string | null;
  severity: Severity;
  /** Stable machine name, e.g. 'spend.ceiling_reached'. */
  kind: string;
  /**
   * What makes this alert THE SAME alert.
   *
   * Under `daily` the caller puts the period in it, so a ceiling reached again tomorrow is
   * a new alert rather than suppressed forever. Under `on_change` it must carry NO period —
   * a date in the key is precisely what makes a standing condition repeat, and the whole
   * change is to stop that.
   */
  dedupKey: string;
  body: string;
  /** Default `now`: an un-updated call site keeps sending immediately, as it does today. */
  route?: AlertRoute;
  /** Default `daily`: an un-updated call site keeps its current suppression, as today. */
  repeat?: RepeatPolicy;
};

export type AlertOutcome =
  | { outcome: 'sent' }
  | { outcome: 'suppressed_duplicate' }
  /** Recorded deliberately without sending — the digest is where a human will meet it. */
  | { outcome: 'recorded_for_digest' }
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
      route: input.route ?? 'now',
      repeat_policy: input.repeat ?? 'daily',
    })
    .select('id')
    .maybeSingle();

  if (error) return error.code === '23505' ? null : 'error';
  return data === null ? 'error' : { id: Number((data as Record<string, unknown>)['id']) };
}

/**
 * Has this condition already been raised, under this policy?
 *
 * `once` and `daily` ask the original question — does a row with this key exist — and the
 * period, if there is to be one, is in the key. `on_change` asks whether the EPISODE is
 * still open, so a condition that cleared and came back speaks again while one that has
 * simply not changed stays quiet.
 *
 * Note what `on_change` does NOT do: it does not decide the condition has ended because
 * time passed. Only a detector that observed recovery sets `resolved_at`. A policy that
 * expired an episode on a timer would be the daily repeat again with a longer period.
 */
async function alreadyRaised(
  db: SupabaseClient,
  dedupKey: string,
  repeat: RepeatPolicy,
): Promise<boolean | 'error'> {
  const base = db.from('alerts').select('id').eq('dedup_key', dedupKey);
  // `on_change` asks about open EPISODES, so it reads only `on_change` rows. Without the
  // policy filter, an EVENT row carrying the same key — whose `resolved_at` is null for
  // ever, because nothing resolves an event — reads as an episode that never closes, and
  // the condition is silent for good. That is not hypothetical: `model_not_found:{id}`,
  // `secret.undecryptable:…` and `outbound.token_revoked:…` were `daily` rows under keys
  // with no period until 2026-09-25, and every such row on the project would otherwise
  // gag the very recurrence the move to `on_change` exists to report. D-063's addendum is
  // the same trap from the other side: a backfill default decides which rows a new rule
  // can reach.
  const { data, error } = await (repeat === 'on_change'
    ? base.is('resolved_at', null).eq('repeat_policy', 'on_change')
    : base)
    .limit(1)
    .maybeSingle();
  if (error) return 'error';
  return data !== null;
}

/**
 * The route for a warning nobody has to act on at once (D-128).
 *
 * `now` unless `DAILY_REPORT_V2 === 'true'`, when it is `digest` and the merged daily
 * report's «Yesterday» section is where a human meets it. One reader of the flag, here,
 * rather than an env read at every call site — so switching it is one variable and
 * reverting it is deleting that variable. Anything other than the exact string `true`
 * is today's behaviour; preflight refuses a value that is neither `true` nor `false`, so a
 * `TRUE` that silently means "off" cannot reach production.
 *
 * Only for warnings that are NOT a person's cue to act. A refused re-publish, a halted
 * channel or a customer left unanswered stays `now` whatever this says.
 */
export function quietRoute(): AlertRoute {
  return dailyReportV2() ? 'digest' : 'now';
}

/**
 * Is the merged daily report switched on? The ONE reader of `DAILY_REPORT_V2`, shared by
 * `quietRoute` and the digest, so the alerts it demotes and the section that shows them can
 * never be switched separately — demoting without the section would record warnings nobody
 * is shown.
 */
export function dailyReportV2(): boolean {
  return process.env['DAILY_REPORT_V2'] === 'true';
}

/** The mark a severity wears in Telegram. One place, so a digest line matches an alert. */
export function severityMark(severity: Severity): string {
  return severity === 'critical' ? '🔴' : severity === 'warn' ? '🟠' : 'ℹ️';
}

export type TelegramOutcome = { ok: true; messageId: string } | { ok: false; detail: string };

/**
 * One Telegram send. Extracted so the digest and the re-escalation sweep reach Telegram
 * through the same code an alert does.
 */
export async function sendTelegram(text: string): Promise<TelegramOutcome> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${required('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: required('TELEGRAM_ALERT_CHAT_ID'),
        text,
        disable_web_page_preview: true,
      }),
      cache: 'no-store',
    });
    // A 2xx from a messaging provider means "accepted", never "delivered" — and a non-2xx
    // here means not even that.
    if (!res.ok) return { ok: false, detail: `telegram ${res.status}` };
    const payload = (await res.json()) as { result?: { message_id?: number } };
    return { ok: true, messageId: String(payload.result?.message_id ?? '') };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function raiseAlert(db: SupabaseClient, input: AlertInput): Promise<AlertOutcome> {
  const repeat = input.repeat ?? 'daily';
  const route = input.route ?? 'now';

  const seen = await alreadyRaised(db, input.dedupKey, repeat);
  if (seen === 'error') return { outcome: 'failed', detail: 'alerts table unreadable' };
  if (seen) return { outcome: 'suppressed_duplicate' };

  const claimed = await claim(db, input);
  // The hourly unique index from `0001` is the other half of this: it refuses a second
  // insert for the same kind and key within one clock hour, so an episode that resolves and
  // reopens inside the hour — flapping — is suppressed rather than paging twice.
  if (claimed === null) return { outcome: 'suppressed_duplicate' };
  if (claimed === 'error') return { outcome: 'failed', detail: 'alerts insert failed' };

  // Recorded on purpose and not sent. NOT a failure, and it must not read as one: the row
  // IS the deliverable here, and the daily report is when a human meets it.
  if (route === 'digest') return { outcome: 'recorded_for_digest' };

  // ALERTS_ENABLED=false is the documented dev/CI escape. It suppresses the SEND, never
  // the row — so a test still proves the condition was detected exactly once.
  if (process.env['ALERTS_ENABLED'] === 'false') {
    return { outcome: 'recorded_undelivered', detail: 'ALERTS_ENABLED=false' };
  }

  const sent = await sendTelegram(`${severityMark(input.severity)} ${input.body}`);
  // The row stays, undelivered and visible.
  if (!sent.ok) return { outcome: 'recorded_undelivered', detail: sent.detail };

  await db
    .from('alerts')
    .update({
      delivered: true,
      provider_message_id: sent.messageId,
      // A human has now been told about THIS row. The three-day sweep measures from here.
      notified_at: new Date().toISOString(),
    })
    .eq('id', claimed.id);
  return { outcome: 'sent' };
}

/** One open episode, as the digest and the recovery path read it. */
export type OpenAlert = {
  id: number;
  tenantId: string | null;
  severity: Severity;
  kind: string;
  dedupKey: string;
  body: string;
  at: Date;
  notifiedAt: Date | null;
};

const OPEN_COLUMNS = 'id, tenant_id, severity, kind, dedup_key, body, at, notified_at';

function toOpenAlert(r: Record<string, unknown>): OpenAlert {
  const raw = r['notified_at'];
  const notified = typeof raw === 'string' && raw !== '' ? new Date(raw) : null;
  return {
    id: Number(r['id']),
    tenantId: r['tenant_id'] === null || r['tenant_id'] === undefined ? null : String(r['tenant_id']),
    severity: String(r['severity']) as Severity,
    kind: String(r['kind']),
    dedupKey: String(r['dedup_key']),
    body: String(r['body']),
    at: new Date(String(r['at'])),
    notifiedAt: notified !== null && !Number.isNaN(notified.getTime()) ? notified : null,
  };
}

/**
 * Every open `on_change` episode, oldest first — the digest's whole input.
 *
 * `repeat_policy` is in the filter and is not an afterthought: a `once` or `daily` row's
 * `resolved_at` is null because nothing ever resolves an EVENT, so without it this would
 * return the entire history of the table and the digest would grow for ever. That is the
 * daily-repeat failure again, wearing the fix's clothes.
 */
export async function openEpisodes(
  db: SupabaseClient,
): Promise<{ ok: true; open: OpenAlert[] } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('alerts')
    .select(OPEN_COLUMNS)
    .is('resolved_at', null)
    .eq('repeat_policy', 'on_change')
    .order('at', { ascending: true });
  if (error) return { ok: false, detail: `alerts unreadable: ${error.message}` };
  return { ok: true, open: (Array.isArray(data) ? data : []).map((r) => toOpenAlert(r as Record<string, unknown>)) };
}

/**
 * Close every open episode whose key starts with `keyPrefix`, except `exceptKey`.
 *
 * The prefix is what makes a DEGRADE clean. A channel's key is
 * `channel_silence:{channel}:{state}`, so a channel moving from `no_messages` to
 * `no_webhooks` opens a second episode; without closing the first, the digest would list one
 * channel twice for ever, one entry describing a fault it no longer has. `exceptKey` is how
 * the caller keeps the episode it has just raised.
 *
 * Returns what it closed, so the caller can say so. Resolving silently is the same defect
 * pointing the other way: a condition an operator was paged about, cleared without a word,
 * and no way to tell that from an alarm that stopped working.
 */
export async function resolveOpenAlerts(
  db: SupabaseClient,
  input: {
    keyPrefix: string; exceptKey?: string;
    /** Every key still true, for a caller that re-evaluates a whole family at once. */
    exceptKeys?: readonly string[];
    now: Date;
  },
): Promise<{ ok: true; resolved: OpenAlert[] } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('alerts')
    .select(OPEN_COLUMNS)
    .like('dedup_key', `${input.keyPrefix}%`)
    .is('resolved_at', null)
    .eq('repeat_policy', 'on_change');
  if (error) return { ok: false, detail: `alerts unreadable: ${error.message}` };

  const keep = new Set(input.exceptKeys ?? []);
  if (input.exceptKey !== undefined) keep.add(input.exceptKey);
  const open = (Array.isArray(data) ? data : [])
    .map((r) => toOpenAlert(r as Record<string, unknown>))
    // A LIKE prefix is a pattern, not a literal — `_` matches any one character — so the
    // prefix is re-checked here as a plain string before anything is closed.
    .filter((a) => a.dedupKey.startsWith(input.keyPrefix) && !keep.has(a.dedupKey));
  if (open.length === 0) return { ok: true, resolved: [] };

  const { error: updateErr } = await db
    .from('alerts')
    .update({ resolved_at: input.now.toISOString() })
    .in('id', open.map((a) => a.id));
  if (updateErr) return { ok: false, detail: `alerts not resolvable: ${updateErr.message}` };
  return { ok: true, resolved: open };
}

/**
 * Close the open episodes under these EXACT keys, in one statement.
 *
 * For a success path that runs on every reply or every send — `model_not_found` cleared by
 * a call that worked, a credential episode cleared by a send that went out. It is one
 * conditional UPDATE, not a read-then-write: on the ordinary day nothing is open, the
 * partial index `alerts_open_by_key` answers it, and zero rows change. No module-scope
 * "is anything open?" cache stands in front of it — a warm lambda serves every tenant
 * (CLAUDE.md rule 7's reasoning), and a cache that went stale would keep an episode open
 * after the fault had cleared, which is the silence this exists to end.
 *
 * Returns how many it closed, so a caller can log a recovery rather than perform it
 * invisibly.
 */
export async function resolveEpisodes(
  db: SupabaseClient,
  input: { dedupKeys: readonly string[]; now: Date },
): Promise<{ ok: true; resolved: number; keys: string[] } | { ok: false; detail: string }> {
  if (input.dedupKeys.length === 0) return { ok: true, resolved: 0, keys: [] };
  const { data, error } = await db
    .from('alerts')
    .update({ resolved_at: input.now.toISOString() })
    .in('dedup_key', [...input.dedupKeys])
    .is('resolved_at', null)
    .eq('repeat_policy', 'on_change')
    .select('id, dedup_key');
  if (error) return { ok: false, detail: `alerts not resolvable: ${error.message}` };
  const rows = Array.isArray(data) ? (data as { dedup_key?: unknown }[]) : [];
  // The keys this call closed, so a caller can say WHICH episode ended. The UPDATE is
  // conditional on `resolved_at is null`, so exactly one concurrent caller gets each key back.
  return { ok: true, resolved: rows.length, keys: rows.flatMap((r) => (typeof r.dedup_key === 'string' ? [r.dedup_key] : [])) };
}

/** Move `notified_at` on rows a human has just been paged about again. */
export async function markNotified(
  db: SupabaseClient,
  ids: readonly number[],
  now: Date,
): Promise<{ ok: boolean; detail?: string }> {
  if (ids.length === 0) return { ok: true };
  const { error } = await db.from('alerts').update({ notified_at: now.toISOString() }).in('id', [...ids]);
  return error ? { ok: false, detail: error.message } : { ok: true };
}

/**
 * Dedup key for a spend threshold. The PERIOD is in the key on purpose: the same tenant
 * hitting the same ceiling tomorrow is a new alert, not a suppressed one.
 */
export function spendDedupKey(tenantId: string, surface: string, periodKey: string, threshold: string): string {
  return `spend:${tenantId}:${surface}:${periodKey}:${threshold}`;
}
