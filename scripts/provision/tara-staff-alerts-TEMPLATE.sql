-- TEMPLATE, NOT APPLIED. Switches ON the staff hand-off ping for ONE Tara branch
-- (`src/lib/handover/staffNotify.ts`, D-183): when Дали hands a chat to a person, that branch's
-- own Telegram group gets the branch name, the time and a link that opens the chat.
--
-- Before running: the code is merged and deployed, the branch's staff group exists with the
-- platform bot in it, and you have its chat id (runbook docs/runbooks/staff-alerts.md, steps 1–5).
-- Tara only (the slug list below); another tenant is an edit of that list. Fill in the TWO values
-- below (branch slug, chat id). One branch per run: Яармаг is
-- 'matrix-eco-salon', Парк Од is 'tara-park-od'. Never put one branch's chat id on the other.
--
-- Takes effect at once, no publish. Refuses the placeholder, a malformed chat id, a chat id
-- already used by another tenant, and a branch that already has a target (change it with the
-- revert first). Undo (switch OFF): tara-staff-alerts-TEMPLATE-revert.sql with the same slug.
begin;

create temporary table _target on commit drop as
  select 'REPLACE_WITH_BRANCH_SLUG'::text as slug, 'REPLACE_WITH_CHAT_ID'::text as chat_id;

do $$
declare s text; c text; tid uuid;
begin
  select slug, chat_id into s, c from _target;
  if s not in ('matrix-eco-salon', 'tara-park-od') then
    raise exception 'set the branch slug (matrix-eco-salon or tara-park-od), found %', s;
  end if;
  if c !~ '^-?[0-9]{3,20}$' then
    raise exception 'set the Telegram chat id (digits, a group''s starts with -), found %', c;
  end if;
  select id into tid from tenants where slug = s;
  if tid is null then raise exception 'no tenant %', s; end if;
  if exists (select 1 from handoff_targets where tenant_id = tid and kind = 'telegram') then
    raise exception '% already has a Telegram target: run the revert first to change it', s;
  end if;
  if exists (select 1 from handoff_targets where kind = 'telegram' and destination = c) then
    raise exception 'chat id % is already another tenant''s target: one branch, one chat', c;
  end if;
end $$;

insert into handoff_targets (tenant_id, kind, destination, verified_at)
select t.id, 'telegram', x.chat_id, now() from _target x join tenants t on t.slug = x.slug;

-- Read back: exactly one target for this branch, verified.
do $$
begin
  if (select count(*) from handoff_targets h join tenants t on t.id = h.tenant_id join _target x on x.slug = t.slug
      where h.kind = 'telegram' and h.destination = x.chat_id and h.verified_at is not null) <> 1 then
    raise exception 'read-back: the target was not written';
  end if;
end $$;

commit;
