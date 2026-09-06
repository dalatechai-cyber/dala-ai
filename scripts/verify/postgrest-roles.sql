-- LOCAL AND CI ONLY. Never applied to Supabase, and not a migration.
--
-- Supabase provides `authenticator` — the role PostgREST logs in as, which holds no
-- privileges of its own and can only `set role` to `anon`, `authenticated` or
-- `service_role` after a JWT says which. `0001` deliberately does not create it: it is
-- part of the platform Supabase runs, not part of this schema, and a migration that
-- invented a login role would be creating a credential.
--
-- So it lives here, applied only by the PostgREST verification, after the migrations that
-- create the three roles it must be able to become.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
