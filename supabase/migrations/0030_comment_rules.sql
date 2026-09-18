-- Which public comments deserve a reply (docs/comments.md, D-085).
--
-- The classifier is rows, not code. Nothing in `src/` names a topic, a stem or a tenant:
-- a salon that sells something no other salon sells is a row here, and "onboarding client
-- #3 is filling in a config" holds for the comment surface the same way it holds for the
-- gate.
--
-- ## This is the FIRST migration since 0001 to create a table, so read this part
--
-- `0001` does all of its security bookkeeping in bulk `do $$` loops over the catalog —
-- RLS, FORCE, the three restrictive write-deny policies, `ops.tenant_scope`,
-- `ops.table_security_class` — precisely so that no table it creates can be forgotten. A
-- table created LATER gets none of that, and every one of those omissions is silent: the
-- table works, reads work, writes work, and the tenant boundary is simply absent.
--
-- Three of them were omitted in this file's first draft and `scripts/verify/catalog.sql`
-- caught all three (V3, V8, V17) against a real PostgreSQL. That is the mechanism working,
-- and it is why the checklist below is written as a checklist rather than as prose: the
-- NEXT migration that adds a table has to do the same five things, and the suite is what
-- says whether it did.
--
--   1. `enable row level security`                      — V2
--   2. `force row level security`, so the OWNER is bound — V3
--   3. the THREE per-command restrictive deny-write policies, named
--      `<table>_no_client_insert` / `_update` / `_delete`. **Never a single `for all`** —
--      that includes SELECT, so a restrictive `using (false)` ANDs with the permissive
--      read policy and denies every client read as well. It looks like a working policy
--      set and the catalog still counts a policy on the table — V17
--   4. a row in `ops.tenant_scope`, or the purge, the export and the tenant spine do not
--      know this table exists                           — V7, V8
--   5. a row in `ops.table_security_class`. `client_readable` defaults FALSE, which is the
--      answer here: comment rules are ours, not the tenant dashboard's
--
-- ## `verdict` has three values and `unclassified` is not one of them
--
-- `unclassified` is the ABSENCE of a matching rule, and it must stay unwritable. A row
-- saying "classify this as unclassified" would be a way to make the operator's to-do
-- list — every comment the tenant has no rule for — say whatever somebody wanted it to
-- say, which is the one thing that list is for.
--
-- Precedence between the three is a total order declared in `classify.ts`
-- (escalate > reply > ignore) and NOT a column here. D-075: ambiguity is a verdict, never
-- a tie broken silently — and with a declared total order there is no tie, and no row can
-- reorder it.

create table comment_rules (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  rule_key    text not null,
  -- 'escalate' — a person must look at this; posts nothing and does NOT consume the post's
  --              daily allowance. The corpus reason: «Утсаа авахгүй байна» answered with
  --              *come to DM* is a brush-off to a public complaint in the salon's voice.
  -- 'reply'    — eligible for the tenant's one pinned line, subject to every other check.
  -- 'ignore'   — recognised noise. Distinct from no rule firing, on purpose.
  verdict     text not null check (verdict in ('escalate', 'reply', 'ignore')),
  -- The SAME `matcher` jsonb `out_of_scope_topics` carries, parsed by the same
  -- `parseMatcher`. One matcher language on this platform, not two that drift apart.
  matcher     jsonb not null,
  -- Off by default. A rule is written, read by a human, then switched on — the same shape
  -- `deterministic_shortcircuit` uses, and for the same reason: this surface is public.
  enabled     boolean not null default false,
  -- D-020. No default: a construction site that cannot say where a rule came from must be
  -- made to answer rather than be quietly credited with `tenant_confirmed`.
  provenance  text not null check (provenance in ('tenant_confirmed', 'seeded', 'inferred')),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, rule_key)
);

comment on table comment_rules is
  'Which public comments deserve a reply. Read by classifyComment; the verdict is an enum '
  'and the comment text never reaches the reply body. See docs/comments.md.';

comment on column comment_rules.enabled is
  'Off by default. Switching a rule on is an operator action on a public surface.';

-- 1 and 2. FORCE binds the table owner too, which `enable` alone does not.
alter table comment_rules enable row level security;
alter table comment_rules force row level security;

-- 3. Three policies, one per write command. See the checklist above for why not `for all`.
create policy comment_rules_no_client_insert on comment_rules
  as restrictive for insert to anon, authenticated with check (false);
create policy comment_rules_no_client_update on comment_rules
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy comment_rules_no_client_delete on comment_rules
  as restrictive for delete to anon, authenticated using (false);

-- 4. The tenant spine: purge, export and every per-tenant sweep read this registry rather
--    than assuming a column name.
insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'comment_rules', 'tenant_id');

-- 5. Server-owned and NOT client-readable. Scoped-by-tenant and readable-by-that-tenant are
--    different questions (0001), and these rules decide whether the platform speaks in
--    public — they are ours.
insert into ops.table_security_class (table_schema, table_name, class, note)
values ('public', 'comment_rules', 'server_owned',
        'which public comments deserve a reply; server-written, never client-authored');

-- A grant is not a policy and a policy is not a grant (CLAUDE.md rule 5). 0001 revoked the
-- Supabase-seeded default privileges for future tables in `public`, so this should already
-- be empty — the revoke is explicit anyway, because "should already be" is the assumption
-- that made that line untested for months.
revoke all on comment_rules from anon, authenticated;
