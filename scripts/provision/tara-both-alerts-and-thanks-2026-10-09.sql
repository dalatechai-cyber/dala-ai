-- NOT APPLIED. Both Tara branches (matrix-eco-salon = Яармаг, tara-park-od = Парк Од).
-- Run AFTER the deploy of the pull request «No customer left in silence» (its code reads
-- «bayrlala» as thanks; without it the four thanks cases below fail the next build's gate).
--
-- 1. A photo, video or reel handed to a person now tells a person (Telegram, `media_handoff`
--    alert), on both branches. Founder, 2026-10-09: «no customer on either branch is ever left in
--    silence without a person being told». This reverses D-153 for Tara (2026-09-27: alert off,
--    «the salon sees it in its inbox»). Measured 2026-09-25 to 2026-10-09 on Яармаг: 60 chats were
--    handed to a person after a photo, nobody was alerted, and no staff reply on the Page is
--    recorded in any of them; 64 customer messages followed inside the 30 minutes the bot stays
--    quiet and got no answer.
--    No republish: the setting is read on each hand-off.
-- 2. Reply cases for thanks as customers type it, both branches (exact: the approved thanks row).
--    From the real chats: «bayrlala» (Парк Од, 2026-10-09 02:19, answered by the model «Тавтай
--    морилно уу!»), «Za bayrlaa», «zaa bayrlala», «ok bayrllaa» (Яармаг). No wording changes.
--
-- Run as ONE file in the SQL editor. Refuses a second run. Undo: the -revert.sql beside it.
begin;

do $$
begin
  if (select count(*) from tenants where slug in ('matrix-eco-salon', 'tara-park-od') and media_handoff_alert = false) <> 2 then
    raise exception 'expected the media hand-off alert OFF on both Tara branches (already applied?)';
  end if;
  if exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
             where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'thanks as typed 2026-10-09%') then
    raise exception 'tara-both-alerts-and-thanks-2026-10-09.sql is already applied';
  end if;
  if (select count(distinct d.body) from deterministic_replies d join tenants t on t.id = d.tenant_id
      where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.intent = 'thanks' and d.enabled) <> 1 then
    raise exception 'the two branches'' thanks rows differ, or one is missing';
  end if;
end $$;

update tenants set media_handoff_alert = true where slug in ('matrix-eco-salon', 'tara-park-od');

insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, m.msg, d.body, '{}', '{}', 'thanks as typed 2026-10-09 (exact): ' || m.why
  from tenants t
  join deterministic_replies d on d.tenant_id = t.id and d.intent = 'thanks' and d.enabled
  cross join (values
    ('bayrlala', 'Парк Од 2026-10-09 02:19, the model answered «Тавтай морилно уу!»'),
    ('Za bayrlaa', 'Яармаг 2026-09-25'),
    ('zaa bayrlala', 'Яармаг'),
    ('ok bayrllaa', 'Яармаг, the model answered')
  ) as m(msg, why)
 where t.slug in ('matrix-eco-salon', 'tara-park-od');

do $$
begin
  if (select count(*) from tenants where slug in ('matrix-eco-salon', 'tara-park-od') and media_handoff_alert) <> 2
     or (select count(*) from reply_cases r join tenants t on t.id = r.tenant_id
         where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'thanks as typed 2026-10-09%' and r.active) <> 8 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
