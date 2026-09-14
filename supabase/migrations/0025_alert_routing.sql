-- 0025 — an alert says WHERE it goes and WHEN it may speak again, and can be resolved.
--
-- Measured, not supposed. On 2026-09-14 the `alerts` table held eleven rows and ten of them
-- were one condition: `channel.no_webhooks`, critical, fired once a day from 2026-09-08 to
-- 2026-09-13 for a channel whose state never changed. Everything else in the table had
-- fired exactly once. So the noise was never "alerting is chatty" — it was one dedup-key
-- shape, `channel_silence:{channel}:{state}:{localDate}`, whose date made tomorrow a new
-- alert about yesterday's unchanged fact.
--
-- The founder's sentence for it: it trains me to ignore Telegram. That matters more here
-- than in most systems, because the same Telegram chat carries the demo-request
-- notifications from `dalatech-online` — a health alarm nobody reads is not merely useless,
-- it is drowning the only messages with a customer on the other end.
--
-- ## Two axes, because today they are one
--
-- `route` is how the FIRST notification is delivered. `repeat_policy` is whether the same
-- condition may create another row at all. They were previously both implied by `kind` plus
-- whatever the caller happened to put in `dedup_key`, which is why fixing the repeat meant
-- editing a string in `health/watch.ts` and hoping every other call site had reasoned the
-- same way. It had not: `spend` puts a period in the key on purpose, `secret.undecryptable`
-- deliberately never repeats, and nothing said which was which.
--
--   route          'now'    — send Telegram immediately, as every alert does today
--                  'digest' — record it; the daily digest is the first a human hears
--
--   repeat_policy  'once'     — one alert ever for this dedup key
--                  'on_change'— one alert per UNRESOLVED episode: a condition that holds
--                               says nothing more, and one that clears and returns speaks
--                               again because the earlier row is resolved
--                  'daily'    — today's behaviour, kept for the cases where each day IS a
--                               new fact. A ceiling reached again tomorrow is a new ceiling,
--                               and `spendDedupKey` puts the period in the key to say so
--
-- ## `resolved_at` is what makes `on_change` possible, and it is also the digest's input
--
-- Without it, "has this already fired" can only mean "does a row exist", which is `once`.
-- With it, the question becomes "is this episode still open" — and the set of open episodes
-- is exactly what a daily digest should list. One column answers both.
--
-- ## `notified_at` exists so re-escalation is an UPDATE, not a second row
--
-- A condition that alerts once and then falls silent has the opposite failure of one that
-- repeats daily: three weeks later nobody remembers it is still true. So an unresolved
-- `critical` re-escalates after three days. Doing that by inserting another row would put
-- the period back in the dedup key and undo the whole change; instead the existing row's
-- `notified_at` moves. `coalesce(notified_at, at)` is therefore "when was a human last told
-- about this", and it is null-safe for a `digest`-routed row that has never been sent.
--
-- `delivered` is NOT that column and is not being repurposed: it records whether the
-- Telegram call for this row succeeded, which is a different question from when a human was
-- last told, and conflating them is how "accepted for delivery" became "delivered" next
-- door.
--
-- ADDITIVE ONLY. Four columns, two of them nullable and two with defaults that reproduce
-- today's behaviour exactly, plus two partial indexes and two CHECKs. Nothing is dropped,
-- narrowed or rewritten; every existing row remains valid and unchanged, and an alert
-- raised by code that has not been redeployed still behaves as it did.

alter table alerts add column if not exists route         text not null default 'now';
alter table alerts add column if not exists repeat_policy text not null default 'daily';
alter table alerts add column if not exists resolved_at   timestamptz;
alter table alerts add column if not exists notified_at   timestamptz;

-- A CHECK has no `if not exists` in PG16, and this migration must be re-runnable against a
-- database that already has it — `localvalidate` rebuilds from empty, but the project does
-- not. Guarded on the catalog rather than on an exception handler, so a DIFFERENT error is
-- still raised rather than swallowed.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_route_known') then
    alter table alerts add constraint alerts_route_known check (route in ('now','digest'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alerts_repeat_policy_known') then
    alter table alerts add constraint alerts_repeat_policy_known
      check (repeat_policy in ('once','on_change','daily'));
  end if;
end
$$;

-- `on_change`'s lookup: the open episode for one dedup key. Partial, because a resolved row
-- can never satisfy it and the table is overwhelmingly resolved history once this is live.
create index if not exists alerts_open_by_key on alerts (dedup_key) where resolved_at is null;

-- The digest's scan, and the three-day re-escalation sweep. Ordered by severity first
-- because that is how the digest groups, and `coalesce(notified_at, at)` is the age it
-- sorts within.
create index if not exists alerts_open_by_severity on alerts (severity, at) where resolved_at is null;

comment on column alerts.route is
  'Where the FIRST notification goes: now = Telegram immediately (today''s behaviour, and '
  'the default so an un-redeployed caller is unchanged); digest = recorded only, and the '
  'daily digest is the first a human hears of it.';

comment on column alerts.repeat_policy is
  'Whether this condition may raise another row. once = never again for this dedup key; '
  'on_change = once per unresolved episode, so a condition that holds is silent and one '
  'that clears and returns speaks again; daily = the caller put a period in the dedup key '
  'because each day genuinely is a new fact (see spendDedupKey).';

comment on column alerts.resolved_at is
  'When the condition stopped being true. NULL means the episode is still open: it is what '
  'on_change suppresses against and what the daily digest lists. Set by the detector that '
  'observes recovery, never by the passage of time. MEANINGFUL ONLY FOR repeat_policy = '
  'on_change: those rows are episodes with an open/closed lifecycle. A once or daily row is '
  'an EVENT — a stranded message, a recovery, an erasure request — which happened and is '
  'over, so its resolved_at stays null and it is never listed as an open condition. The '
  'digest and the re-escalation sweep both filter on repeat_policy for exactly that reason.';

comment on column alerts.notified_at is
  'When a human was last told about THIS row — set on a now-routed send and moved again by '
  'the three-day re-escalation of an unresolved critical, so escalation is an update rather '
  'than a second row with a dated key. NULL on a digest-routed row nobody has been paged '
  'about; coalesce(notified_at, at) is the age the sweep measures. Not the same question as '
  'delivered, which records whether one Telegram call succeeded.';
