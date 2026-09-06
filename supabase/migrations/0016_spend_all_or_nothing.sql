-- 0016 — the spend ledger reserves, releases and settles ALL OF ITS PERIODS OR NONE.
--
-- `reserve()` walked the counters one at a time:
--
--     for (const [scope, scopeKey] of [['tenant', tenantId], ['platform', 'platform']]) {
--       const granted = await db.rpc('reserve_spend', …);
--       if (granted !== true) { await release(db, reservationId); return refused; }
--     }
--
-- Two leaks fall out of that shape, and neither has ever been observed only because
-- nothing had reached the guard until 2026-09-06 (`reserved_nanousd` is still 0 on both
-- counters — this is built before it can bite, not after):
--
--  1. **A partial reservation.** The tenant counter is incremented, the platform counter
--     refuses, and the tenant's day is charged for a reply that never happened. Nothing
--     ever gives it back: the day's ceiling is simply lower until midnight.
--  2. **`release()` was a label, not a refund.** It set `spend_reservations.state`
--     and touched no counter at all — so every 503 after a successful reserve (a model
--     timeout, a retryable send) consumed the estimate permanently, once per QStash
--     retry. Three attempts at $0.012 is $0.036 of a $0.475 day, for one message.
--
-- ## Why one statement per operation, rather than a loop that undoes itself
--
-- A compensating undo has to run to be correct, and the case it exists for is exactly the
-- case where something has just failed. So the whole set moves in one statement, under
-- the per-row guard the single-row version already had:
--
--   * every target row is updated by ONE `update … from want`, so each row's
--     `reserved + settled + amount <= ceiling` check is evaluated against the row the
--     statement locks — the same concurrency property `app.reserve_spend` has today;
--   * if fewer rows moved than were asked for, the function RAISES, and PostgreSQL rolls
--     back everything the function wrote. There is no partial state to compensate for
--     because there is no partial state.
--
-- A missing counter row counts as "did not move", so a target with no ceiling refuses
-- rather than passing unchecked — the same direction `effectiveDailyCeiling` already
-- takes when it cannot read.
--
-- ## The two error codes are load-bearing
--
--   * `23514` (check_violation) means A CEILING REFUSED — the caller degrades (429).
--   * anything else means we could not determine — the caller refuses (503).
--
-- A negative amount therefore raises `22023` rather than `23514`: it is a programming
-- error, and dressing it as a ceiling would quietly turn a bug into a degradation.
--
-- `p_targets` is a jsonb array of `{scope, scope_key, period_kind, period_key}` so the
-- shape does not change when a monthly ceiling is added — the caller passes two more
-- entries and the all-or-nothing property covers them for free. **Nothing here wires a
-- month:** the platform's monthly cap and the degradation ladder are the founder's
-- numbers to pick, and this migration does not presume them.
--
-- ADDITIVE ONLY: three new functions and their wrappers. The single-row originals stay,
-- untouched and still granted, because `0015`'s wrappers are pointed at them.

create or replace function app.reserve_spend_all(
  p_targets         jsonb,
  p_surface         text,
  p_amount_nanousd  bigint
) returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  n       integer := coalesce(jsonb_array_length(p_targets), 0);
  moved   integer;
begin
  if p_amount_nanousd < 0 then
    raise exception 'negative reservation' using errcode = 'invalid_parameter_value';
  end if;
  if n = 0 then
    raise exception 'no spend target' using errcode = 'invalid_parameter_value';
  end if;

  with want as (
    select t->>'scope' as scope, t->>'scope_key' as scope_key,
           t->>'period_kind' as period_kind, t->>'period_key' as period_key
      from jsonb_array_elements(p_targets) as t
  ), done as (
    update spend_counters c
       set reserved_nanousd = c.reserved_nanousd + p_amount_nanousd,
           count_used       = c.count_used + 1,
           updated_at       = now()
      from want w
     where c.scope = w.scope and c.scope_key = w.scope_key
       and c.period_kind = w.period_kind and c.period_key = w.period_key
       and c.surface = p_surface
       and c.ceiling_nanousd is not null
       and c.reserved_nanousd + c.settled_nanousd + p_amount_nanousd <= c.ceiling_nanousd
    returning 1
  )
  select count(*) into moved from done;

  if moved <> n then
    -- Rolls back every row this function moved. 23514 is the caller's signal to degrade.
    raise exception 'ceiling_reached' using errcode = 'check_violation';
  end if;
  return true;
end
$function$;

