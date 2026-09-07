-- 0021 — the messages half of §2's retention table.
--
-- `0020` closed `webhook_events`. `02-schema-rls.md` § Retention also specifies
-- `messages.body`: null it at `retention_days_messages` (shipped as
-- `tenants.message_retention_days`, default 90, range 7-730), set `body_redacted_at`, keep
-- the row so counts and the ledger link survive. That half was left out of `0020` on
-- purpose — the instruction named the `webhook_events` rows — and reported as a follow-up
-- rather than quietly widened. This is that follow-up.
--
-- It became worth doing now because the DATA changed: Matrix's Page is provisioned and
-- routing (Stage 1), so their customers' messages land in `messages` for real, and this is
-- the same PII in a second table.
--
-- ## Everything it needs already exists, and was designed for
--
--   * `messages.body_redacted_at` — shipped in `0001`.
--   * `redacted_or_present` — `CHECK (body IS NOT NULL OR body_redacted_at IS NOT NULL)`,
--     so the database refuses a nulled body that does not say it was redacted. The pairing
--     is not a convention this function has to remember.
--   * `readHistory` already skips a redacted row rather than sending an empty turn — its
--     own comment says "a retention purge must not put a blank turn in front of the model".
--   * `messages` carries no append-only trigger, unlike `spend_ledger` and `audit_log`,
--     which is what makes an UPDATE possible at all.
--
-- So only the purge itself was missing.
--
-- ## Why the row survives, and why that is a different reason from webhook_events'
--
-- `webhook_events` rows survive redaction because the dedup key inside them is what stops a
-- Meta redelivery being answered twice — an IDEMPOTENCY reason (D-045). `messages` rows
-- survive for a different one: they carry `revision_id`, `prompt_hash` and `answered_by`,
-- which is how a reply is traced back to the config that produced it, and deleting them
-- would silently change historical counts. Redaction destroys the PII and keeps the link.
--
-- ADDITIVE: replaces one function, adds one field to its return value. No table, no column,
-- no data narrowed. On today's data it is a no-op — nothing is 90 days old.

create or replace function ops.purge_expired(p_max_rows int default 50000)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_payloads_purged int := 0;
  v_rows_deleted    int := 0;
  v_bodies_redacted int := 0;
  v_ceiling_hit     boolean := false;
  v_result          jsonb;
begin
  if p_max_rows < 1 then
    raise exception 'purge_expired: p_max_rows must be at least 1, got %', p_max_rows;
  end if;

  -- (a) Delete the webhook_events row at 30 days. NOT configurable (§2): below this the
  --     dedup key stops outliving Meta's redelivery window, and the floor is a correctness
  --     property rather than a privacy preference.
  --
  --     THIS RUNS FIRST, and the order is load-bearing for the counts rather than for the
  --     outcome. Nulling first meant a 40-day-old row was counted in `payloads_purged` and
  --     then again in `rows_deleted` — one row, two numbers, and an audit trail that
  --     overstates what a run did. Caught by P5 in `scripts/verify/retention.sql`.
  with due as (
    select id from webhook_events
     where received_at < now() - interval '30 days'
     order by received_at
     limit p_max_rows
  )
  delete from webhook_events e using due where e.id = due.id;
  get diagnostics v_rows_deleted = row_count;

  -- (b) NULL the payload at the tenant's own retention, for everything that survived (a).
  --     An UNROUTED event has tenant_id null — it belongs to nobody, and it is the row most
  --     likely to hold a third party's PII we were never entitled to store. It therefore
  --     gets the FLOOR (1 day), not the default.
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

  -- (c) Redact message bodies past the tenant's own message retention.
  --
  --     `body_redacted_at` is set in the same statement, not as a follow-up: the
  --     `redacted_or_present` CHECK refuses the row otherwise, so a half-done redaction
  --     cannot commit. `messages.tenant_id` is NOT NULL, so unlike (b) there is no
  --     ownerless case and no floor — every message has a tenant whose policy applies.
  with due as (
    select m.id
      from messages m
      join tenants t on t.id = m.tenant_id
     where m.body is not null
       and m.body_redacted_at is null
       and m.at < now() - make_interval(days => coalesce(t.message_retention_days, 90))
     order by m.at
     limit p_max_rows
  )
  update messages m
     set body = null, body_redacted_at = now()
    from due
   where m.id = due.id;
  get diagnostics v_bodies_redacted = row_count;

  v_ceiling_hit := (v_payloads_purged >= p_max_rows)
                or (v_rows_deleted >= p_max_rows)
                or (v_bodies_redacted >= p_max_rows);

  v_result := jsonb_build_object(
    'payloads_purged', v_payloads_purged,
    'rows_deleted',    v_rows_deleted,
    'bodies_redacted', v_bodies_redacted,
    'ceiling_hit',     v_ceiling_hit,
    'max_rows',        p_max_rows
  );

  -- Always, including a run that did nothing: "the purge ran and found nothing" and "the
  -- purge did not run" are different facts, and only a row can tell them apart.
  insert into audit_log (tenant_id, actor, action, detail)
  values (null, null, 'retention.purge_expired', v_result);

  return v_result;
end $$;

revoke all on function ops.purge_expired(int) from public;
grant execute on function ops.purge_expired(int) to postgres, service_role;
