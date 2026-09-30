-- Founder, 2026-09-30: the DM-only "needs a person" rows are approved as proposed
-- (docs/proposals/dm-needs-person-rules.md), comments unchanged. Needs 0073 applied and the
-- code that reads `comment_rules.surfaces` deployed first.
--
-- 1. New escalate rows, DM only, both live tenants.
-- 2. «муудсан», «хүлээлгэ», «дундуур» (and Latin forms) move out of `complaint` into a
--    wall-only row, so a DM with them no longer reads as a complaint and the wall reads the
--    same union of stems as before (checked below).
begin;

insert into comment_rules (tenant_id, rule_key, verdict, matcher, enabled, provenance, surfaces)
select t.id, r.rule_key, 'escalate', r.matcher::jsonb, true, 'seeded', array['direct_message']
from tenants t
cross join (values
  ('person_staff_mn',         '{"mode":"stem_sequence","stems":["ажилтан","яр"],"windowCp":20}'),
  ('person_staff_connect_mn', '{"mode":"stem_sequence","stems":["ажилтан","холбо"],"windowCp":20}'),
  ('person_human_talk_mn',    '{"mode":"stem_sequence","stems":["хүнтэй","яр"],"windowCp":20}'),
  ('person_real_mn',          '{"mode":"stem_sequence","stems":["жинхэнэ","хүн"],"windowCp":15}'),
  ('person_is_there_mn',      '{"mode":"stem_sequence","stems":["хүн","байна","уу"],"windowCp":12}'),
  ('person_manager_mn',       '{"mode":"contains_stem","stems":["менежер","оператор","админ"]}'),
  ('person_staff_lat',        '{"mode":"stem_sequence","stems":["ajiltan","yar"],"windowCp":20}'),
  ('person_staff_connect_lat','{"mode":"stem_sequence","stems":["ajiltan","holbo"],"windowCp":20}'),
  ('person_human_talk_lat',   '{"mode":"stem_sequence","stems":["huntei","yar"],"windowCp":20}'),
  ('person_human_talk_lat2',  '{"mode":"stem_sequence","stems":["hvntei","yar"],"windowCp":20}'),
  ('person_real_lat',         '{"mode":"stem_sequence","stems":["jinhene","hun"],"windowCp":15}'),
  ('person_manager_lat',      '{"mode":"contains_stem","stems":["menejer","operator","admin"]}')
) as r(rule_key, matcher)
where t.slug in ('dalatech', 'matrix-eco-salon')
on conflict (tenant_id, rule_key) do nothing;

create temp table wall_only(stem text) on commit drop;
insert into wall_only values ('муудсан'), ('muudsan'), ('хүлээлгэ'), ('huleelge'), ('hvleelge'), ('дундуур'), ('dunduur');

create temp table before_union on commit drop as
  select c.tenant_id, s.stem from comment_rules c, jsonb_array_elements_text(c.matcher->'stems') s(stem)
  where c.rule_key = 'complaint' and c.tenant_id in (select id from tenants where slug in ('dalatech', 'matrix-eco-salon'));

insert into comment_rules (tenant_id, rule_key, verdict, matcher, enabled, provenance, surfaces)
select distinct b.tenant_id, 'complaint_wall_only', 'escalate',
  jsonb_build_object('mode', 'contains_stem', 'stems', (select jsonb_agg(w.stem order by w.stem) from wall_only w
    where exists (select 1 from before_union x where x.tenant_id = b.tenant_id and x.stem = w.stem))),
  true, 'seeded', array['public_comment']
from before_union b
on conflict (tenant_id, rule_key) do nothing;

update comment_rules c set matcher = jsonb_set(c.matcher, '{stems}',
  (select jsonb_agg(s.stem order by s.ord) from jsonb_array_elements_text(c.matcher->'stems') with ordinality s(stem, ord)
   where s.stem not in (select stem from wall_only)))
where c.rule_key = 'complaint' and c.tenant_id in (select id from tenants where slug in ('dalatech', 'matrix-eco-salon'));

do $$ declare n int; begin
  -- The wall reads the same stems as before: complaint ∪ complaint_wall_only = the old complaint.
  select count(*) into n from (
    (select tenant_id, stem from before_union)
    except
    (select c.tenant_id, s.stem from comment_rules c, jsonb_array_elements_text(c.matcher->'stems') s(stem)
     where c.rule_key in ('complaint', 'complaint_wall_only') and c.tenant_id in (select tenant_id from before_union))
  ) d;
  if n <> 0 then raise exception 'wall stems changed: % missing', n; end if;
  select count(*) into n from comment_rules c join tenants t on t.id = c.tenant_id
    where t.slug in ('dalatech', 'matrix-eco-salon') and c.rule_key like 'person_%' and c.surfaces = array['direct_message'];
  if n <> 24 then raise exception 'expected 24 DM-only person rows, found %', n; end if;
  select count(*) into n from comment_rules c join tenants t on t.id = c.tenant_id, jsonb_array_elements_text(c.matcher->'stems') s(stem)
    where t.slug in ('dalatech', 'matrix-eco-salon') and c.rule_key = 'complaint' and s.stem in (select stem from wall_only);
  if n <> 0 then raise exception 'wall-only stems still in complaint (% rows)', n; end if;
end $$;
commit;
