-- ONLY IF NEEDED. Undoes tara-yarmag-reel-question-2026-10-04.sql: the reel question row goes, so a
-- reel, a video or a link to one is handed to staff again exactly as before (D-152; the code is
-- inert without the row), and its reply cases go. Model-invisible kind: no republish needed.
-- The photo question, if applied, is untouched.
begin;
delete from canned_responses c using tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'reel_price_question';
delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'reel question 2026-10-04%';
commit;
