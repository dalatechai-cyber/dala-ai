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

-- V20 — the erasure request row can say what it is, and cannot lie about being done.
-- 0008 turns 0001's seven-column stub into a row somebody can act on months later. Two
-- silent failures if it is in the repo and not applied: `id_kind` is absent, so nothing
-- records that Meta's callback sends an APP-scoped id while every contact we hold carries
-- a PAGE-scoped one — and a later resolver joins two different namespaces and finds
-- nothing, forever, reporting success. And `erasure_completed_has_evidence` is absent, so
-- a row can be marked `completed` with no `rows_deleted` — "the job said it worked"
-- becoming the only evidence that it did, which is the failure this whole file exists for.
insert into _v select 'V20', 'contact_erasure_requests is identified, unique by code, and cannot claim completion without evidence',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'id_kind column missing' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='contact_erasure_requests' and column_name='id_kind')
    union all
    select 'status missing, nullable, or not defaulted to received'
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='contact_erasure_requests'
          and column_name='status' and is_nullable='NO' and column_default like '''received''%')
    union all
    select 'source missing or nullable'
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='contact_erasure_requests'
          and column_name='source' and is_nullable='NO')
    union all
    -- tenant_id MUST stay nullable: the callback is app-scoped and does not name a tenant.
    -- A NOT NULL here would force a guess on the one path where guessing is least
    -- acceptable, so this checks the absence of a constraint rather than its presence.
    select 'tenant_id is NOT NULL — the callback cannot name a tenant and must not guess one'
     where exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='contact_erasure_requests'
          and column_name='tenant_id' and is_nullable='NO')
    union all
    select 'erasure_callback_is_identified CHECK missing'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.contact_erasure_requests'::regclass
          and conname='erasure_callback_is_identified')
    union all
    select 'erasure_completed_has_evidence CHECK missing'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.contact_erasure_requests'::regclass
          and conname='erasure_completed_has_evidence')
    union all
    select 'confirmation_code is not unique — two people would read one status page'
     where not exists (
       select 1 from pg_indexes
        where schemaname='public' and tablename='contact_erasure_requests'
          and indexname='contact_erasure_requests_code')
    union all
    select 'open-request index missing — a redelivery would mint a second code'
     where not exists (
       select 1 from pg_indexes
        where schemaname='public' and tablename='contact_erasure_requests'
          and indexname='contact_erasure_requests_open')
  ) q;

-- V21 — the per-post daily cap has somewhere to count from, and a bound.
-- 0009 puts the post id on the reply row instead of in a second table (0007's argument:
-- two sources of truth for "did we already reply" disagree the first time a worker dies
-- between them). If the migration is in the repo and not applied, the insert names a
-- column PostgREST does not have and EVERY public reply fails — loudly, which is the
-- tolerable direction. The quiet failure is the missing index: the count query then scans
-- every comment reply the tenant has ever made, and the cap degrades from a 24-hour
-- window into "once per post, forever" without anything saying so.
insert into _v select 'V21', 'the comment post cap has a column, a bound, and a windowed index',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'outbound_messages.comment_post_id missing' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='outbound_messages' and column_name='comment_post_id')
    union all
    select 'comment_replies_per_post_per_day missing, nullable, or not defaulted to 1'
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenant_channels'
          and column_name='comment_replies_per_post_per_day'
          and is_nullable='NO' and column_default='1')
    union all
    select 'comment_post_id_only_on_comment_replies CHECK missing'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.outbound_messages'::regclass
          and conname='comment_post_id_only_on_comment_replies')
    union all
    select 'comment_post_cap_sane CHECK missing'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.tenant_channels'::regclass and conname='comment_post_cap_sane')
    union all
    select 'the windowed index is missing — the cap becomes once per post FOREVER'
     where not exists (
       select 1 from pg_indexes
        where schemaname='public' and tablename='outbound_messages'
          and indexname='outbound_messages_comment_post')
  ) q;

-- V22 — the signed platform Mongolian is IN the database, signed, and unambiguous.
-- 0010 is the wire between `prompt/platform/*.mn.txt` and everything that renders Mongolian.
-- Three ways it goes wrong silently if the migration is in the repo and not applied, or is
-- applied and then edited by hand:
--   * the rows are absent, so `/data-deletion/status` returns 503 forever and the prompt
--     compiler has no L0 to compile — both read as "the feature is broken", not "unseeded";
--   * a row's `reviewed_at` is null, which every reader treats as unreviewed, so the text
--     is present and unreachable;
--   * two rows share a block_key, which reaches `render.ts` as `ambiguous_order` — a
--     non-deterministic prefix, i.e. a cache miss on every request and a prompt that
--     depends on which row sorted first.
insert into _v select 'V22', 'the signed platform blocks are seeded, attributed, and one per key',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'the layer column is missing' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='prompt_blocks' and column_name='layer')
    union all
    select 'prompt_block_layer_matches_scope CHECK missing — a tenant row could claim L0'
     where not exists (
       select 1 from pg_constraint
        where conrelid='public.prompt_blocks'::regclass and conname='prompt_block_layer_matches_scope')
    union all
    select 'the platform block_key unique index is missing'
     where not exists (
       select 1 from pg_indexes
        where schemaname='public' and tablename='prompt_blocks'
          and indexname='prompt_blocks_platform_key')
    union all
    -- `to_jsonb(p) ->> 'layer'` rather than `p.layer`, and that is not style. A bare
    -- column reference does not PARSE when the column is absent, so this check errored
    -- out against a database 0010 had not reached instead of reporting the very absence
    -- it exists to detect — a check that cannot fail cleanly is the same defect as a
    -- guard that under-reads its own source. Found by running it.
    -- The fourteen SHARED gate blocks. Counting rows would have been wrong from 0018: a
    -- per-vertical example block is a real L0 row and there is one per vertical, so the
    -- row count grows with the number of verticals while the gate does not. Restricting
    -- to `vertical is null` keeps the tripwire exact where it matters — a fifteenth
    -- block shared by every tenant is still a failure — without it firing on a design
    -- the platform now supports.
    --
    -- It was thirteen until 2026-09-21, and it fired exactly as intended: `sh11_completeness`
    -- (ordinal 111) is the fourteenth, the first gate block that says what the model MUST
    -- say rather than what it must not, and the suite went red on the commit that seeded it
    -- while `npm test` and every guard stayed green. That is the whole point of a constant
    -- here — a block shared by every tenant of every vertical is a platform-wide change to
    -- what the model is told, and it must cost somebody a deliberate edit to this line.
    -- Do not bump this number to make a red suite green: bump it only having named the new
    -- block, as this comment names Ш11. `to_jsonb` for `vertical` for the same reason as `layer`
    -- directly below: a bare column reference does not parse on a database 0018 has not
    -- reached, and a check that cannot fail cleanly is the defect it exists to detect.
    select 'the fourteen-block boundary gate is not seeded at L0 (found ' ||
           (select count(*) from prompt_blocks p
             where p.scope='platform' and to_jsonb(p) ->> 'layer' = 'L0'
               and to_jsonb(p) ->> 'vertical' is null) || ' shared blocks)'
     where (select count(*) from prompt_blocks p
             where p.scope='platform' and to_jsonb(p) ->> 'layer' = 'L0'
               and to_jsonb(p) ->> 'vertical' is null) <> 14
    union all
    select 'the eight data-deletion status blocks are not seeded (found ' ||
           (select count(*) from prompt_blocks where scope='platform' and block_key like 'data_deletion\_%') || ')'
     where (select count(*) from prompt_blocks
             where scope='platform' and block_key like 'data_deletion\_%') <> 8
    union all
    select 'the comment_public_reply template is not seeded'
     where not exists (
       select 1 from prompt_blocks where scope='platform' and block_key='comment_public_reply')
    union all
    select 'a platform block has no sign-off — every reader treats that as unreviewed'
     where exists (
       select 1 from prompt_blocks
        where scope='platform' and (reviewed_at is null or coalesce(reviewed_by, '') = ''))
  ) q;

-- V23 — a seeded row cannot pass for a fact. (D-020, migration 0011.)
--
-- The column is only half the rule; the half that survives somebody in a hurry is that
-- there is NO DEFAULT, so an INSERT that does not say where the row came from is refused
-- by the database rather than quietly credited. Three ways that erodes, all invisible:
--
--   * the column is absent — every reader then sees `undefined`, treats it as unconfirmed,
--     and the knowledge base empties itself into the handoff line;
--   * a default gets added later "to make seeding easier", which is the original bug
--     rebuilt: `tenant_confirmed` blesses every placeholder, `seeded` mislabels real data;
--   * the CHECK is missing, so `provenance = 'probably_fine'` stores happily and reads as
--     not-confirmed forever — the row is dead and nothing says so.
--
-- `is_nullable`/`column_default` come from information_schema.columns, which is safe here:
-- it is not permission-filtered the way role_table_grants is, and it is queried per column
-- rather than trusted to be complete.
insert into _v select 'V23', 'provenance is present, undefaulted, NOT NULL and constrained on all five tables',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select t || ': the provenance column is missing' as problem
      from unnest(array['service_aliases','deterministic_replies','out_of_scope_topics','faqs','disclosure_rules']) as t
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name=t and column_name='provenance')
    union all
    select t || ': provenance is nullable — an unlabelled row would be accepted'
      from unnest(array['service_aliases','deterministic_replies','out_of_scope_topics','faqs','disclosure_rules']) as t
     where exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name=t and column_name='provenance' and is_nullable='YES')
    union all
    select t || ': provenance HAS A DEFAULT — that is the bug this column exists to prevent'
      from unnest(array['service_aliases','deterministic_replies','out_of_scope_topics','faqs','disclosure_rules']) as t
     where exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name=t and column_name='provenance'
          and column_default is not null)
    union all
    select t || ': the ' || t || '_provenance_known CHECK is missing'
      from unnest(array['service_aliases','deterministic_replies','out_of_scope_topics','faqs','disclosure_rules']) as t
     where to_regclass('public.' || t) is not null
       and not exists (
         select 1 from pg_constraint
          where conrelid = ('public.' || t)::regclass and conname = t || '_provenance_known')
  ) q;

-- V31 — and it can say when it started EXPECTING traffic, in any mode. (0023.)
--
-- `went_live_at` answers "when did this start answering customers"; this answers "when did
-- this start expecting webhooks", and they are different questions. A channel in `shadow`
-- has no go-live time by definition, so measuring silence from `went_live_at` made every
-- mirroring channel unmeasurable — and unmeasurable means unalerted, on the one channel
-- watching a third party's real customers.
--
-- Same two triggers as V24 and for the same reason: the INSERT one is not redundant, and
-- Matrix is the proof — Stage 1 created its row directly at `shadow_routing`, so an
-- UPDATE-only trigger would never have fired for it at all.
insert into _v select 'V31', 'tenant_channels.expects_traffic_since exists and is stamped on insert and on update',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'the expects_traffic_since column is missing' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenant_channels' and column_name='expects_traffic_since')
    union all
    select 'ops.mode_expects_traffic() is missing — the mode set would be duplicated per caller'
     where not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='ops' and p.proname='mode_expects_traffic')
    union all
    select 'the UPDATE trigger is missing — a cutover into shadow would not stamp'
     where not exists (
       select 1 from pg_trigger where tgrelid='public.tenant_channels'::regclass
         and tgname='tenant_channels_stamp_expects_traffic' and not tgisinternal)
    union all
    select 'the INSERT trigger is missing — a channel created at shadow_routing would never stamp'
     where not exists (
       select 1 from pg_trigger where tgrelid='public.tenant_channels'::regclass
         and tgname='tenant_channels_stamp_expects_traffic_insert' and not tgisinternal)
    union all
    -- The set itself, asserted rather than assumed. `off` being in it would put every
    -- decommissioned channel back under the watchdog.
    select 'ops.mode_expects_traffic disagrees with the documented set'
     where not (ops.mode_expects_traffic('shadow_routing') and ops.mode_expects_traffic('shadow')
                and ops.mode_expects_traffic('live') and not ops.mode_expects_traffic('off'))
  ) q;

-- V32 — the column a tenant's DAILY CEILING is keyed on cannot be absent. (D-053.)
--
-- `dayKey(now, tenants.timezone)` decides which day's counter a reply is charged to. A
-- null or empty zone there is not a cosmetic gap: it is a reply charged to a day nobody
-- can name, or — before the code refused it — to whatever the fallback said, silently.
--
-- The worker refuses on a missing zone, which makes this check the reason that refusal is
-- unreachable rather than a second opinion about it. If the NOT NULL ever comes off, the
-- refusal starts firing in production and this says so first.
insert into _v select 'V32', 'tenants.timezone is NOT NULL — the spend day key is derived from it',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'tenants.timezone is missing' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenants' and column_name='timezone')
    union all
    select 'tenants.timezone is nullable — a tenant with no calendar would reach the ledger'
     where exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenants' and column_name='timezone'
          and is_nullable = 'YES')
  ) q;

-- V33 — the snapshot can say which canned lines its prefix contains. (D-058, 0024.)
--
-- Since the canned section moved into `prompt_stable`, the same sentence has two sources:
-- this snapshot, which the model reads, and `canned_responses`, which the deterministic
-- short-circuit answers from. `canned_hash` is what lets a request notice they have
-- diverged and refuse, instead of answering one customer from each.
--
-- The column MUST STAY NULLABLE, and that is the interesting half of this check. Null is
-- the marker for a prefix compiled before the move, and the reply path answers it by
-- appending the section to the volatile tail as it always did. A NOT NULL here would be a
-- claim that every published prefix contains the section — false for every row written
-- before 0024, and unfixable, because `config_snapshots` is append-only by a trigger that
-- binds `service_role` too. There is no UPDATE that could make the claim true.
insert into _v select 'V33', 'config_snapshots.canned_hash exists and is nullable — null means the prefix predates D-058',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'config_snapshots.canned_hash is missing — a stale canned line could not be detected' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='config_snapshots' and column_name='canned_hash')
    union all
    select 'config_snapshots.canned_hash is NOT NULL — pre-D-058 snapshots cannot state a hash they do not have'
     where exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='config_snapshots' and column_name='canned_hash'
          and is_nullable = 'NO')
    union all
    -- Append-only is what makes the null honest rather than a gap somebody will "fix" with
    -- an UPDATE. Asserted here so the two facts stay tied together.
    select 'config_snapshots is no longer append-only — a backfilled canned_hash would misdescribe an old prefix'
     where not exists (
       select 1 from pg_trigger where tgrelid='public.config_snapshots'::regclass
         and not tgisinternal and tgenabled = 'A')
  ) q;

-- V34 — an alert can say where it goes and whether it may speak again. (D-063, 0025.)
--
-- The measurement this exists for: on 2026-09-14 `alerts` held eleven rows and ten were one
-- condition, critical, once a morning for six days, because the dedup key carried the local
-- date. The columns below are what replaced the date, so their ABSENCE is not cosmetic —
-- `raiseAlert` writes `route` and `repeat_policy` on every insert, and against a database
-- without them PostgREST answers the insert with a 400 and every alert in the platform is
-- lost silently. That is the D-058 deploy-order trap exactly, and this check is what makes
-- it visible here rather than in production.
--
-- The DEFAULTS are asserted, not just the columns. They are the whole reason the rollout
-- needs no coordination: 'now' and 'daily' reproduce what every existing call site already
-- did, so a row written by code that has not been redeployed behaves as it always has.
--
-- `resolved_at` and `notified_at` must stay NULLABLE. Null on `resolved_at` is what "this
-- episode is still open" MEANS — it is the digest's whole input and what `on_change`
-- suppresses against — and null on `notified_at` means nobody has been paged about the row
-- yet, which the three-day sweep reads through `coalesce(notified_at, at)`. A NOT NULL on
-- either would be a claim the data cannot make.
insert into _v select 'V34', 'alerts carries route/repeat_policy with today''s behaviour as the default, and resolved_at/notified_at stay nullable',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select format('alerts.%s is missing — raiseAlert writes it, so every alert would 400', c) as problem
      from unnest(array['route','repeat_policy','resolved_at','notified_at']) as c
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='alerts' and column_name=c)
    union all
    select format('alerts.%s is nullable or has the wrong default — an un-redeployed caller would change behaviour', c)
      from (values ('route','''now''::text'), ('repeat_policy','''daily''::text')) as d(c, want)
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='alerts' and column_name=d.c
          and is_nullable = 'NO' and column_default = d.want)
    union all
    select format('alerts.%s is NOT NULL — null is what "still open" and "never paged" mean', c)
      from unnest(array['resolved_at','notified_at']) as c
     where exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='alerts' and column_name=c
          and is_nullable = 'NO')
    union all
    select format('the %s CHECK is missing — an unknown value would be accepted and then never matched', n)
      from unnest(array['alerts_route_known','alerts_repeat_policy_known']) as n
     where not exists (select 1 from pg_constraint where conname = n)
  ) q;

