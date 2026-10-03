-- ONLY IF NEEDED. Undoes tara-yarmag-price-page-2026-10-04.sql (and its go-live step, if run):
-- the two rows, their reply cases and the `price_page` contact go. Publish afterwards if the
-- contact row existed (contacts are compiled).
begin;
delete from deterministic_replies d using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent in ('price_page_color', 'price_page_treatment_perm');
delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'price page 2026-10-04%';
delete from contact_points c using tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'price_page';
commit;
