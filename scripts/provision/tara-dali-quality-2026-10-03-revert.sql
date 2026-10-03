-- ONLY IF NEEDED. Undoes tara-dali-quality-2026-10-03.sql: the booking row loses the stems and
-- cover words it added, and the six quality cases go.
begin;
update deterministic_replies d
   set stems = array(select w from unnest(d.stems) w where w not in ('авч', 'awch', 'avch', 'абч', 'abch')),
       cover_words = array(select w from unnest(d.cover_words) w
                           where w not in ('очих', 'ochih', 'очиж', 'ochij', 'болох', 'boloh', 'bolh'))
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'booking';
delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'quality 2026-10-03%';
commit;
