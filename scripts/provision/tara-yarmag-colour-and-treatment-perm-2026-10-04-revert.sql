-- Undo tara-yarmag-colour-and-treatment-perm-2026-10-04.sql for Tara Яармаг (matrix-eco-salon):
-- the two rows and their reply cases go. No publish needed (rows are read at request time).
begin;
delete from deterministic_replies d
 using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent in ('treatment_perm_women', 'colour_lift');
delete from reply_cases r
 using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'D-177:%';
commit;