-- Give the budget back. CAS on `held` so a reservation already marked `called` — where
-- the provider may have been reached — can never be refunded by a late release.
create or replace function app.release_spend(
  p_reservation_id  uuid,
  p_targets         jsonb,
  p_surface         text,
  p_amount_nanousd  bigint
) returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  claimed uuid;
begin
  update spend_reservations
     set state = 'released'
   where id = p_reservation_id and state = 'held'
  returning id into claimed;

  -- Not held: either somebody else released it, or it is `called` and the money may be
  -- spent. Either way this is not ours to refund, and saying so is not an error.
  if claimed is null then return false; end if;

  with want as (
    select t->>'scope' as scope, t->>'scope_key' as scope_key,
           t->>'period_kind' as period_kind, t->>'period_key' as period_key
      from jsonb_array_elements(p_targets) as t
  )
  update spend_counters c
     set reserved_nanousd = greatest(0, c.reserved_nanousd - p_amount_nanousd),
         updated_at       = now()
    from want w
   where c.scope = w.scope and c.scope_key = w.scope_key
     and c.period_kind = w.period_kind and c.period_key = w.period_key
     and c.surface = p_surface;

  return true;
end
$function$;

-- Settling has the same partial-failure shape: the tenant row moves reserved -> settled
-- and the platform row does not, leaving the platform's day permanently short by one
-- reply's estimate. One statement, same reasoning.
create or replace function app.settle_spend_all(
  p_targets           jsonb,
  p_surface           text,
  p_reserved_nanousd  bigint,
  p_actual_nanousd    bigint
) returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  n     integer := coalesce(jsonb_array_length(p_targets), 0);
  moved integer;
begin
  if p_reserved_nanousd < 0 or p_actual_nanousd < 0 then
    raise exception 'negative settlement' using errcode = 'invalid_parameter_value';
  end if;
  if n = 0 then
    raise exception 'no spend target' using errcode = 'invalid_parameter_value';
  end if;

  with want as (
    select t->>'scope' as scope, t->>'scope_key' as scope_key,
           t->>'period_kind' as period_kind, t->>'period_key' as period_key
      from jsonb_array_elements(p_targets) as t
  ), done as (
    update spend_counters c
       set reserved_nanousd = greatest(0, c.reserved_nanousd - p_reserved_nanousd),
           settled_nanousd  = c.settled_nanousd + p_actual_nanousd,
           updated_at       = now()
      from want w
     where c.scope = w.scope and c.scope_key = w.scope_key
       and c.period_kind = w.period_kind and c.period_key = w.period_key
       and c.surface = p_surface
    returning 1
  )
  select count(*) into moved from done;

  -- A settlement that reached only some of its counters leaves the ledger wrong in a way
  -- no later run repairs, so it rolls back and the caller retries.
  if moved <> n then
    raise exception 'settle_incomplete' using errcode = 'check_violation';
  end if;
  return true;
end
$function$;

-- The runtime reaches PostgREST on the `public` profile (0015), so the wrappers are what
-- it can actually call. INVOKER for the same reason as 0015: the inner functions are
-- already DEFINER and `service_role` holds USAGE on `app`.
create or replace function public.reserve_spend_all(
  p_targets jsonb, p_surface text, p_amount_nanousd bigint
) returns boolean
language sql security invoker set search_path = 'public', 'pg_temp'
as $$ select app.reserve_spend_all(p_targets, p_surface, p_amount_nanousd); $$;

create or replace function public.release_spend(
  p_reservation_id uuid, p_targets jsonb, p_surface text, p_amount_nanousd bigint
) returns boolean
language sql security invoker set search_path = 'public', 'pg_temp'
as $$ select app.release_spend(p_reservation_id, p_targets, p_surface, p_amount_nanousd); $$;

create or replace function public.settle_spend_all(
  p_targets jsonb, p_surface text, p_reserved_nanousd bigint, p_actual_nanousd bigint
) returns boolean
language sql security invoker set search_path = 'public', 'pg_temp'
as $$ select app.settle_spend_all(p_targets, p_surface, p_reserved_nanousd, p_actual_nanousd); $$;

-- PUBLIC holds EXECUTE on every new function, and a `public` function is REST-reachable:
-- unrevoked, `anon` could drive any tenant's counter to its ceiling unauthenticated.
revoke all on function app.reserve_spend_all(jsonb, text, bigint) from public, anon, authenticated;
revoke all on function app.release_spend(uuid, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function app.settle_spend_all(jsonb, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.reserve_spend_all(jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.release_spend(uuid, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.settle_spend_all(jsonb, text, bigint, bigint) from public, anon, authenticated;

grant execute on function app.reserve_spend_all(jsonb, text, bigint) to service_role;
grant execute on function app.release_spend(uuid, jsonb, text, bigint) to service_role;
grant execute on function app.settle_spend_all(jsonb, text, bigint, bigint) to service_role;
grant execute on function public.reserve_spend_all(jsonb, text, bigint) to service_role;
grant execute on function public.release_spend(uuid, jsonb, text, bigint) to service_role;
grant execute on function public.settle_spend_all(jsonb, text, bigint, bigint) to service_role;
