-- LOCAL REPLICA ONLY. Never run against the project; it needs a superuser.
--
-- Deletes one test tenant and proves nothing of it is left:
--
--     psql -d dala_local -v slug=tsetsegleg-demo -f scripts/localvalidate/drop-tenant.sql
--
-- Why a superuser script and not a command: on the project NO tenant can be deleted. The
-- append-only tables (`config_audit`, `config_snapshots`, …) carry STATEMENT triggers,
-- ENABLE ALWAYS, and a cascade from `tenants` issues a DELETE on each of them even when it
-- has no rows for that tenant — so the delete is refused, by design (0001 §9). A client who
-- withdraws is offboarded (`tenant_offboardings`), not deleted. Here, on a throwaway
-- replica, the triggers are disabled inside one transaction and restored before it ends.
\set ON_ERROR_STOP on
begin;
do $$
declare t text;
begin
  if current_database() not like 'dala\_%' or current_database() = 'postgres' then
    raise exception 'refusing: % does not look like a local replica', current_database();
  end if;
  foreach t in array array['spend_ledger','ledger_deadletter','audit_log','config_audit','consent_records',
    'config_snapshots','conversation_events','link_clicks','channel_transfers','quality_flags','quality_reviews'] loop
    execute format('alter table public.%I disable trigger %I', t, t || '_append_only');
  end loop;
end $$;

create temp table victim on commit drop as select id from tenants where slug = :'slug';
do $$ begin
  if (select count(*) from victim) <> 1 then raise exception 'no tenant with that slug'; end if;
  if exists (select 1 from tenant_channels c join victim v on v.id = c.tenant_id
             where c.delivery_mode = 'live' or c.went_live_at is not null) then
    raise exception 'refusing: this tenant has been live';
  end if;
end $$;
delete from alerts a using victim v where a.tenant_id = v.id;
delete from alerts where kind in ('provisioning.readiness:' || :'slug', 'provisioning.signature:' || :'slug');
delete from tenants t using victim v where t.id = v.id;

-- The proof: every table that carries a tenant column holds no row for it.
do $$
declare r record; n bigint; id uuid := (select id from victim); total bigint := 0;
begin
  for r in select table_schema, table_name, tenant_column from ops.tenant_scope loop
    execute format('select count(*) from %I.%I where %I = $1', r.table_schema, r.table_name, r.tenant_column)
      into n using id;
    if n > 0 then raise exception '%.% still holds % row(s)', r.table_schema, r.table_name, n; end if;
    total := total + 1;
  end loop;
  raise notice 'tenant % removed: 0 rows left in % tenant-scoped tables', id, total;
end $$;

do $$
declare t text;
begin
  foreach t in array array['spend_ledger','ledger_deadletter','audit_log','config_audit','consent_records',
    'config_snapshots','conversation_events','link_clicks','channel_transfers','quality_flags','quality_reviews'] loop
    execute format('alter table public.%I enable always trigger %I', t, t || '_append_only');
  end loop;
end $$;
commit;
