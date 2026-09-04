-- Dala AI — catalog verification pack.
--
-- Run after EVERY migration that touches grants, policies, triggers or seeds, and
-- in CI on staging for any PR touching supabase/. It reads what the database
-- actually enforces, never what a migration file says it enforces.
--
-- Two sources are deliberately NOT consulted, because both lie by returning a
-- plausible answer instead of an error:
--   * supabase_migrations.schema_migrations — not a ledger for dashboard-applied SQL.
--   * information_schema.role_table_grants  — permission-filtered; zero rows is not
--     evidence of zero grants, it is evidence you were not party to the grant.
--
-- This file RAISES on failure. A pack that prints rows and exits 0 is a pack that
-- passes on a system whose ledger triggers have been dropped.

\set ON_ERROR_STOP on

create temporary table _v (id text, name text, detail text, ok boolean);

-- V0 — collation. lower() on Cyrillic under C/POSIX returns the string UNCHANGED,
-- silently. It cannot be changed after the database is created, so it is asserted
-- on day one or never.
insert into _v select 'V0', 'collation is not C/POSIX',
  d.datcollate, d.datcollate not in ('C','POSIX')
  from pg_database d where d.datname = current_database();

-- V1 — unaccent must NOT be installed: it maps Ё→Е while leaving Й, Ө, Ү alone,
-- so it is partially destructive on Mongolian and passes nine tests in ten.
insert into _v select 'V1', 'unaccent is not installed',
  coalesce(string_agg(extname, ','), 'absent'), count(*) = 0
  from pg_extension where extname = 'unaccent';

-- V2 — RLS enabled on EVERY public table, checked per table. The last failure of
-- this kind next door was partial: one of four tables.
insert into _v select 'V2', 'RLS enabled on every public table',
  coalesce(string_agg(c.relname, ', '), 'none missing'), count(*) = 0
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

-- V3 — RLS also FORCED, so the table owner is bound too — except the two lookup
-- tables the SECURITY DEFINER helpers read, where FORCE would make those helpers
-- return zero rows and silently deny every member read. The exception is asserted
-- exactly, so a third table quietly losing FORCE still fails this check.
insert into _v select 'V3', 'RLS forced everywhere except the two definer sources',
  coalesce(string_agg(c.relname, ', '), 'exactly as expected'),
  coalesce(array_agg(c.relname::text order by c.relname::text), '{}'::text[]) = array['platform_admins','tenant_members']::text[]
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity;

-- V4 — every public table carries at least one policy. A table with RLS on and no
-- policy denies everything, which is safe but is usually a mistake, not a decision.
insert into _v select 'V4', 'every public table has >=1 policy',
  coalesce(string_agg(c.relname, ', '), 'none missing'), count(*) = 0
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname);

-- V5 — anon holds NO privilege of any kind, on any table, in any schema.
-- Enumerated through aclexplode, not through information_schema.
insert into _v select 'V5', 'anon holds no privilege anywhere',
  coalesce(string_agg(distinct c.relname || ':' || a.privilege_type, ', '), 'none'), count(*) = 0
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
 where n.nspname in ('public','app','ops') and r.rolname = 'anon';

-- V6 — authenticated holds SELECT and nothing else. This is the check that catches
-- the residue Supabase's bootstrap `grant all` leaves behind: TRUNCATE, REFERENCES,
-- TRIGGER and (on 17) MAINTAIN survive a `revoke insert, update, delete`.
insert into _v select 'V6', 'authenticated holds only SELECT',
  coalesce(string_agg(distinct c.relname || ':' || a.privilege_type, ', '), 'select only'), count(*) = 0
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
 where n.nspname in ('public','app','ops') and r.rolname = 'authenticated'
   and a.privilege_type <> 'SELECT';

-- V7 — every table ops.tenant_scope names actually has the column it names.
-- The pack is driven from that table, so a wrong row silently skips a table.
insert into _v select 'V7', 'tenant_scope columns all exist',
  coalesce(string_agg(ts.table_name || '.' || ts.tenant_column, ', '), 'all present'), count(*) = 0
  from ops.tenant_scope ts
 where not exists (
   select 1 from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ts.table_schema and c.relname = ts.table_name
      and a.attname = ts.tenant_column and a.attnum > 0 and not a.attisdropped);

