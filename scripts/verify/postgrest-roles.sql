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
-- ## The password is not optional, and finding that out cost a CI run
--
-- The first version created this role with `login` and no password. It worked locally and
-- failed in CI with `fe_sendauth: no password supplied`, because the two connect
-- differently: the local scratch cluster is reached over a unix socket under `trust`, and
-- the CI container is reached over TCP under `scram-sha-256`. The auth method was never
-- part of what local testing exercised, so "it works locally" was true and worthless.
--
-- Reproduced by switching the local `pg_hba.conf` line for 127.0.0.1 to `scram-sha-256`
-- and watching the same message appear, rather than by reading about it.
--
-- `dala-ci-authenticator` is a CI literal for a throwaway cluster that lives for the
-- length of one job. It is not a credential, and nothing outside that job trusts it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'dala-ci-authenticator';
  else
    alter role authenticator login password 'dala-ci-authenticator';
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
