-- 0012 — when did this channel start expecting traffic?
--
-- The silence watchdog needs a clock to measure from when a channel has NEVER received
-- anything, which is the failure `STATUS.md` §5 item 15 warns about: a page-level
-- subscribe returns `{"success": true}` even when the app has never enabled that field,
-- and no events are ever delivered. Without a start time that case is unmeasurable, and
-- unmeasurable means unalerted — the watchdog would be blind to the one fault that has no
-- other symptom at all.
--
-- ## Why not reuse a column that already exists
--
-- `created_at` is wrong: a channel provisioned in week one and cut over in week six would
-- read as six weeks of silence the instant it goes live, and an alarm that fires on
-- go-live is an alarm the operator learns to dismiss during exactly the hour they should
-- be watching. `name_confirmed_at` is closer — `live_requires_name_confirmation` makes it
-- a precondition — but it is the time somebody confirmed a NAME, which can be days before
-- the cutover, and it is being asked to mean something it does not.
--
-- ## The trigger is the point, not the column
--
-- `delivery_mode` is moved by an operator typing SQL, and a column that has to be set by
-- hand alongside it will be forgotten precisely once — after which the watchdog is silent
-- about a channel that has never worked, which is the watchdog acquiring the defect it
-- exists to detect. The trigger makes the timestamp a consequence of the state change
-- rather than a second thing to remember.
--
-- It stamps only on the transition INTO 'live', and never clears: a channel taken back to
-- 'shadow' for a day and returned to 'live' keeps its original go-live time, because the
-- question the watchdog asks is "has this ever worked", not "how long has this attempt
-- been running".
--
-- ADDITIVE ONLY: one column and one trigger. No existing data is rewritten — and there is
-- none, because no Supabase project exists.

alter table tenant_channels add column if not exists went_live_at timestamptz;

comment on column tenant_channels.went_live_at is
  'Set by trigger on the first transition of delivery_mode into ''live''. The silence '
  'watchdog measures from here when a channel has never received a webhook, which is the '
  'only symptom a field subscription that never worked ever produces.';

create or replace function ops.stamp_went_live() returns trigger
  language plpgsql as $$
begin
  -- Only the transition in, and only once. `is distinct from` rather than `<>` because
  -- delivery_mode is NOT NULL today and a null-unsafe comparison here would be a silent
  -- no-op if that ever changes.
  if new.delivery_mode = 'live'
     and old.delivery_mode is distinct from 'live'
     and new.went_live_at is null then
    new.went_live_at := now();
  end if;
  return new;
end $$;

drop trigger if exists tenant_channels_stamp_went_live on tenant_channels;
create trigger tenant_channels_stamp_went_live
  before update on tenant_channels
  for each row execute function ops.stamp_went_live();

-- A channel inserted directly at 'live' would never see an UPDATE, so it needs the same
-- stamp on the way in. Separate trigger rather than `before insert or update`, because the
-- INSERT case has no `old` row and sharing one function would mean referencing `old` in a
-- context where it does not exist.
create or replace function ops.stamp_went_live_on_insert() returns trigger
  language plpgsql as $$
begin
  if new.delivery_mode = 'live' and new.went_live_at is null then
    new.went_live_at := now();
  end if;
  return new;
end $$;

drop trigger if exists tenant_channels_stamp_went_live_insert on tenant_channels;
create trigger tenant_channels_stamp_went_live_insert
  before insert on tenant_channels
  for each row execute function ops.stamp_went_live_on_insert();

-- Backfill: any channel already live gets stamped now rather than staying null. There are
-- none today; if that assumption is ever wrong, "live since the migration ran" is late but
-- measurable, where null is neither.
update tenant_channels set went_live_at = now()
 where delivery_mode = 'live' and went_live_at is null;
