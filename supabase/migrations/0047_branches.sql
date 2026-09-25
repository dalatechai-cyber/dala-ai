-- A tenant with more than one location (D-122).
--
-- Matrix is becoming Tara Salon and a second branch is coming, with its own address, map
-- link and possibly its own phone, hours and prices. Until now a tenant was ONE place:
-- `contact_points` is keyed `(tenant_id, kind)`, so it holds exactly one address and one map
-- link, and `business_hours` / `service_variants` hold one week and one price per variant.
--
-- ## Additive, and a tenant with fewer than two branches does not change by one byte
--
-- Four new tables and one lookup row. No existing table, column, constraint or row is
-- touched, so every row already in `contact_points`, `business_hours` and `service_variants`
-- keeps meaning what it means today: the tenant-wide fact, the same at every location.
--
-- The new tables hold only what DIFFERS by branch. A branch row overrides the tenant-wide row
-- of the same kind / weekday / variant for that branch alone; where a branch has no row, the
-- tenant-wide row applies to it. The compiler (`prompt/tenant.ts`) splits the facts into the
-- ones every branch shares and the ones that differ, and it does so ONLY when the tenant has
-- at least TWO active, confirmed branches. With zero or one, these tables are not rendered at
-- all and the compiled prefix is byte-for-byte what it was — which is the whole point, because
-- Matrix is live and has no branch rows.
--
-- ## Why new tables and not a `branch_id` column on the old ones
--
-- `contact_points`' primary key is `(tenant_id, kind)`. Admitting a second address means
-- replacing that key, and a primary-key change on a live table is not additive. A side table
-- keyed `(tenant_id, branch_id, kind)` holds the same fact with no change to anything that
-- exists. The same argument applies to `business_hours` (`(tenant_id, weekday)`) and to
-- `service_variants` (`unique (tenant_id, service_id, variant_key)`).
--
-- ## The checklist every table created after 0001 must do by hand (see 0030)
--
--   1-2. RLS enabled AND forced                     — catalog V2, V3
--   3.   three per-command restrictive deny-write policies, never one `for all` — V17
--   4.   `ops.tenant_scope`                           — V7, V8
--   5.   `ops.table_security_class`. These are CONFIG, the same class as `contact_points`,
--        `business_hours` and `service_variants`, which 0001 marks client-readable — so they
--        are too, with the member-read policy and the SELECT grant that goes with it (V15, V16)
--   6.   `grant all … to service_role`, or PostgREST cannot see the table at all (V35)
--
-- ## Deploy order
--
-- `prompt/sections.ts` (the PUBLISH path) reads these tables, so a publish run against a
-- project where this migration is not pushed refuses with `tenant_branches unreadable` —
-- loudly, and without writing anything. The REPLY path reads them only when the live
-- snapshot already carries a branch list, which a publish can only produce after the push,
-- so pushing late cannot take a live tenant down.

