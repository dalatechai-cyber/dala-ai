-- 0013 — close the second default-ACL grantor. (Found by running 0001 against the real
-- project on 2026-09-05; CI structurally cannot see this.)
--
-- ## What CI cannot test, and what running it on Supabase showed
--
-- 0001 carries this line, and on a vanilla PostgreSQL it changes nothing at all:
--
--     alter default privileges in schema public revoke all on tables from anon, authenticated;
--
-- A fresh cluster has NO default ACL entries, so tables come out ungranted whether that
-- statement is present, misspelled, or ordered wrong. It is a no-op in CI by construction.
--
-- On a real Supabase project it is the whole defence. The bootstrap seeds default ACLs
-- granting `arwdDxtm` — all EIGHT privileges on PG17, MAINTAIN included — to `anon` and
-- `authenticated` for every future table in `public`. Verified against the live project:
-- the line does bite, `anon` ends with zero privileges on zero tables, and a table created
-- afterwards is born with grants to `postgres` and `service_role` only.
--
-- ## The residual this migration is about
--
-- `ALTER DEFAULT PRIVILEGES` without `FOR ROLE` rewrites the entry belonging to the
-- CURRENT role. There are two grantors on Supabase, and 0001 only ever touched one:
--
--     postgres        → rewritten by 0001; anon and authenticated removed
--     supabase_admin  → UNTOUCHED; still grants anon and authenticated all eight
--
-- It is dormant only because every object we create is created by `postgres`. Anything
-- ever created in `public` by `supabase_admin` — a dashboard-enabled extension that ships
-- tables is the realistic case — would be born granting `anon` everything.
--
-- ## Why this migration tries and does not insist
--
-- `postgres` on Supabase is NOT a superuser and is NOT a member of `supabase_admin`
-- (checked: pg_has_role → false), so the statement below WILL fail there. Raising would
-- block every future migration over a risk that is currently dormant, so it warns instead.
--
-- **The silence that would otherwise create is closed by `catalog.sql` V25**, which asserts
-- the end state from any grantor and fails while the entry survives. `V5` remains the
-- backstop: it catches the condition if it ever stops being latent and an actual table
-- turns up granting anon. A monitor plus an attempt, and neither pretending to be a fix.
--
-- If you want this closed rather than watched, it has to be run by a role that is a member
-- of `supabase_admin` — Supabase support, or the dashboard's SQL editor if it connects as
-- one. The statement is exactly the one below.
--
-- ADDITIVE ONLY. Grants nothing; can only remove.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    -- Vanilla PostgreSQL, i.e. CI. There is no such grantor and nothing to revoke.
    raise notice '0013: no supabase_admin role; nothing to revoke (this is CI or a local cluster)';
    return;
  end if;

  begin
    execute 'alter default privileges for role supabase_admin in schema public '
            'revoke all on tables from anon, authenticated';
    raise notice '0013: revoked supabase_admin default table privileges from anon/authenticated';
  exception when insufficient_privilege then
    raise warning '0013: COULD NOT revoke supabase_admin default privileges (postgres is not a member of supabase_admin). '
                  'catalog.sql V25 will FAIL until this is run by a role that is. This is latent, not live: '
                  'it only matters for objects created in public BY supabase_admin.';
  end;
end $$;
