-- Item A, 2026-09-20: a suitability question about a chemical process goes to a person.
--
-- THE FOUNDER RUNS THIS FILE. That act is the signature on the sentence — `reviewed_at`
-- is set below because the body is his own wording, given verbatim on 2026-09-20, and
-- because no script in this repository may set that column on its own behalf.
--
-- REQUIRES `0034_refusal_suitability.sql` to be pushed first: it adds the
-- `refusal_suitability` kind to `canned_response_kinds`, and this INSERT is refused by the
-- foreign key until it is. That ordering is D-058 stated forwards — CI applies every
-- migration in the repo, so nothing here can tell you whether the project has this one.
-- Read `supabase_migrations.schema_migrations`, not `ls supabase/migrations/`.
--
-- WHY A ROW AND NOT A GUARD. The failure is composition: the model bridged two true
-- knowledge rows with an invented relationship (D-099). An input filter cannot see that —
-- D-033's lesson — because the parts are individually true and individually approved. What
-- CAN see it is the question's SHAPE: "will this chemical process work on MY hair" is a
-- judgement about hair the model cannot examine, whatever the chemistry attached to it.
--
-- THE MATCHERS ARE MEASURED, NOT REASONED. Against 5 suitability questions and 22
-- price/booking/location/greeting messages, the six pairs below score 5/5 true positives
-- and 0/22 false positives. Two pairs were CUT after measurement and the reason is the
-- whole argument for measuring:
--
--   [хими, болох] fired on «Шулуун хими хэд болох вэ», «Афро хими хэд болох вэ» and
--   «Усан хими хийлгэвэл хэд болох вэ» — 3 of 22, every one a PRICE question, because
--   «хэд болох вэ» is *how much will it be*. A suitability refusal served to a price
--   question is the exact regression this platform is trying to end.
--
--   [himi, bold] scored 0/22 only because «bolh» is not a prefix of the stem «bold».
--   That is spelling luck, not design, and its Cyrillic twin is known-unsafe. Cut.
--
-- `contains_stem` was never a candidate: «болох», «үсэнд» and «тохирох» all occur in
-- ordinary price questions, so the ANY-of mode would refuse a large share of them.
-- `stem_sequence` requires both stems IN ORDER inside a 40-codepoint window.

begin;

insert into canned_responses (tenant_id, kind, body, provenance, reviewed_at)
select t.id, 'refusal_suitability',
  'Уучлаарай, энэ таны үсэнд тохирох эсэхийг би шийдэж өгөх боломжгүй. Манай мэргэжилтэн үсийг тань харж хэлнэ. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.',
  'tenant_confirmed', now()
from tenants t where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, kind) do nothing;

-- Six rows rather than one: `out_of_scope_topics.matcher` holds a single matcher, and a
-- stem_sequence carries exactly one ordered pair.
insert into out_of_scope_topics
  (tenant_id, topic_key, matcher, decision_question, response_kind, deterministic_shortcircuit, provenance)
select t.id, v.key, v.matcher::jsonb,
  'Сүүлийн мессеж тухайн үйлчилгээ энэ хүний үсэнд тохирох эсэхийг асууж байна уу?',
  'refusal_suitability', false, 'tenant_confirmed'
from tenants t, (values
  ('suitability_mn_orh',  '{"mode":"stem_sequence","stems":["үсэнд","орох"],"windowCp":40}'),
  ('suitability_lat_orh', '{"mode":"stem_sequence","stems":["usend","oroh"],"windowCp":40}'),
  ('suitability_mn_himi', '{"mode":"stem_sequence","stems":["үсэнд","хими"],"windowCp":40}'),
  ('suitability_lat_himi','{"mode":"stem_sequence","stems":["usend","himi"],"windowCp":40}'),
  ('suitability_lat_budag','{"mode":"stem_sequence","stems":["budag","himi"],"windowCp":40}'),
  ('suitability_mn_ungu', '{"mode":"stem_sequence","stems":["өнгө","гарах"],"windowCp":40}')
) as v(key, matcher)
where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, topic_key) do nothing;

-- Read these back before committing. Expect 1 and 6.
select count(*) as canned_rows from canned_responses
  where kind = 'refusal_suitability'
    and tenant_id = (select id from tenants where slug = 'matrix-eco-salon');
select count(*) as topic_rows from out_of_scope_topics
  where response_kind = 'refusal_suitability'
    and tenant_id = (select id from tenants where slug = 'matrix-eco-salon');

commit;

-- AFTER THIS: republish. The canned section is inside the cached prefix (D-058), so a new
-- row moves `canned_hash`, and a request compiled against the old snapshot 503s with
-- `canned_stale`. Deploy, `git pull`, then publish — three steps, in that order (D-074).
