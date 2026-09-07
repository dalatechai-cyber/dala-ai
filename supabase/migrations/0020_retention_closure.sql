-- 0020 — close the retention gap: `raw_purged_at`, the knob, and the purge job.
--
-- `02-schema-rls.md` § Retention decided this long ago: NULL `webhook_events.raw_payload`
-- at 7 days (configurable 1-30), delete the row at 30. Half of it shipped. Measured against
-- the live project on 2026-09-07 (D-044):
--
--   * `tenants.retention_days_raw_events`  — absent. Only the messages knob exists.
--   * `webhook_events.raw_purged_at`       — absent. A nulled payload was indistinguishable
--                                            from an event that never carried one.
--   * `ops.purge_expired`                  — absent. `ops` held exactly `deny_mutation`,
--                                            `deny_truncate`, `stamp_went_live`,
--                                            `stamp_went_live_on_insert`.
--
-- So `purge_after` was written by nothing and read by nothing, and the column existing made
-- it look otherwise. This migration is what makes retention true rather than designed.
--
-- It became urgent because the DATA changed, not the design: Matrix's Page is subscribed
-- (D-043) and provisioned (Stage 1), so `raw_payload` now holds a third party's customers'
-- verbatim messages, and Meta's deletion callback still cannot join an app-scoped id to a
-- page-scoped one.
--
-- ## `purge_after` stays unwritten, deliberately
--
-- The obvious move is to stamp `purge_after = received_at + interval` at claim time. It is
-- the wrong one: it freezes the policy in force on the day the row arrived, so lowering a
-- tenant's retention would not shorten the life of a single row already stored. Retention
-- is therefore COMPUTED from `received_at` at purge time, and `purge_after` remains
-- deliberately null — an override slot for a future per-row hold (a legal preservation
-- request), not the mechanism.
--
-- ## Why NULL the payload at 7 days rather than delete the row
--
-- The lower bound on a webhook_events row's life is IDEMPOTENCY, not privacy.
-- `unique (provider, dedup_key)` is the only thing stopping a Meta redelivery being
-- answered twice, and that guarantee lives IN THE ROW. Delete the row and the key goes with
-- it, so a redelivery afterwards is a new event and a second reply to a real customer.
-- Nulling the payload destroys the PII and keeps the key. The 30-day row delete clears
-- Meta's redelivery window (§3.15 item 4, [UNVERIFIED] but observed in hours) by orders of
-- magnitude.
--
-- ## `decided_at`, fixed on the founder's instruction
--
-- It was `not null default now()`, so an OPEN proposal read as decided at the moment it was
-- created — a column that answers plausibly instead of admitting it has nothing to say,
-- which is D-020's failure in miniature. Now nullable, with a CHECK that a decided proposal
-- must say when. Zero rows at authoring time, so nothing is rewritten.
--
-- ADDITIVE plus two column relaxations. No table dropped, no column dropped, no data
-- narrowed. The one UPDATE touches `state='open'` rows, of which there are none.

-- ---------------------------------------------------------------------------
-- 1. The knob and the marker
-- ---------------------------------------------------------------------------

alter table tenants
  add column if not exists retention_days_raw_events int not null default 7;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retention_days_raw_events_sane') then
    alter table tenants add constraint retention_days_raw_events_sane
      check (retention_days_raw_events between 1 and 30);
  end if;
end $$;

comment on column tenants.retention_days_raw_events is
  'Days before webhook_events.raw_payload is nulled. §2 default 7, range 1-30. The ROW '
  'lives 30 days regardless, because the dedup key inside it is what stops a redelivery '
  'being answered twice.';

alter table webhook_events
  add column if not exists raw_purged_at timestamptz;

comment on column webhook_events.raw_purged_at is
  'When raw_payload was nulled by ops.purge_expired. Distinguishes a purged payload from '
  'an event that never carried one — without it the two are identical.';

comment on column webhook_events.purge_after is
  'DELIBERATELY UNWRITTEN. Retention is computed from received_at at purge time so a '
  'policy change applies to rows already stored; stamping this at claim time would freeze '
  'the old policy into every row. Reserved as a per-row override (e.g. a legal hold).';

-- ---------------------------------------------------------------------------
-- 2. decided_at tells the truth about open proposals
-- ---------------------------------------------------------------------------

