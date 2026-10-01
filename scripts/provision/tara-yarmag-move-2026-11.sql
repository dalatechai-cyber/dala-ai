-- NOT APPLIED. Run ON THE DAY Tara Яармаг opens at its new address (founder: November 2026,
-- date to come; until then the current address stays). D-170.
--
-- New address (founder, 2026-10-01): Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж,
-- VIP Center 2 давхар. No Google Maps listing yet, so the map link goes (the old one points at
-- the old place) and the fixed address reply gives the address only, in its approved shape
-- «Хаяг: …». When a listing exists, add it back as a `maps_url` contact and a
-- «Байршлын холбоос: …» line.
--
-- The branch keeps its name «Яармаг салбар» (founder, 2026-10-01): the display name «Tara Salon —
-- Яармаг», the KB «Салбарууд» and every other row that names Яармаг stay as they are; only the
-- address and the map link change. The final check looks for the old address only, never for
-- the word «Яармаг».
--
-- What changes: contact_points address (compiled: reaches the model at the publish), the
-- maps_url row, the fixed reply `address` (live at COMMIT) and its reply case. No canned row
-- changes, so no `canned_stale` window: run it, then the dry run and publish at once.
-- Before running, check docs/tenants/tara-yarmag.md for any copy of the address added since.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from contact_points where tenant_id = t and kind = 'address'
                 and value = 'Яармагийн Номин Хайпермаркетын баруун талд') then
    raise exception 'the address row is not the one read on 2026-10-01 (or this file is applied)';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'address'
                 and body = 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16') then
    raise exception 'the fixed address reply is not the one read on 2026-10-01';
  end if;
end $$;

update contact_points c
   set value = 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар'
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'address';

delete from contact_points c using tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'maps_url'
   and c.value = 'https://maps.app.goo.gl/ckEXBLoq4FnxJHq16';

update deterministic_replies d
   set body = 'Хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар'
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'address';

update reply_cases r
   set expected_body = 'Хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар'
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.customer_message = 'Хаяг хаана вэ';

-- Earlier turns in the reply cases' recorded history that quote the old address reply.
update reply_cases r
   set history = (
         select jsonb_agg(case when e ? 'content'
                               then jsonb_set(e, '{content}', to_jsonb(replace(e->>'content',
                                      'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16',
                                      'Хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар')))
                               else e end order by x.ord)
           from jsonb_array_elements(r.history) with ordinality as x(e, ord))
  from tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.history::text like '%Номин Хайпермаркет%';

do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  select count(*) into n from (
    select value as x from contact_points where tenant_id = t
    union all select body from deterministic_replies where tenant_id = t
    union all select body from canned_responses where tenant_id = t
    union all select body from knowledge_documents where tenant_id = t
    union all select answer from faqs where tenant_id = t
    union all select history::text || coalesce(expected_body, '') from reply_cases where tenant_id = t) y
   where y.x like '%Номин Хайпермаркет%' or y.x like '%ckEXBLoq4FnxJHq16%';
  if n <> 0 then raise exception '% row(s) still give the old address or map link', n; end if;
end $$;

commit;

-- Undo (if the move is postponed after running this): restore the three rows from the
-- preconditions above, then publish.