-- V8 — every table with a tenant_id column is registered in ops.tenant_scope.
-- This is the "did I forget a table" check: a new tenant-scoped table added without
-- registering it gets no read policy and no grant, and nobody notices.
insert into _v select 'V8', 'every tenant_id table is registered',
  coalesce(string_agg(c.relname, ', '), 'all registered'), count(*) = 0
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
                     and a.attnum > 0 and not a.attisdropped
 where n.nspname = 'public' and c.relkind = 'r'
   and not exists (select 1 from ops.tenant_scope ts
                    where ts.table_schema='public' and ts.table_name = c.relname);

-- V9 — append-only tables carry BOTH guards, and both are ENABLE ALWAYS so they
-- bind service_role, which holds BYPASSRLS and is the writer that matters.
insert into _v select 'V9', 'append-only tables have both ALWAYS triggers',
  coalesce(string_agg(sc.table_name, ', '), 'all guarded'), count(*) = 0
  from ops.table_security_class sc
 where sc.class = 'append_only'
   and (select count(*) from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = sc.table_name
          and not t.tgisinternal and t.tgenabled = 'A') < 2;

-- V10 — service_role cannot TRUNCATE an append-only table. TRUNCATE is not DML:
-- no UPDATE/DELETE trigger and no restrictive policy stops it.
insert into _v select 'V10', 'service_role cannot truncate append-only tables',
  coalesce(string_agg(sc.table_name, ', '), 'none truncatable'), count(*) = 0
  from ops.table_security_class sc
  join pg_class c on c.relname = sc.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
 where sc.class = 'append_only' and r.rolname = 'service_role' and a.privilege_type = 'TRUNCATE';

-- V11 — every SECURITY DEFINER function pins search_path. Without it a caller who
-- can create objects can shadow a table name and have it resolved as the owner.
insert into _v select 'V11', 'security definer functions pin search_path',
  coalesce(string_agg(n.nspname || '.' || p.proname, ', '), 'all pinned'), count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('app','ops','public') and p.prosecdef
   and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) cfg where cfg like 'search_path=%');

-- V12 — no model id carries a date suffix. The ancestor pins one in one channel and
-- not the other; a stale dated id is how a retired model becomes a silent fallback.
insert into _v select 'V12', 'no date-suffixed model ids',
  coalesce(string_agg(model_id, ', '), 'clean'), count(*) = 0
  from model_prices where model_id ~ '-20[0-9]{6}$';

-- V13 — the seeds that make the first message work at all.
insert into _v select 'V13', 'platform reference tables are seeded',
  format('providers=%s roles=%s prices=%s fx=%s canned=%s policies=%s fold=%s probes=%s',
    (select count(*) from channel_providers), (select count(*) from roles),
    (select count(*) from model_prices), (select count(*) from fx_rates),
    (select count(*) from canned_response_kinds), (select count(*) from outbound_policies),
    (select count(*) from mn_fold), (select count(*) from probe_templates)),
  (select count(*) from channel_providers) > 0 and (select count(*) from roles) > 0
  and (select count(*) from model_prices) > 0 and (select count(*) from fx_rates) > 0
  and (select count(*) from canned_response_kinds) > 0 and (select count(*) from outbound_policies) > 0
  and (select count(*) from mn_fold) > 0 and (select count(*) from probe_templates) > 0;

-- V14 — the composite-FK spine. Every foreign key from a tenant-scoped table to
-- another tenant-scoped table must include tenant_id on both sides. This is the
-- control that survives a service-role bug, which RLS does not.
insert into _v select 'V14', 'tenant-scoped FKs carry tenant_id',
  coalesce(string_agg(con.conname, ', '), 'spine intact'), count(*) = 0
  from pg_constraint con
  join pg_class child  on child.oid  = con.conrelid
  join pg_class parent on parent.oid = con.confrelid
  join pg_namespace n  on n.oid = child.relnamespace
 where con.contype = 'f' and n.nspname = 'public'
   and exists (select 1 from ops.tenant_scope ts where ts.table_name = child.relname  and ts.tenant_column='tenant_id')
   and exists (select 1 from ops.tenant_scope ts where ts.table_name = parent.relname and ts.tenant_column='tenant_id')
   and not (
     select coalesce(bool_or(a.attname = 'tenant_id'), false)
       from unnest(con.conkey) k join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k
   );

