-- Undo tara-yarmag-stylist-names-2026-10-03.sql: the staff rows, «Салбарууд» and «Үсчдийн нэр»
-- exactly as read on 2026-10-03. Then publish Яармаг at once:
--     node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from staff_members where tenant_id = t and name in ('Oyunaa', 'Badamaa', 'Uyanga', 'Zaya', 'Chimgee', 'Anand', 'Otgonjargal')) <> 7 then
    raise exception 'tara-yarmag-stylist-names-2026-10-03.sql is not applied (seven new names expected)';
  end if;
end $$;

update staff_members s set name = v.name, short_name = v.short_name, tier = v.tier, active = v.active, customer_selectable = v.sel
  from tenants t,
       (values ('db1ea5f3-fea5-4732-817f-e129ffcb09bb'::uuid, 'Оюунсүрэн',  'Оюунаа',      'Мастер үсчин',    true,  true),
               ('31d9b688-b198-4459-b37f-8848a5b2a50b'::uuid, 'Бадамцэцэг', 'Бадмаа',      'Мастер үсчин',    true,  true),
               ('40558cdc-d511-4b9d-98c4-e308e3a448aa'::uuid, 'Уянга',      null::text,    '1-р зэрэг үсчин', true,  true),
               ('2b4b2be6-1b87-451d-a14d-8b25930ba86e'::uuid, 'Батзаяа',    null::text,    '1-р зэрэг үсчин', true,  true),
               ('3aea826a-3aa3-4285-902e-50c64f7b2120'::uuid, 'Ананд',      null::text,    'Мастер үсчин',    false, false),
               ('780cb42d-3a2b-462e-b042-660820e5524e'::uuid, 'Отгонжаргал', null::text,   '1-р зэрэг үсчин', true,  true),
               ('d4f2451a-5ae6-4e9b-8ba2-cfb3a133e7df'::uuid, 'Г. Мөнхзаяа', null::text,   'Маникюр мэргэжилтэн', true, true))
       as v(id, name, short_name, tier, active, sel)
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and s.id = v.id;

delete from staff_members s using tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and s.name = 'Chimgee';

update knowledge_documents k
   set body = replace(k.body, 'Oyunaa Яармаг салбарт ажилладаг.', 'Оюунаа Яармаг салбарт ажилладаг.'),
       updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Салбарууд';

delete from knowledge_documents k using tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Үсчдийн нэр';

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and md5(body) = '5393956616f9edb8b5bad7eb55fe6713') then
    raise exception 'read-back: «Салбарууд» is not the text read on 2026-10-03';
  end if;
  -- The same pin as the forward file's precondition: every column it changed, NULLs included.
  if (select count(*) from staff_members s join (values
        ('db1ea5f3-fea5-4732-817f-e129ffcb09bb'::uuid, 'Оюунсүрэн',   'Оюунаа',   'Мастер үсчин',        true,  true),
        ('31d9b688-b198-4459-b37f-8848a5b2a50b'::uuid, 'Бадамцэцэг',  'Бадмаа',   'Мастер үсчин',        true,  true),
        ('40558cdc-d511-4b9d-98c4-e308e3a448aa'::uuid, 'Уянга',       null::text, '1-р зэрэг үсчин',     true,  true),
        ('2b4b2be6-1b87-451d-a14d-8b25930ba86e'::uuid, 'Батзаяа',     null::text, '1-р зэрэг үсчин',     true,  true),
        ('3aea826a-3aa3-4285-902e-50c64f7b2120'::uuid, 'Ананд',       null::text, 'Мастер үсчин',        false, false),
        ('780cb42d-3a2b-462e-b042-660820e5524e'::uuid, 'Отгонжаргал', null::text, '1-р зэрэг үсчин',     true,  true),
        ('d4f2451a-5ae6-4e9b-8ba2-cfb3a133e7df'::uuid, 'Г. Мөнхзаяа', null::text, 'Маникюр мэргэжилтэн', true,  true))
        as v(id, name, short_name, tier, active, sel)
        on s.id = v.id and s.tenant_id = t and s.name = v.name and s.short_name is not distinct from v.short_name
       and s.tier = v.tier and s.active = v.active and s.customer_selectable = v.sel) <> 7
     or exists (select 1 from staff_members where tenant_id = t and name = 'Chimgee') then
    raise exception 'read-back: staff_members are not the rows read on 2026-10-03';
  end if;
end $$;

commit;
