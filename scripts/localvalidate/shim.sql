-- LOCAL VALIDATION ONLY. Never part of a migration, never applied to Supabase.
--
-- Supabase provides these roles and the auth schema itself. This shim recreates
-- just enough of them that 0001 can be executed against a vanilla PostgreSQL
-- cluster offline, so the migration is verified by running it rather than by
-- being read.
create schema if not exists auth;

create or replace function auth.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