alter table kb_change_proposals alter column decided_at drop default;
alter table kb_change_proposals alter column decided_at drop not null;
update kb_change_proposals set decided_at = null where state = 'open';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'decision_names_a_time') then
    alter table kb_change_proposals add constraint decision_names_a_time
      check (state = 'open' or decided_at is not null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The purge
-- ---------------------------------------------------------------------------

-- Three properties §2 declares non-negotiable, and each is visible in the body below:
--   * it touches NO upstream provider — it is SQL, it cannot;
--   * it is bounded per run and REPORTS whether it hit the ceiling, because a purge
--     silently falling behind is how a retention promise becomes false;
--   * it reports what it did into `audit_log`, which is append-only and accepts inserts.
--
-- It touches only tables with no append-only trigger. `webhook_events` has none, by
-- §2's design, precisely so this is possible.
create or replace function ops.purge_expired(p_max_rows int default 50000)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_payloads_purged int := 0;
  v_rows_deleted    int := 0;
  v_ceiling_hit     boolean := false;
  v_result          jsonb;
begin
  if p_max_rows < 1 then
    raise exception 'purge_expired: p_max_rows must be at least 1, got %', p_max_rows;
  end if;

  -- (a) Delete the row at 30 days. NOT configurable (§2): below this the dedup key stops
  --     outliving Meta's redelivery window, and the floor is a correctness property rather
  --     than a privacy preference.
  --
  --     THIS RUNS FIRST, and the order is load-bearing for the counts rather than for the
  --     outcome. Nulling first meant a 40-day-old row was counted in `payloads_purged` and
  --     then again in `rows_deleted` — one row, two numbers, and an audit trail that
  --     overstates what a run did. Deleting first makes the two counts disjoint. Caught by
  --     P5 in `scripts/verify/retention.sql`, which is the whole reason that check asserts
  --     on the numbers and not only on the rows.
  with due as (
    select id from webhook_events
     where received_at < now() - interval '30 days'
     order by received_at
     limit p_max_rows
  )
  delete from webhook_events e using due where e.id = due.id;
  get diagnostics v_rows_deleted = row_count;

  -- (b) NULL the payload at the tenant's own retention, for everything that survived (a).
  --     If the delete hit its ceiling, the ancient rows it did not reach still get their
  --     payload nulled here — the PII goes even when the row lingers, which is the safe
  --     direction for a bounded job to fall behind in.
  --
  -- An UNROUTED event has tenant_id null — it belongs to nobody, and it is the row most
  -- likely to hold a third party's PII we were never entitled to store. It therefore gets
  -- the FLOOR (1 day), not the default: the shortest retention the constraint permits,
  -- because there is no tenant whose policy could justify keeping it longer.
  with due as (
    select e.id
      from webhook_events e
      left join tenants t on t.id = e.tenant_id
     where e.raw_payload is not null
       and e.raw_purged_at is null
       and e.received_at < now() - make_interval(
             days => case when e.tenant_id is null then 1
                          else coalesce(t.retention_days_raw_events, 7) end)
     order by e.received_at
     limit p_max_rows
  )
  update webhook_events e
     set raw_payload = null, raw_purged_at = now()
    from due
   where e.id = due.id;
  get diagnostics v_payloads_purged = row_count;

  v_ceiling_hit := (v_payloads_purged >= p_max_rows) or (v_rows_deleted >= p_max_rows);

  v_result := jsonb_build_object(
    'payloads_purged', v_payloads_purged,
    'rows_deleted',    v_rows_deleted,
    'ceiling_hit',     v_ceiling_hit,
    'max_rows',        p_max_rows
  );

  -- Always, including a run that did nothing: "the purge ran and found nothing" and "the
  -- purge did not run" are different facts, and only a row can tell them apart.
  insert into audit_log (tenant_id, actor, action, detail)
  values (null, null, 'retention.purge_expired', v_result);

  return v_result;
end $$;

-- The D-029 trap, avoided rather than rediscovered: every client in `supabase/clients.ts`
-- is built with no `db: { schema }`, so PostgREST is asked for `public.<name>`. A function
-- in `ops` is unreachable from the runtime no matter how correct it is — which is exactly
-- how `app.reserve_spend` refused every reply for every tenant until `0015`.
create or replace function public.purge_expired(p_max_rows int default 50000)
returns jsonb
language sql
security invoker
set search_path = 'public', 'pg_temp'
as $$
  select ops.purge_expired(p_max_rows);
$$;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function. Left alone, `anon` could POST
-- to /rest/v1/rpc/purge_expired and delete this platform's inbound history unauthenticated.
revoke all on function ops.purge_expired(int) from public;
revoke all on function public.purge_expired(int) from public;
grant execute on function ops.purge_expired(int) to postgres, service_role;
grant execute on function public.purge_expired(int) to postgres, service_role;