-- V24 — the channel can say when it started expecting traffic. (0012.)
--
-- `went_live_at` is what the silence watchdog measures from when a channel has NEVER
-- received a webhook — the failure §5 item 15 names, where a page-level subscribe returns
-- {"success": true} and no events are ever delivered. Without the column that case is
-- unmeasurable, and unmeasurable means unalerted.
--
-- The TRIGGERS are the check that matters, not the column. `delivery_mode` is moved by an
-- operator typing SQL; a timestamp that has to be set by hand alongside it gets forgotten
-- exactly once, and the watchdog then says nothing about a channel that has never worked.
-- Both triggers are required: the UPDATE one for a normal cutover, the INSERT one for a
-- channel created directly at 'live', which never sees an UPDATE at all.
insert into _v select 'V24', 'tenant_channels.went_live_at exists and is stamped by trigger, on insert and on update',
  coalesce(string_agg(problem, '; '), 'correct'), count(*) = 0
  from (
    select 'the went_live_at column is missing' as problem
     where not exists (
       select 1 from information_schema.columns
        where table_schema='public' and table_name='tenant_channels' and column_name='went_live_at')
    union all
    select 'ops.stamp_went_live() is missing — the column would have to be set by hand'
     where not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='ops' and p.proname='stamp_went_live')
    union all
    select 'the UPDATE trigger is missing — a normal cutover would not stamp'
     where not exists (
       select 1 from pg_trigger
        where tgrelid='public.tenant_channels'::regclass
          and tgname='tenant_channels_stamp_went_live' and not tgisinternal)
    union all
    select 'the INSERT trigger is missing — a channel created at live would never stamp'
     where not exists (
       select 1 from pg_trigger
        where tgrelid='public.tenant_channels'::regclass
          and tgname='tenant_channels_stamp_went_live_insert' and not tgisinternal)
  ) q;

