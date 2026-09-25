-- Both bots become salespeople — as rows, and in shadow only (D-127).
--
-- Founder, 2026-09-26: *"Every chat should end with a next step, without being pushy.
-- DalaTech: offer the demo, or ask for name and phone number. Tara: offer booking (link and
-- deposit), or ask for a phone number so the salon can call back. Suggest one related service
-- where it fits. Propose all new Mongolian wording for my approval, test on real traffic in
-- shadow, and show me before anything goes live."*
--
-- ## Three tables, and none of them changes a reply
--
-- `sales_playbooks`   — one row per tenant: whether the instrument runs, and where a lead
--                       would go. `mode` admits `off` and `shadow` ONLY. There is no `live`:
--                       nothing reads these rows to send anything, and the migration that
--                       builds sending adds the value. A CHECK is the strongest "not yet"
--                       available — a live mode cannot be switched on by an UPDATE.
-- `sales_next_steps`  — the tenant's next-step rows (`demo`, `booking`, `callback`), the
--                       related-service line and the lead acknowledgement. The body is
--                       customer-visible Mongolian and is NULL until the founder has chosen
--                       it (prompt/drafts/sales_next_step_*.mn.txt); `reviewed_at` requires a
--                       body. The shadow records each row's state, so the report says which
--                       sentences are still owed.
-- `service_pairings`  — which listed service suggests which other one. Names, matched against
--                       the compiled price list at use, so a pairing whose service is renamed
--                       or delisted simply never fires.
--
-- ## Why not `canned_responses`
--
-- Every reviewed `canned_responses` row is compiled into the cached prefix (D-058) and hashed
-- into `canned_hash`. A next-step row there would (1) put a sales sentence in the model's
-- context with no instruction attached — D-082: *"an offer, not an instruction"* — and (2)
-- move `canned_hash`, so every reply 503s with `canned_stale` until a republish. A table of
-- its own touches neither.
--
-- ## The reply path does not read these tables
--
-- Only `sales/shadow.ts` does, AFTER a reply is drafted, best-effort, in its own queries —
-- never in `loadReceptionContext`. So pushing this migration late cannot fail a reply
-- (CLAUDE.md, D-058's addendum: a column in an unpushed migration is red in production).
-- Before the push the shadow's reads fail, it logs `sales_shadow_unusable`, and nothing else
-- happens.
--
-- ## The checklist every table created after 0001 must do by hand (see 0030, 0047)
--
--   1-2. RLS enabled AND forced                     — catalog V2, V3
--   3.   three per-command restrictive deny-write policies — V17
--   4.   `ops.tenant_scope`                           — V7, V8
--   5.   `ops.table_security_class`: server-owned config, member-readable like
--        `contact_points` (V15, V16)
--   6.   `grant all … to service_role` (V35)

create table sales_playbooks (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  -- `off`: nothing computed, nothing recorded. `shadow`: every reply is classified and one
  -- `quality_flags` row (two with a lead) is written. No third value — see the header.
  mode        text not null default 'off' check (mode in ('off', 'shadow')),
  -- Where a captured lead WOULD go. Recorded on each shadow lead row; nothing sends to it.
  --   founder_telegram — the platform's alert chat (DalaTech's own leads)
  --   tenant_telegram  — a chat the tenant's staff read (the recommendation for Tara)
  --   page_label       — a Page inbox label via Graph `custom_labels`
  lead_route  text not null check (lead_route in ('founder_telegram', 'tenant_telegram', 'page_label')),
  updated_at  timestamptz not null default now()
);

comment on table sales_playbooks is
  'Per-tenant switch for the sales next-step shadow and where a lead would go. No live mode exists. D-127.';