-- V15 — authenticated holds SELECT ONLY on tables deliberately marked client-readable.
-- This is the check that catches a mechanical "has a tenant_id, therefore grant it"
-- rule handing a tenant its own spend ledger, secrets or raw webhook payloads.
insert into _v select 'V15', 'no client grant on non-readable tables',
  coalesce(string_agg(distinct c.relname, ', '), 'none over-granted'), count(*) = 0
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  join ops.table_security_class sc on sc.table_schema='public' and sc.table_name = c.relname
 where r.rolname = 'authenticated' and not sc.client_readable;

-- V16 — and every client-readable table actually HAS its read policy. The inverse of
-- V15, and the check that catches the seeding-order failure: loops that run, succeed
-- and create nothing.
insert into _v select 'V16', 'every client-readable table has a read policy',
  coalesce(string_agg(sc.table_name, ', '), 'all present'), count(*) = 0
  from ops.table_security_class sc
 where sc.table_schema = 'public' and sc.client_readable
   and not exists (select 1 from pg_policies p
                    where p.schemaname='public' and p.tablename = sc.table_name
                      and p.policyname = sc.table_name || '_member_read');

-- V17 — the restrictive write-deny policies exist per command. A single `for all`
-- restrictive policy would also deny SELECT and silently break every client read.
insert into _v select 'V17', 'write-deny policies are per-command, not FOR ALL',
  coalesce(string_agg(c.relname, ', '), 'all correct'), count(*) = 0
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname='public' and c.relkind='r'
 where (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename=c.relname
           and p.policyname in (c.relname||'_no_client_insert',
                                c.relname||'_no_client_update',
                                c.relname||'_no_client_delete')) <> 3;

-- V18 — the freshness knob is a COLUMN with a bounded CHECK, not a constant.
-- 0006 adds `tenants.max_reply_age_minutes`. Two ways this goes wrong silently: the
-- migration is in the repo and never applied (the reader falls back to 30 for every
-- tenant, so a configured 120 is quietly ignored), or the bound is missing (a
-- fat-fingered 3000 turns the freshness gate off without an error). Both are invisible
-- to a code review and to the application, which cannot tell "no column" from "no value".
insert into _v select 'V18', 'tenants.max_reply_age_minutes exists, NOT NULL, bounded 1..1440',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'column missing or nullable or wrong default' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenants'
          and column_name='max_reply_age_minutes'
          and is_nullable='NO' and column_default='30')
    union all
    select 'bounding CHECK missing'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.tenants'::regclass
          and conname='reply_age_within_messaging_window')
  ) q;

-- V19 — the comment feature's per-tenant switches exist, and DEFAULT TO OFF.
-- A channel answers comments only when somebody deliberately turned it on. If 0007 were
-- in the repo and not applied, `comment_policy` would be absent, the reader would see
-- undefined, and the positive allow-list in `comments/eligibility.ts` would refuse
-- everything — safe, but silently, so the feature would appear to be broken rather than
-- unconfigured. The mirror failure is worse: a default of anything but 'none' turns the
-- bot loose on every tenant's public wall at once.
insert into _v select 'V19', 'tenant_channels comment switches exist and default to off',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'comment_policy missing, nullable, or not defaulted to none' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenant_channels'
          and column_name='comment_policy'
          and is_nullable='NO' and column_default like '''none''%')
    union all
    select 'comment_max_post_age_days missing or not defaulted to 30'
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenant_channels'
          and column_name='comment_max_post_age_days'
          and is_nullable='NO' and column_default='30')
    union all
    select 'ignore_commenter_ids missing'
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenant_channels'
          and column_name='ignore_commenter_ids' and is_nullable='NO')
    union all
    select 'comment_policy_known CHECK missing'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.tenant_channels'::regclass and conname='comment_policy_known')
    union all
    select 'canned kind comment_public_reply not seeded'
     where not exists (select 1 from canned_response_kinds where kind='comment_public_reply')
  ) q;

-- ---- verdict -------------------------------------------------------------
\pset format aligned
select id, name, case when ok then 'PASS' else 'FAIL' end as result, detail from _v order by id;

do $$
declare n integer;
begin
  select count(*) into n from _v where not ok;
  if n > 0 then
    raise exception 'VERIFICATION FAILED: % check(s) did not pass', n;
  end if;
  raise notice 'VERIFICATION PASSED: all checks green';
end $$;
