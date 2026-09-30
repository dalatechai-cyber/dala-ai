-- Founder, 2026-09-30: DM-only "needs a person" rows, comments unchanged
-- (docs/proposals/dm-needs-person-rules.md; the same rows are in templates/comment_rules.*.json).
-- Needs 0073 applied and the code that reads `comment_rules.surfaces` deployed first.
--
-- 1. Nine escalate rows per live tenant, DM only, all in the «-тай» (with) form so product
--    names («Утасны оператор», «Нова менежер», «админ самбар», «AI ажилтан … ярьдаг») and
--    «жинхэнэ хүний үс» do not fire (review, 2026-09-30).
-- 2. «муудсан», «хүлээлгэ», «дундуур» (and Latin forms) move out of `complaint` into a wall-only
--    row that copies `complaint`'s `enabled`, so the wall reads the same stems in the same state.
begin;

do $$ begin
  -- A channel allow-list naming `complaint` would lose the moved stems on that channel.
  if exists (select 1 from tenant_channels ch join tenants t on t.id = ch.tenant_id
             where t.slug in ('dalatech', 'matrix-eco-salon') and 'complaint' = any(ch.comment_rule_keys)) then
    raise exception 'a channel allow-list names complaint: add complaint_wall_only to it first';
  end if;
end $$;

insert into comment_rules (tenant_id, rule_key, verdict, matcher, enabled, provenance, surfaces)
select t.id, r.rule_key, 'escalate', r.matcher::jsonb, true, 'seeded', array['direct_message']
from tenants t
cross join (values
  ('person_staff_mn', '{"mode":"stem_sequence","stems":["ажилтантай","яр"],"windowCp":20}'),
  ('person_staff_connect_mn', '{"mode":"stem_sequence","stems":["ажилтантай","холбо"],"windowCp":20}'),
  ('person_human_talk_mn', '{"mode":"stem_sequence","stems":["хүнтэй","яр"],"windowCp":20}'),
  ('person_manager_mn', '{"mode":"contains_stem","stems":["менежертэй","оператортой","админтай"]}'),
  ('person_staff_lat', '{"mode":"stem_sequence","stems":["ajiltantai","yar"],"windowCp":20}'),
  ('person_staff_connect_lat', '{"mode":"stem_sequence","stems":["ajiltantai","holbo"],"windowCp":20}'),
  ('person_human_talk_lat', '{"mode":"stem_sequence","stems":["huntei","yar"],"windowCp":20}'),
  ('person_human_talk_lat2', '{"mode":"stem_sequence","stems":["hvntei","yar"],"windowCp":20}'),
  ('person_manager_lat', '{"mode":"contains_stem","stems":["menejertei","operatortoi","admintai"]}')
) as r(rule_key, matcher)
where t.slug in ('dalatech', 'matrix-eco-salon')
on conflict (tenant_id, rule_key) do nothing;

create temp table wall_only(stem text) on commit drop;
insert into wall_only values ('муудсан'), ('muudsan'), ('хүлээлгэ'), ('huleelge'), ('hvleelge'), ('дундуур'), ('dunduur');

create temp table before_union on commit drop as
  select c.tenant_id, s.stem from comment_rules c, jsonb_array_elements_text(c.matcher->'stems') s(stem)
  where c.rule_key = 'complaint' and c.tenant_id in (select id from tenants where slug in ('dalatech', 'matrix-eco-salon'));

insert into comment_rules (tenant_id, rule_key, verdict, matcher, enabled, provenance, surfaces)
select c.tenant_id, 'complaint_wall_only', 'escalate',
  jsonb_build_object('mode', 'contains_stem', 'stems', (select jsonb_agg(w.stem order by w.stem) from wall_only w
    where exists (select 1 from before_union x where x.tenant_id = c.tenant_id and x.stem = w.stem))),
  c.enabled, 'seeded', array['public_comment']
from comment_rules c
where c.rule_key = 'complaint'
  and c.tenant_id in (select id from tenants where slug in ('dalatech', 'matrix-eco-salon'))
  -- Never a row with no stems: `stems: null` is a malformed rule, and one refuses every comment job.
  and exists (select 1 from before_union x join wall_only w on w.stem = x.stem where x.tenant_id = c.tenant_id)
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
  -- Both halves in the same state, and no rule left without stems.
  select count(*) into n from comment_rules a join comment_rules b on b.tenant_id = a.tenant_id and b.rule_key = 'complaint_wall_only'
    where a.rule_key = 'complaint' and a.enabled <> b.enabled;
  if n <> 0 then raise exception 'complaint_wall_only enabled differs from complaint (% tenants)', n; end if;
  select count(*) into n from comment_rules where rule_key in ('complaint', 'complaint_wall_only')
    and (matcher->'stems' is null or jsonb_typeof(matcher->'stems') <> 'array' or jsonb_array_length(matcher->'stems') = 0);
  if n <> 0 then raise exception 'a complaint row has no stems (% rows)', n; end if;
  select count(*) into n from comment_rules c join tenants t on t.id = c.tenant_id
    where t.slug in ('dalatech', 'matrix-eco-salon') and c.rule_key like 'person_%' and c.surfaces = array['direct_message'];
  if n <> 18 then raise exception 'expected 18 DM-only person rows, found %', n; end if;
  select count(*) into n from comment_rules c join tenants t on t.id = c.tenant_id, jsonb_array_elements_text(c.matcher->'stems') s(stem)
    where t.slug in ('dalatech', 'matrix-eco-salon') and c.rule_key = 'complaint' and s.stem in (select stem from wall_only);
  if n <> 0 then raise exception 'wall-only stems still in complaint (% rows)', n; end if;
end $$;
commit;
