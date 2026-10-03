-- ONLY IF NEEDED. Undoes tara-yarmag-photo-question-2026-10-04.sql: the question row goes, so a
-- photo is handed to staff again exactly as before D-176 (the code is inert without the row),
-- and its reply cases go. Model-invisible kind: no republish needed.
begin;
delete from canned_responses c using tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'photo_price_question';
delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'photo question 2026-10-04%';
commit;