create table sales_next_steps (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  kind            text not null check (kind in ('demo', 'booking', 'callback', 'related_service', 'lead_thanks')),
  -- Customer-visible Mongolian. NULL until chosen: the kind can be configured and shadowed
  -- before its words exist. `related_service` carries one slot, {related}, filled with the
  -- related service's name exactly as the price list writes it, inside «».
  body            text check (body is normalized) check (body is null or length(btrim(body)) > 0),
  reviewed_at     timestamptz,
  -- The link the step offers, when it offers one. How a reply that already carries the step
  -- is recognised (the booking URL, the demo URL), before any body is written.
  link            text check (link is null or link ~ '^https://[^[:space:]]+$'),
  -- Lower first. Among steps whose intent words fire on the customer's message, the lowest
  -- wins; with none firing, the default step is offered.
  priority        smallint not null default 100,
  is_default      boolean not null default false,
  -- The gate's own matcher language (`gate/match.ts` `parseMatcher`), the same jsonb shape
  -- `out_of_scope_topics` and `comment_rules` carry — one matcher, or an ARRAY of matchers of
  -- which any firing counts. NULL: this step has no intent words.
  intent_matcher  jsonb,
  enabled         boolean not null default true,
  primary key (tenant_id, kind),
  constraint sales_step_reviewed_has_body check (reviewed_at is null or body is not null),
  constraint sales_step_default_is_offerable check (not is_default or kind in ('demo', 'booking', 'callback')),
  constraint sales_step_related_has_slot check (kind <> 'related_service' or body is null or strpos(body, '{related}') > 0)
);

-- One default per tenant. Two would make "which step" depend on row order.
create unique index sales_next_steps_one_default on sales_next_steps (tenant_id) where is_default;

comment on table sales_next_steps is
  'A tenant''s next-step rows. Bodies are founder-gated Mongolian; nothing sends them yet. D-127.';

create table service_pairings (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  -- Both as the compiled price list writes them («Эрэгтэй тайралт», «Сахал засах»).
  service_name  text not null check (service_name is normalized) check (length(btrim(service_name)) > 0),
  related_name  text not null check (related_name is normalized) check (length(btrim(related_name)) > 0),
  enabled       boolean not null default true,
  -- D-020. A pairing proposed by the platform is `seeded`; only the salon can make it
  -- `tenant_confirmed`. The shadow records which it was.
  provenance    text not null check (provenance in ('tenant_confirmed', 'seeded', 'inferred')),
  primary key (tenant_id, service_name, related_name),
  constraint service_pairing_not_itself check (service_name <> related_name)
);

comment on table service_pairings is
  'Which listed service suggests which other listed service, by price-list name. D-127.';

-- 1 and 2.
alter table sales_playbooks   enable row level security;
alter table sales_playbooks   force row level security;
alter table sales_next_steps  enable row level security;
alter table sales_next_steps  force row level security;
alter table service_pairings  enable row level security;
alter table service_pairings  force row level security;

-- 3. Three restrictive policies per table, one per write command; and the dormant
--    tenant-owner read 0001 gives every client-readable config table.
do $$
declare t text;
begin
  foreach t in array array['sales_playbooks','sales_next_steps','service_pairings']
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
    execute format(
      'create policy %I on public.%I as permissive for select to authenticated using (tenant_id in (select app.current_tenant_ids()))',
      t || '_member_read', t);
  end loop;
end $$;

-- 4.
insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'sales_playbooks', 'tenant_id'),
       ('public', 'sales_next_steps', 'tenant_id'),
       ('public', 'service_pairings', 'tenant_id');

-- 5.
insert into ops.table_security_class (table_schema, table_name, class, client_readable, note)
values
  ('public', 'sales_playbooks', 'server_owned', true, 'sales next-step switch and lead route'),
  ('public', 'sales_next_steps', 'server_owned', true, 'a tenant''s next-step rows'),
  ('public', 'service_pairings', 'server_owned', true, 'related-service pairs');

revoke all on sales_playbooks, sales_next_steps, service_pairings from anon, authenticated;
grant select on sales_playbooks, sales_next_steps, service_pairings to authenticated;
-- 6.
grant all on sales_playbooks, sales_next_steps, service_pairings to service_role;
