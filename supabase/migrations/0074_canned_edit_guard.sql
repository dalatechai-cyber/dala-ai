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
-- Allowed without it: an UPDATE that changes neither body, kind, locale nor tenant (signing:
-- `reviewed_at`, `reviewed_by`); rows of a model-invisible kind (`MODEL_INVISIBLE_KINDS`,
-- `gate/match.ts`, kept in step by `check-gate-keys`), which never enter the prefix; tenants
-- with no live revision (onboarding). A live tenant cannot be deleted anyway (`config_audit`
-- is append-only), so no cascade path is needed.
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
  tenants_hit uuid[];
begin
  if coalesce(current_setting('dala.canned_edit', true), '') = 'republish' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.body is not distinct from old.body and new.kind = old.kind
     and new.locale = old.locale and new.tenant_id = old.tenant_id then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.kind = any(invisible))
     or (tg_op = 'DELETE' and old.kind = any(invisible))
     or (tg_op = 'UPDATE' and new.kind = any(invisible) and old.kind = any(invisible)) then
    return coalesce(new, old);
  end if;

  tenants_hit := case tg_op
    when 'INSERT' then array[new.tenant_id]
    when 'DELETE' then array[old.tenant_id]
    else array[new.tenant_id, old.tenant_id] end;
  if not exists (select 1 from public.tenants t where t.id = any(tenants_hit) and t.live_revision_id is not null) then
    return coalesce(new, old);
  end if;

  raise exception 'canned_responses: this edit changes a live tenant''s published lines, and every reply would stop (canned_stale) until a republish'
    using errcode = 'P0001',
          hint = 'Run it as: begin; set local dala.canned_edit = ''republish''; <edit>; commit; then publish the tenant at once (scripts/publish/tenant.ts). D-163.';
end $$;

create trigger canned_responses_refuse_unpublished_edit
  before insert or update or delete on canned_responses
  for each row execute function ops.refuse_unpublished_canned_edit();

comment on function ops.refuse_unpublished_canned_edit() is
  'D-163. Refuses a canned_responses edit that would make a live tenant canned_stale, unless the transaction sets dala.canned_edit = ''republish''.';
