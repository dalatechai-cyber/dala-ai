-- An edit to a live tenant's approved lines cannot silently stop every reply (founder,
-- 2026-09-30, D-163).
--
-- The reply path refuses every reply with `canned_stale` when the live `canned_responses`
-- rows no longer hash to the published snapshot's `canned_hash` (D-058). A direct edit
-- without a republish did exactly that for two and a half days on 21–24 Sep (D-113). The
-- founder chose "refused" over "republished automatically" for edits outside the publish
-- flow: a publish needs the operator's checkout, the facts, branch and reply-case gates and
-- the founder's secret, so it cannot run from a trigger.
--
-- The trigger refuses an INSERT, UPDATE or DELETE on `canned_responses` that would move the
-- published hash of a tenant with a live revision, unless the transaction says it will
-- republish:
--     begin; set local dala.canned_edit = 'republish'; <edit>; commit;
--     then scripts/publish/tenant.ts --slug <slug> (dry run, then --publish) at once.
-- Allowed without it: an UPDATE that changes neither kind, locale, tenant nor the trimmed body
-- (signing: `reviewed_at`, `reviewed_by`); rows in a locale other than the tenant's default
-- (never compiled); rows of a model-invisible kind (`MODEL_INVISIBLE_KINDS`,
-- `gate/match.ts`, kept in step by `check-gate-keys`), which never enter the prefix; tenants
-- with no live revision (onboarding). A live tenant cannot be deleted anyway (`config_audit`
-- is append-only), so no cascade path is needed.
--
-- Not covered, by design (the hourly drift check catches each within the hour): TRUNCATE (row
-- triggers do not fire), `session_replication_role = replica`, a change to
-- `tenants.default_locale`, and an `insert ... on conflict do update` that rewrites a live row
-- with identical bytes (a BEFORE INSERT trigger fires before the conflict is known, so it is
-- refused). When MODEL_INVISIBLE_KINDS grows, deploy the code before the migration that
-- redefines this function.
--
-- Not destructive: no row is changed. The hourly drift check and the reply path's page
-- (`prompt/cannedDrift.ts`) still catch anything that gets past this.

create or replace function ops.refuse_unpublished_canned_edit() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
declare
  -- Model-invisible canned kinds: they are filtered out of the compiled prefix and the
  -- hash, so editing them never makes a tenant stale. Same list as MODEL_INVISIBLE_KINDS.
  invisible constant text[] := array['image_received', 'comment_public_reply', 'comment_private_reply',
    'handover_notice', 'handover_reclaim', 'clarify_branch', 'comment_cta_public_reply',
    'comment_cta_private_reply', 'voice_received'];
  old_counts boolean := false;
  new_counts boolean := false;
begin
  if coalesce(current_setting('dala.canned_edit', true), '') = 'republish' then
    return coalesce(new, old);
  end if;
  -- Signing, or a body that differs only in surrounding spaces: the hash reads the kind and
  -- the TRIMMED body, so neither moves it. `btrim` trims spaces only, fewer characters than
  -- JavaScript's `trim()`, so any other difference is still refused (the safe direction).
  if tg_op = 'UPDATE'
     and btrim(new.body) is not distinct from btrim(old.body) and new.kind = old.kind
     and new.locale = old.locale and new.tenant_id = old.tenant_id then
    return new;
  end if;

  -- A row is in the published hash when its kind is model-visible, its locale is its
  -- tenant's default locale (the only one compiled), and that tenant has a live revision.
  if tg_op in ('UPDATE', 'DELETE') and not (old.kind = any(invisible)) then
    select exists (select 1 from public.tenants t
                   where t.id = old.tenant_id and t.live_revision_id is not null
                     and t.default_locale = old.locale) into old_counts;
  end if;
  if tg_op in ('UPDATE', 'INSERT') and not (new.kind = any(invisible)) then
    select exists (select 1 from public.tenants t
                   where t.id = new.tenant_id and t.live_revision_id is not null
                     and t.default_locale = new.locale) into new_counts;
  end if;
  if not (old_counts or new_counts) then
    return coalesce(new, old);
  end if;

  raise exception 'canned_responses: this edit changes a live tenant''s published lines, and every reply would stop (canned_stale) until a republish'
    using errcode = 'P0001',
          hint = 'In one SQL transaction: begin; set local dala.canned_edit = ''republish''; <edit>; commit; then publish the tenant at once (scripts/publish/tenant.ts). PostgREST and scripts/provision cannot set this; edit through SQL. D-163.';
end $$;

create trigger canned_responses_refuse_unpublished_edit
  before insert or update or delete on canned_responses
  for each row execute function ops.refuse_unpublished_canned_edit();

comment on function ops.refuse_unpublished_canned_edit() is
  'D-163. Refuses a canned_responses edit that would make a live tenant canned_stale, unless the transaction sets dala.canned_edit = ''republish''.';
