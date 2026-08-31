-- Behavioural RLS tests, executed AS THE CLIENT ROLES.
--
-- The catalog pack proves the policies exist. This proves they bite, which is not the
-- same claim: a policy on a table with RLS off is created, reads perfectly in
-- pg_policies, and is never evaluated. Nothing here is meaningful as superuser —
-- superusers bypass RLS unconditionally — so every assertion runs under `set role`.
\set ON_ERROR_STOP on

begin;

-- Two tenants, one member who belongs to A only.
insert into tenants (id, slug, display_name, vertical, timezone) values
  ('aaaa0000-0000-0000-0000-00000000000a','rls-a','Тенант А','salon','Asia/Ulaanbaatar'),
  ('bbbb0000-0000-0000-0000-00000000000b','rls-b','Тенант Б','auto_service','Asia/Ulaanbaatar');

insert into tenant_members (tenant_id, user_id) values
  ('aaaa0000-0000-0000-0000-00000000000a','1111f00d-0000-0000-0000-000000000001');

insert into services (tenant_id, name) values
  ('aaaa0000-0000-0000-0000-00000000000a','Үйлчилгээ А'),
  ('bbbb0000-0000-0000-0000-00000000000b','Үйлчилгээ Б');

-- R1 — anon can read nothing. Not "sees zero rows": holds no privilege at all.
do $$
declare n integer;
begin
  set local role anon;
  begin
    select count(*) into n from services;
    reset role;
    raise exception 'R1 FAILED: anon read services and saw % row(s)', n;
  exception when insufficient_privilege then
    reset role;
    raise notice 'R1 PASS: anon holds no privilege on services';
  end;
end $$;

-- R2 — authenticated with no identity sees nothing. The policy, not the grant.
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  select count(*) into n from services;
  reset role;
  if n <> 0 then raise exception 'R2 FAILED: anonymous authenticated saw % row(s)', n; end if;
  raise notice 'R2 PASS: authenticated with no identity sees 0 rows';
end $$;

-- R3 — a member sees their own tenant and ONLY their own tenant. This is the
-- assertion the whole product rests on.
do $$
declare n_a integer; n_b integer; total integer;
begin
  perform set_config('request.jwt.claim.sub', '1111f00d-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into n_a from services where tenant_id = 'aaaa0000-0000-0000-0000-00000000000a';
  select count(*) into n_b from services where tenant_id = 'bbbb0000-0000-0000-0000-00000000000b';
  select count(*) into total from services;
  reset role;
  if n_a <> 1 then raise exception 'R3 FAILED: member saw % of their own rows, expected 1', n_a; end if;
  if n_b <> 0 then raise exception 'R3 FAILED: member saw % row(s) of ANOTHER TENANT', n_b; end if;
  if total <> 1 then raise exception 'R3 FAILED: member saw % rows in total, expected 1', total; end if;
  raise notice 'R3 PASS: member sees 1 own row, 0 cross-tenant rows, 1 total';
end $$;

-- R4 — a member cannot write their own tenant's row either. Ownership RLS checks who
-- a row belongs to, never what it says; the restrictive policy and the absent grant
-- are what stop a client asserting a value.
do $$
begin
  perform set_config('request.jwt.claim.sub', '1111f00d-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    insert into services (tenant_id, name) values ('aaaa0000-0000-0000-0000-00000000000a','Хууль бус');
    reset role;
    raise exception 'R4 FAILED: authenticated inserted into its own tenant';
  exception when insufficient_privilege or check_violation then
    reset role;
    raise notice 'R4 PASS: authenticated INSERT refused';
  end;
end $$;

-- R5 — and cannot update or delete.
do $$
begin
  perform set_config('request.jwt.claim.sub', '1111f00d-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    update services set name = 'Өөрчлөгдсөн';
    reset role;
    raise exception 'R5 FAILED: authenticated updated a row';
  exception when insufficient_privilege or check_violation then
    reset role;
    raise notice 'R5 PASS: authenticated UPDATE refused';
  end;
end $$;

-- R6 — authenticated cannot TRUNCATE. This is the privilege that sits OUTSIDE RLS
-- entirely: no policy and no UPDATE/DELETE trigger stops it, and `revoke insert,
-- update, delete` leaves it behind.
do $$
begin
  perform set_config('request.jwt.claim.sub', '1111f00d-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    truncate services;
    reset role;
    raise exception 'R6 FAILED: authenticated TRUNCATED a tenant table';
  exception when insufficient_privilege then
    reset role;
    raise notice 'R6 PASS: authenticated TRUNCATE refused';
  end;
end $$;

-- R7 — the ledger is unreadable to a client. Spend is ours, not the tenant's, and it
-- is not in ops.tenant_scope, so it never received a read policy or a grant.
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '1111f00d-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    select count(*) into n from spend_ledger;
    reset role;
    raise exception 'R7 FAILED: authenticated read the spend ledger';
  exception when insufficient_privilege then
    reset role;
    raise notice 'R7 PASS: authenticated cannot read spend_ledger';
  end;
end $$;

-- R8 — secrets are unreadable to a client, encrypted or not.
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', '1111f00d-0000-0000-0000-000000000001', true);
  set local role authenticated;
  begin
    select count(*) into n from tenant_secrets;
    reset role;
    raise exception 'R8 FAILED: authenticated read tenant_secrets';
  exception when insufficient_privilege then
    reset role;
    raise notice 'R8 PASS: authenticated cannot read tenant_secrets';
  end;
end $$;

do $$ begin raise notice 'RLS SUITE PASSED'; end $$;

rollback;
