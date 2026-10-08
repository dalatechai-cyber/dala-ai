-- Revert tara-park-od-parity-2026-10-05.sql (Парк Од, before her first publish only).
-- Removes exactly what that file added and puts her channel's comment settings back to the
-- onboarding defaults (comments off). Refuses after her publish: a published tenant's
-- canned lines are write-guarded (0074/0075) and change through a republish, not this file.
-- AFTER IT, re-run the onboarding command with --apply (and --wording): its generated
-- video-link case still expects the reel question this file deletes, and the re-run puts it
-- back to the media line; without that her publish dry run fails that one case.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  if (select live_revision_id from tenants where id = t) is not null then
    raise exception 'tara-park-od has been published: revert by a reviewed change and a republish, not this file';
  end if;
  if not exists (select 1 from reply_cases where tenant_id = t and note like 'parity 2026-10-05%') then
    raise exception 'tara-park-od-parity-2026-10-05.sql is not applied';
  end if;
end $$;

delete from reply_cases where tenant_id = (select id from tenants where slug = 'tara-park-od') and note like 'parity 2026-10-05%';
delete from canned_responses where tenant_id = (select id from tenants where slug = 'tara-park-od')
   and kind in ('photo_price_question', 'reel_price_question');
delete from service_aliases where tenant_id = (select id from tenants where slug = 'tara-park-od');
delete from spellings where tenant_id = (select id from tenants where slug = 'tara-park-od');
delete from forbidden_phrasings where tenant_id = (select id from tenants where slug = 'tara-park-od');
update comment_rules set enabled = false where tenant_id = (select id from tenants where slug = 'tara-park-od');
update tenant_channels
   set comment_policy = 'none', comment_delivery_mode = 'off', comment_replies_per_post_per_day = 1,
       comment_max_post_age_days = 30, automation_texts = '{}', meta_app_id = null, app_slug = null
 where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page';

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  if exists (select 1 from reply_cases where tenant_id = t and note like 'parity 2026-10-05%')
     or exists (select 1 from canned_responses where tenant_id = t and kind in ('photo_price_question', 'reel_price_question'))
     or exists (select 1 from service_aliases where tenant_id = t)
     or exists (select 1 from spellings where tenant_id = t)
     or exists (select 1 from forbidden_phrasings where tenant_id = t)
     or exists (select 1 from comment_rules where tenant_id = t and enabled) then
    raise exception 'read-back: the revert left rows behind';
  end if;
end $$;

commit;