create table tenant_branches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- What the salon calls the branch and what a customer reads: «Яармаг салбар». It is the
  -- heading of the branch's sections in the compiled prefix, so it may not carry a line
  -- break or the `===` that delimits a section — nor surrounding spaces, because the reply
  -- path reads the name back out of the prefix trimmed, and a heading it cannot find is a
  -- branch whose facts it silently cannot see.
  name        text not null
                check (name is normalized)
                check (length(btrim(name)) > 0 and name = btrim(name))
                check (strpos(name, E'\n') = 0 and strpos(name, E'\r') = 0 and strpos(name, '===') = 0),
  -- How customers write the branch's name, in either script: {'яармаг','yarmag'}. Matched
  -- as token prefixes (`mn/match.ts`), so «яармаг» also reaches «Яармагийн». A stem shorter
  -- than four letters, or one two branches share, is not used — it cannot say WHICH branch.
  -- Tokens of `name` that are unique to this branch are used as well, so a stem list is
  -- needed only for Latin spellings and abbreviations.
  stems       text[] not null default '{}'
                check (array_to_string(stems, ' ') is normalized),
  -- The order branches are listed in, to the model and to the operator.
  ordinal     integer not null default 0,
  active      boolean not null default true,
  -- D-020. No default. A branch is a set of facts told to customers, so only a
  -- `tenant_confirmed` branch is compiled; a `seeded` or `inferred` one is reported and
  -- left out, which with fewer than two confirmed branches means today's single-location
  -- prefix.
  provenance  text not null check (provenance in ('tenant_confirmed', 'seeded', 'inferred')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

comment on table tenant_branches is
  'A tenant''s locations. Compiled only when two or more are active and tenant_confirmed; '
  'otherwise the tenant-wide rows are the whole story, exactly as before 0047. D-122.';

-- A branch's own contact point, where it differs from the tenant-wide `contact_points` row.
-- Same `kind` vocabulary as `contact_points`, deliberately: the renderer labels both with
-- one table (`CONTACT_KIND_LABELS`), so «Хаяг» still means an address and nothing else.
create table branch_contact_points (
  tenant_id  uuid not null,
  branch_id  uuid not null,
  kind       text not null check (kind in ('phone','email','address','maps_url','facebook','instagram','website')),
  value      text not null check (value is normalized) check (length(btrim(value)) > 0),
  primary key (tenant_id, branch_id, kind),
  foreign key (tenant_id, branch_id) references tenant_branches (tenant_id, id) on delete cascade
);

comment on table branch_contact_points is
  'A branch''s contact point where it differs from contact_points. D-122.';

-- A branch's opening hours for one weekday, where they differ from `business_hours`.
-- `weekday` is Postgres `dow` (0 = Sunday), exactly as `business_hours` holds it.
create table branch_hours (
  tenant_id  uuid not null,
  branch_id  uuid not null,
  weekday    smallint not null check (weekday between 0 and 6),
  opens      time,
  closes     time,
  closed     boolean not null default false,
  primary key (tenant_id, branch_id, weekday),
  foreign key (tenant_id, branch_id) references tenant_branches (tenant_id, id) on delete cascade,
  constraint branch_open_days_have_hours check (closed or (opens is not null and closes is not null))
);

comment on table branch_hours is
  'A branch''s hours for one weekday where they differ from business_hours. D-122.';

-- A branch's price for one variant, where it differs from `service_variants`.
--
-- The same kind vocabulary and the same number rules as `service_variants`, minus `none`:
-- `none` means "we do not state this price, see this refusal", and a branch that does not
-- offer a service at all is a different fact this migration does not model. A row whose
-- `confirmed_at` is null is NOT shown at the branch's price and NOT replaced by the
-- tenant-wide price either — the compiler renders the service's name with no figure for
-- that branch, because the tenant-wide price is exactly the number the row says is wrong.
create table branch_variant_prices (
  tenant_id     uuid not null,
  branch_id     uuid not null,
  variant_id    uuid not null,
  price_kind    text not null check (price_kind in ('exact','range','from','on_inspection')),
  price_min     numeric(12,2),
  price_max     numeric(12,2),
  confirmed_at  timestamptz,
  primary key (tenant_id, branch_id, variant_id),
  foreign key (tenant_id, branch_id)  references tenant_branches (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id) references service_variants (tenant_id, id) on delete cascade,
  constraint branch_exact_has_one_number  check (price_kind <> 'exact' or (price_min is not null and price_max is null)),
  constraint branch_range_has_two_numbers check (price_kind <> 'range' or (price_min is not null and price_max is not null and price_max >= price_min)),
  constraint branch_from_has_a_floor      check (price_kind <> 'from'  or (price_min is not null and price_max is null)),
  constraint branch_unpriced_carries_no_number
    check (price_kind <> 'on_inspection' or (price_min is null and price_max is null))
);

comment on table branch_variant_prices is
  'A branch''s price for one service variant where it differs from service_variants. D-122.';

-- The canned kind the platform serves when a reply depends on a branch the customer has not
-- named. Registered with NO tenant row: the sentence is customer-visible Mongolian and waits
-- for the founder (prompt/drafts/branch_clarify.mn.txt). Until a reviewed row exists the
-- reply path serves the tenant's handoff line instead — never a guessed branch.
insert into canned_response_kinds (kind, description)
values ('clarify_branch',
        'Asks which branch the customer means, when the answer differs by branch and they have not said. D-122.')
on conflict (kind) do nothing;

-- 1 and 2.
alter table tenant_branches        enable row level security;
alter table tenant_branches        force row level security;
alter table branch_contact_points  enable row level security;
alter table branch_contact_points  force row level security;
alter table branch_hours           enable row level security;
alter table branch_hours           force row level security;
alter table branch_variant_prices  enable row level security;
alter table branch_variant_prices  force row level security;

-- 3. Three restrictive policies per table, one per write command.
do $$
declare t text;
begin
  foreach t in array array['tenant_branches','branch_contact_points','branch_hours','branch_variant_prices']
  loop
    execute format(
      'create policy %I on public.%I as restrictive for insert to anon, authenticated with check (false)',
      t || '_no_client_insert', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to anon, authenticated using (false) with check (false)',
      t || '_no_client_update', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to anon, authenticated using (false)',
      t || '_no_client_delete', t);
    -- The dormant tenant-owner read, as 0001 gives every client-readable config table.
    execute format(
      'create policy %I on public.%I as permissive for select to authenticated using (tenant_id in (select app.current_tenant_ids()))',
      t || '_member_read', t);
  end loop;
end $$;

-- 4.
insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'tenant_branches', 'tenant_id'),
       ('public', 'branch_contact_points', 'tenant_id'),
       ('public', 'branch_hours', 'tenant_id'),
       ('public', 'branch_variant_prices', 'tenant_id');

-- 5. Server-written config, readable by the tenant's own members when that login exists —
--    the same answer 0001 gives `contact_points`, `business_hours` and `service_variants`.
insert into ops.table_security_class (table_schema, table_name, class, client_readable, note)
values
  ('public', 'tenant_branches', 'server_owned', true, 'a tenant''s locations'),
  ('public', 'branch_contact_points', 'server_owned', true, 'per-branch contact points'),
  ('public', 'branch_hours', 'server_owned', true, 'per-branch opening hours'),
  ('public', 'branch_variant_prices', 'server_owned', true, 'per-branch prices');

-- Grants: nothing for anon, SELECT only for authenticated (the member-read above), and
-- everything for the runtime.
revoke all on tenant_branches, branch_contact_points, branch_hours, branch_variant_prices from anon, authenticated;
grant select on tenant_branches, branch_contact_points, branch_hours, branch_variant_prices to authenticated;
-- 6.
grant all on tenant_branches, branch_contact_points, branch_hours, branch_variant_prices to service_role;