-- V25 — no default ACL grants anon or authenticated on FUTURE tables in public,
-- from ANY grantor. (0013. Found by running 0001 against a real Supabase project.)
--
-- 0001's `alter default privileges in schema public revoke all on tables from anon,
-- authenticated` is a NO-OP on a vanilla cluster: there are no default ACL entries, so
-- tables come out ungranted whether the statement is right, wrong or absent. This check is
-- therefore near-vacuous in CI and load-bearing in production — which is exactly the shape
-- of the gap that made the Supabase project worth paying for.
--
-- It reads every grantor, not just the current role, because `ALTER DEFAULT PRIVILEGES`
-- without `FOR ROLE` rewrites only the current one. Supabase seeds TWO: `postgres` (which
-- 0001 fixes) and `supabase_admin` (which it cannot reach — see 0013). A table created in
-- public by supabase_admin would be born granting anon all eight privileges.
--
-- V5 is the backstop for the condition going live; this is the early warning while it is
-- still latent. `aclexplode` over `defaclacl` decomposes whatever privilege bits are
-- present, so MAINTAIN is covered on 17 without naming it.
insert into _v select 'V25', 'no default ACL grants anon/authenticated on future public tables',
  coalesce(string_agg(distinct pg_get_userbyid(d.defaclrole) || ' grants ' ||
                               a.grantee::regrole::text || ':' || a.privilege_type, ', '),
           'none from any grantor'),
  count(*) = 0
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
 where n.nspname = 'public' and d.defaclobjtype = 'r'
   and a.grantee::regrole::text in ('anon','authenticated');

-- V26 — EVERY function in `app` and `ops` pins search_path, not just the definers.
--
-- V11 covers SECURITY DEFINER, and its reasoning is specific to that case. This is the
-- wider one, and it exists because the narrower check passed 25/25 while four `ops` trigger
-- functions sat unpinned — including two written the day before. Supabase's own linter
-- found them; CI had no opinion, because nothing here asked the question.
--
-- The exploit against an invoker function is thin. The reason for the check is that every
-- `app.*` function already pins (including the two non-definers), so `ops` was the
-- inconsistent one — and that a linter carrying four permanent WARNs is a linter nobody
-- reads by the time a fifth one means something.
insert into _v select 'V26', 'every app/ops function pins search_path, definer or not',
  coalesce(string_agg(n.nspname || '.' || p.proname, ', '), 'all pinned'), count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('app','ops')
   and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) cfg where cfg like 'search_path=%');

-- V27 — the two RPCs the runtime calls exist on the schema PostgREST serves, and are
-- callable by NOBODY except service_role. (0015. Found in production 2026-09-06.)
--
-- `supabase/clients.ts` builds every client on the default `public` profile, so
-- `db.rpc('reserve_spend')` asks PostgREST for `public.reserve_spend`. That function did
-- not exist — the originals live in `app` — and every reply refused with
-- `guard_unavailable` from the first message that ever reached the worker. No unit test
-- could see it: the worker's stub answers `db.rpc` with `true`.
--
-- The second half of the check is the more dangerous one. A function in `public` is
-- REST-reachable, and PostgreSQL grants EXECUTE to PUBLIC on every new function. An
-- unrevoked wrapper lets an unauthenticated caller POST to /rest/v1/rpc/reserve_spend and
-- drive any tenant's daily counter to its ceiling — silencing that tenant until midnight.
-- So this asserts the grant, not just the existence.
insert into _v select 'V27', 'public spend RPCs exist and only service_role may execute',
  coalesce(string_agg(detail, '; ' order by detail), 'both present, service_role only'),
  count(*) = 0
  from (
    select 'missing: public.' || want as detail
      from (values ('reserve_spend'), ('settle_spend')) as w(want)
     where not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = w.want)
    union all
    select 'executable by ' || a.grantee::regrole::text || ': ' || n.nspname || '.' || p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.proname in ('reserve_spend','settle_spend')
       and n.nspname in ('public','app')
       and a.privilege_type = 'EXECUTE'
       and a.grantee::regrole::text in ('anon','authenticated','public','-')
  ) bad;

-- V28 — `channel_health` can tell a provisioning gap from an outage (0017, D-032).
--
-- The watchdog's five verdicts used to reach this table as one boolean plus prose, so the
-- first query anyone writes against it — "how many channels are unhealthy?" — would have
-- counted a tenant whose opening hours are not entered yet as an outage. That is the same
-- conflation D-032 removed from the alert, waiting one layer down for a dashboard.
--
-- The second half asserts the constraint, not just the column. `healthy` and `state` are
-- two spellings of one fact and the CHECK is what stops them drifting; a column present
-- with the constraint missing is the state where a future writer can put `healthy = true`
-- next to `state = 'no_webhooks'` and nothing objects.
insert into _v select 'V28', 'channel_health.state exists and cannot disagree with healthy',
  coalesce(string_agg(detail, '; ' order by detail), 'column present, tied to healthy'),
  count(*) = 0
  from (
    select 'missing column: channel_health.state' as detail
     where not exists (
       select 1 from pg_attribute a
        where a.attrelid = 'channel_health'::regclass and a.attname = 'state'
          and a.attnum > 0 and not a.attisdropped)
    union all
    select 'missing constraint: channel_health_state_matches_healthy'
     where not exists (
       select 1 from pg_constraint c
        where c.conrelid = 'channel_health'::regclass and c.contype = 'c'
          and c.conname = 'channel_health_state_matches_healthy')
  ) bad;

-- V29 — every vertical a tenant actually has is covered by every per-vertical block (0018).
--
-- The gate blocks are shared, and five of them are written in salon language. `0018` lets
-- the worked examples be per-vertical instead — D-011's finding is that hardening works by
-- naming the forbidden wrong answer, so the examples must stay concrete, and a salon's
-- wrong answer is not a garage's.
--
-- The hole that opens with them is silent: onboard a tenant in a vertical nobody has
-- written examples for, and its prompt loses those blocks entirely. Nothing throws, the
-- compile succeeds, and the gate is one example weaker for that tenant alone — which is
-- the shape of defect this repository keeps finding after it has cost something.
--
-- This asks the question rows can answer: for each vertical some tenant HAS, and each
-- block that is per-vertical AT ALL, is there a row? It is vacuously green until the first
-- per-vertical block exists, and it goes red on the day a vertical is onboarded without
-- one — not on the day somebody remembers to look.
insert into _v select 'V29', 'every tenant vertical has every per-vertical platform block',
  coalesce(string_agg(detail, '; ' order by detail), 'no per-vertical blocks, or all verticals covered'),
  count(*) = 0
  from (
    select 'no ' || pv.block_key || ' for vertical ' || t.vertical as detail
      from (select distinct vertical from tenants where vertical is not null and vertical <> '') t
      cross join (
        select distinct block_key from prompt_blocks
         where scope = 'platform' and vertical is not null and vertical <> ''
      ) pv
     where not exists (
       select 1 from prompt_blocks b
        where b.scope = 'platform' and b.block_key = pv.block_key and b.vertical = t.vertical)
  ) bad;

-- V30 — `staff_members.short_name` exists, and every column the prompt loader reads with
-- it (0019, D-038).
--
-- The column half is the obvious assertion. The rest of the list is the point: this is the
-- exact select `loadTenantKb` issues, and a select naming a column that is not there fails
-- the WHOLE publish for that tenant — thirteen reads, one error, `staff_members
-- unreadable`, and no new revision. So the deployment order matters (migration first, code
-- second) and this is where a database that is behind the code says so.
--
-- `scripts/verify/postgrest.ts` asks the same question through the REST profile, which is
-- the transport the runtime actually uses. Both are worth having: this one runs against
-- any psql-reachable database including the real project, that one proves the column is
-- reachable as well as present.
insert into _v select 'V30', 'staff_members carries every column the prompt loader selects',
  coalesce(string_agg('missing column: staff_members.' || c, ', ' order by c), 'all present'),
  count(*) = 0
  from (
    select c from unnest(array['name','short_name','group_name','tier','active','tenant_id']) as c
     where not exists (
       select 1 from pg_attribute a
        where a.attrelid = 'staff_members'::regclass and a.attname = c
          and a.attnum > 0 and not a.attisdropped)
  ) bad;

-- V35 — every public table is READABLE BY service_role. (D-085.)
--
-- The allow side, and nothing else in this file checks it. V5 asserts `anon` holds no
-- privilege and V6 that `authenticated` holds only SELECT — both are the DENY side, and a
-- table nobody can read at all passes both of them perfectly.
--
-- It matters because `0001:1636` is `grant all on all tables in schema public to
-- service_role`, executed ONCE over the tables that existed then. A table created by a
-- later migration inherits nothing, and PostgREST exposes a relation only where the role
-- holds a privilege on it — so the symptom is not a permission error. The table is simply
-- absent from the schema cache and every `.from()` against it 404s at runtime while every
-- SQL suite here stays green.
--
-- `comment_rules` shipped exactly that way in `0030` and CI's PostgREST reachability check
-- (D-037) is what caught it. This is the same assertion one layer earlier, where it costs
-- seconds instead of a CI cycle.
insert into _v select 'V35', 'every public table is readable by service_role',
  coalesce(string_agg(c.relname, ', ' order by c.relname), 'all readable'), count(*) = 0
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and not has_table_privilege('service_role', c.oid, 'select');

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
