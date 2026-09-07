-- 0023 — when did this channel start expecting webhooks?
--
-- `0012` added `went_live_at` and opened with the question "when did this channel start
-- expecting traffic?" — then answered a narrower one, stamping only the transition into
-- `live`. The comment describes the concept; the trigger implements one case of it. That is
-- the same shape as the `WORKER_PUBLIC_URL` check and `deps.ts`'s hardcoded `cacheTtl`: a
-- rule and the code it describes each read as correct alone.
--
-- ## What it cost
--
-- Matrix was flipped to `shadow` on 2026-09-07 and is mirroring real customer traffic. Its
-- `went_live_at` is null, because `shadow` is not `live`. So `assessSilence` computes
-- `since = lastInboundAt ?? liveSince`, gets null for both, and returns `not_configured` —
-- which `diagnoseChannel` renders as `not_provisioned`, a verdict that is deliberately
-- recorded and never alerted.
--
-- That verdict is exactly right for a channel mid-setup and exactly wrong for one an
-- operator has deliberately pointed at live traffic. If the subscription broke, the only
-- symptom would be an empty table that nobody is watching — which is the failure the
-- watchdog exists to detect, acquired by the watchdog itself.
--
-- ## Why a second column rather than widening `went_live_at`
--
-- `0012`'s own argument, applied to itself. It refused to reuse `created_at` (a channel
-- provisioned in week one and cut over in week six would read as six weeks of silence) and
-- refused `name_confirmed_at` (it is "being asked to mean something it does not"). The same
-- objection lands on overloading `went_live_at`: "when did we start answering customers"
-- and "when did we start expecting webhooks" are different questions, and a column that
-- answers both answers neither reliably. `went_live_at` keeps its meaning.
--
-- ## Which modes expect traffic
--
-- `shadow_routing`, `shadow` and `live` — everything except `off`.
--
-- `shadow` is obvious: it receives, persists, generates and withholds. `shadow_routing`
-- was the arguable one, and it is IN, on the founder's call and for the better reason:
-- its entire purpose is proving that routing works, so silence is precisely its failure
-- mode. A tenant parked in `shadow_routing` before its Page is subscribed is a provisioning
-- gap, and a non-alerting verdict for provisioning gaps already exists — `not_provisioned`
-- is recorded and never paged. The alternative, excluding it, would have made the one mode
-- whose job is to prove delivery the one mode whose delivery nobody checks.
--
-- ## The backfill is `now()`, deliberately
--
-- Existing rows already in a traffic-expecting mode have no recorded transition. Two
-- candidates were rejected:
--
--   * `created_at` — for Matrix that is when Stage 1 inserted the row in `shadow_routing`,
--     which is honest, and it would put ~600 open minutes of parked-and-unprovisioned time
--     behind the 180-minute threshold. The watchdog would page on its very first run about
--     a window in which nobody expected anything. An alarm that fires the moment it is
--     installed is the alarm this module was written to avoid.
--   * `went_live_at` where set — correct for `live` channels and null for the one channel
--     that prompted this, so it solves nothing on its own. Used where it exists.
--
-- `now()` says what is true: this mechanism can only speak for the period it has observed.
-- It errs by delaying the first possible alert rather than by inventing one, which is the
-- safe direction for a watchdog's first day.
--
-- ADDITIVE ONLY: one column, two triggers, and a backfill that writes only nulls.

alter table tenant_channels add column if not exists expects_traffic_since timestamptz;

comment on column tenant_channels.expects_traffic_since is
  'Set by trigger on the first transition into any delivery_mode that expects webhooks '
  '(shadow_routing, shadow, live) — on INSERT as well as UPDATE. Never cleared: the '
  'question is "has this ever been expected to work", not "how long has this attempt been '
  'running". The silence watchdog measures from here when a channel has never received a '
  'webhook, which is the only symptom a field subscription that never worked ever produces.';

-- The set, in one place, so the trigger and any future reader cannot drift apart.
-- `search_path` is pinned on all three, as `catalog.sql` V26 requires of every app/ops
-- function definer or not. V26 caught these on the first run of this migration, which is
-- the check earning its place rather than a formality.
create or replace function ops.mode_expects_traffic(p_mode text) returns boolean
  language sql immutable
  set search_path = 'public', 'pg_temp'
  as $$
    select p_mode in ('shadow_routing', 'shadow', 'live');
  $$;

create or replace function ops.stamp_expects_traffic() returns trigger
  language plpgsql
  set search_path = 'public', 'pg_temp'
  as $$
begin
  -- `is distinct from` rather than `<>`: delivery_mode is NOT NULL today, and a null-unsafe
  -- comparison here would become a silent no-op if that ever changed.
  if ops.mode_expects_traffic(new.delivery_mode)
     and not ops.mode_expects_traffic(coalesce(old.delivery_mode, 'off'))
     and new.expects_traffic_since is null then
    new.expects_traffic_since := now();
  end if;
  return new;
end $$;

create or replace function ops.stamp_expects_traffic_on_insert() returns trigger
  language plpgsql
  set search_path = 'public', 'pg_temp'
  as $$
begin
  -- A channel created directly in a traffic-expecting mode never sees an UPDATE. `0012`
  -- learned this for `live` and shipped both triggers; the same hole exists here, and
  -- Matrix is the proof — Stage 1 INSERTED it at `shadow_routing`.
  if ops.mode_expects_traffic(new.delivery_mode) and new.expects_traffic_since is null then
    new.expects_traffic_since := now();
  end if;
  return new;
end $$;

drop trigger if exists tenant_channels_stamp_expects_traffic on tenant_channels;
create trigger tenant_channels_stamp_expects_traffic
  before update on tenant_channels
  for each row execute function ops.stamp_expects_traffic();

drop trigger if exists tenant_channels_stamp_expects_traffic_insert on tenant_channels;
create trigger tenant_channels_stamp_expects_traffic_insert
  before insert on tenant_channels
  for each row execute function ops.stamp_expects_traffic_on_insert();

-- The backfill. Only rows already in a traffic-expecting mode, only where the column is
-- null, and `went_live_at` is preferred where it exists because it is a recorded fact
-- rather than the time this migration happened to run.
update tenant_channels
   set expects_traffic_since = coalesce(went_live_at, now())
 where expects_traffic_since is null
   and ops.mode_expects_traffic(delivery_mode);
