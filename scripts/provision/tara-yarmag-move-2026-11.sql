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
--
-- BOTH TENANTS (founder, 2026-10-04: «Салбарууд» is symmetric, so Парк Од names Яармаг's
-- address too): when Парк Од exists, her KB «Салбарууд» and her fixed reply `yarmag_branch`
-- get the new address in the same transaction; then publish BOTH:
--     node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
--     node scripts/publish/tenant.ts --slug tara-park-od --publish     (if she is published)
-- config/branch-groups.json `allow_addresses` already lists the VIP Center address, so the
-- branch gate accepts it in Парк Од's rows with no config change on the day. The gate knows only
-- each branch's CURRENT address, so it never looks for the old one after the move: this file's
-- own check (no Парк Од row may still give «Номин Хайпермаркет») and
-- tara-park-od-after-onboarding.sql's precondition (it refuses once Яармаг has moved, until its
-- two Яармаг-address lines are updated) are what catch a stale copy. Removing the old address
-- from `allow_addresses` afterwards is tidying, not a check.
-- Парк Од is updated only where her rows carry the old address line: a Парк Од that is only
-- partly provisioned (no «Салбарууд» or `yarmag_branch` yet) never blocks Яармаг's move.
-- Before running, check docs/tenants/tara-yarmag.md for any copy of the address added since.
-- Undo: tara-yarmag-move-2026-11-revert.sql.
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

-- How many of Парк Од's rows give Яармаг's old address line now: exactly these must give the
-- new one after the update.
create temp table parkod_move_expect on commit drop as
select count(*)::int as expected from (
  select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'tara-park-od' and k.title = 'Салбарууд'
     and k.body like '%Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд.%'
  union all
  select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
   where t.slug = 'tara-park-od' and d.intent = 'yarmag_branch'
     and d.body like '%Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд%') x;

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
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id
   and r.expected_body = 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд
Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16';  -- «Хаяг хаана вэ», «Яармаг салбар хаана байдаг вэ?»

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

-- Парк Од: the two rows that name Яармаг's address (only when she is provisioned), and any reply
-- case or web body of hers that quotes it (every Яармаг address in her rows is Яармаг's).
update reply_cases r
   set expected_body = replace(r.expected_body, 'Яармагийн Номин Хайпермаркетын баруун талд', 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар'),
       history = replace(r.history::text, 'Яармагийн Номин Хайпермаркетын баруун талд', 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар')::jsonb
  from tenants t
 where t.slug = 'tara-park-od' and r.tenant_id = t.id
   and (r.expected_body like '%Номин Хайпермаркет%' or r.history::text like '%Номин Хайпермаркет%');

update deterministic_replies d
   set web_body = replace(d.web_body, 'Яармагийн Номин Хайпермаркетын баруун талд', 'Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар')
  from tenants t
 where t.slug = 'tara-park-od' and d.tenant_id = t.id and d.web_body like '%Номин Хайпермаркет%';

update knowledge_documents k
   set body = replace(k.body, 'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд.',
                              'Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар.'),
       updated_at = now()
  from tenants t
 where t.slug = 'tara-park-od' and k.tenant_id = t.id and k.title = 'Салбарууд';

update deterministic_replies d
   set body = replace(d.body, 'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд',
                              'Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар')
  from tenants t
 where t.slug = 'tara-park-od' and d.tenant_id = t.id and d.intent = 'yarmag_branch';

do $$
declare t uuid; n int;
begin
  -- Парк Од, when she exists: no row of hers gives the old address, and every row of hers that
  -- gave the old address line now gives the new one.
  select id into t from tenants where slug = 'tara-park-od';
  if t is not null then
    select count(*) into n from (
      select value as x from contact_points where tenant_id = t
      union all select body from deterministic_replies where tenant_id = t
      union all select body from canned_responses where tenant_id = t
      union all select body from knowledge_documents where tenant_id = t
      union all select answer from faqs where tenant_id = t
      union all select history::text || coalesce(expected_body, '') from reply_cases where tenant_id = t) y
     where y.x like '%Номин Хайпермаркет%';
    if n <> 0 then raise exception 'tara-park-od: % row(s) still give Яармаг''s old address', n; end if;
    if (select count(*) from (
          select body from knowledge_documents where tenant_id = t and title = 'Салбарууд'
          union all select body from deterministic_replies where tenant_id = t and intent = 'yarmag_branch') y
         where y.body like '%Яармаг салбарын хаяг: Хан-Уул дүүрэг, 24-р хороо, Наадамчдын зам гудамж, VIP Center 2 давхар%')
       <> (select expected from parkod_move_expect) then
      raise exception 'tara-park-od: every row that gave Яармаг''s old address line must give the new one';
    end if;
  end if;

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

-- Undo (if the move is postponed after running this): tara-yarmag-move-2026-11-revert.sql,
-- then publish both tenants.
