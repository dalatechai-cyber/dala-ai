-- ONLY IF NEEDED. Undoes tara-dali-quality-2026-10-03.sql: its five reply cases go.
begin;
delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'quality 2026-10-03%';
commit;
