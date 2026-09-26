-- Tara's thanks row, approved exactly by the founder 2026-09-27:
--   «Зүгээр ээ 😊 Өөр асуух зүйл байвал бичээрэй.»
-- Answers «баярлалаа» and its Latin/shorthand forms the way DalaTech's thanks row does, with
-- no model: the stems are DalaTech's row's, copied here so the two cannot drift, and the
-- platform reads every other form as «баярлалаа» (`mn/chat.ts`, D-147).
--
-- Run AFTER the deploy that carries the added forms («баярла», «ok баярлалаа»): the reply
-- cases below are checked by the production build and every publish.
-- No republish: deterministic rows are read at request time, not compiled into the prefix.
begin;

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, requires_empty_history, provenance, placement, cover_words, quote_services)
select (select id from tenants where slug = 'matrix-eco-salon'), 'thanks',
       'Зүгээр ээ 😊 Өөр асуух зүйл байвал бичээрэй.', true, 'whole_message', d.stems, false,
       'tenant_confirmed', 'replace', '{}', '{}'
  from deterministic_replies d
 where d.tenant_id = (select id from tenants where slug = 'dalatech') and d.intent = 'thanks'
   and not exists (select 1 from deterministic_replies x
                    where x.tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and x.intent = 'thanks');

insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, m.msg, 'Зүгээр ээ 😊 Өөр асуух зүйл байвал бичээрэй.',
       'D-147: Tara thanks row, no model (founder 2026-09-27)'
  from tenants t
  cross join (values ('баярлалаа'), ('bayrlalaa'), ('bayarlalaa'), ('bayrla'), ('баярла'), ('ok баярлалаа')) as m(msg)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = m.msg and r.active);

commit;
