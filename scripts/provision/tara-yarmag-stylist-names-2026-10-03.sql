-- NOT APPLIED. WAITS FOR THE FOUNDER'S APPROVAL OF THE WORDING (prompt/drafts/tara_stylist_names.mn.txt).
-- Tara Salon — Яармаг (slug matrix-eco-salon): the hairdressers' new short Latin names
-- (founder, 2026-10-03; round facts «Stylists are shown EVERYWHERE by these short names in
-- Latin letters»), with their levels, and the old names customers type kept on the same person.
--
-- What it does, each against the rows read read-only on 2026-10-03 (the DO block refuses
-- anything else):
--   staff_members  Оюунсүрэн  -> Oyunaa  (short «Оюунаа», unchanged), Мастер -> SPECIAL үсчин (founder)
--                  Бадамцэцэг -> Badamaa (short «Бадмаа», unchanged), Мастер үсчин (kept)
--                  Уянга      -> Uyanga  (short «Уянга»), 1-р зэрэг үсчин (kept)
--                  Батзаяа    -> Zaya    (short «Заяа»),  1-р зэрэг үсчин (kept)
--                  Ананд      -> Anand   (short «Ананд»), Мастер үсчин (kept); switched ON
--                                (was inactive; founder 2026-10-03: in the Яармаг list, the only man)
--                  Chimgee    ADDED      (short «Чимгээ»; was Уранчимэг), 1-р зэрэг үсчин
--                                (the website's level; dala-ai had no row for her)
--                  Отгонжаргал switched OFF: not in the founder's confirmed list (flagged)
--                  Г. Мөнхзаяа (Маникюр баг) switched OFF: manicure is off at Tara (founder rule)
--   knowledge      «Салбарууд»: «Оюунаа Яармаг салбарт ажилладаг.» -> «Oyunaa Яармаг салбарт ажилладаг.»
--                  «Үсчдийн нэр» ADDED: the old Cyrillic names, so a customer who types
--                  «Оюунсүрэн» or «Уранчимэг» is matched to the same person (rows, not a
--                  transliterator: CLAUDE.md, D-067). The short names customers actually type
--                  («Оюунаа», «Бадмаа» …) are each person's short_name, which the roster
--                  renders «Oyunaa (Оюунаа)» (0019).
--
-- No canned_responses row names a hairdresser (read 2026-10-03), so this file changes none
-- and the canned-edit guard (0074/0075, D-163) is not engaged. Fixed replies, FAQs, reply
-- cases, comment rules, out-of-scope topics and service aliases name no hairdresser either.
--
-- Apply in one SQL editor session, then publish Яармаг AT ONCE (the roster and the knowledge
-- reach customers only through the compiled prompt):
--     node scripts/publish/tenant.ts --slug matrix-eco-salon            # dry run
--     node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
-- Undo: tara-yarmag-stylist-names-2026-10-03-revert.sql, then publish again.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  -- The state read on 2026-10-03, row by row and column by column (every column the revert
  -- writes back is pinned here, NULLs included). Anything else: stop, re-read, re-plan.
  if (select count(*) from staff_members s join (values
        ('db1ea5f3-fea5-4732-817f-e129ffcb09bb'::uuid, 'Оюунсүрэн',   'Оюунаа',   'Эмэгтэй үсчид', 'Мастер үсчин',        true,  true),
        ('31d9b688-b198-4459-b37f-8848a5b2a50b'::uuid, 'Бадамцэцэг',  'Бадмаа',   'Эмэгтэй үсчид', 'Мастер үсчин',        true,  true),
        ('40558cdc-d511-4b9d-98c4-e308e3a448aa'::uuid, 'Уянга',       null::text, 'Эмэгтэй үсчид', '1-р зэрэг үсчин',     true,  true),
        ('2b4b2be6-1b87-451d-a14d-8b25930ba86e'::uuid, 'Батзаяа',     null::text, 'Эмэгтэй үсчид', '1-р зэрэг үсчин',     true,  true),
        ('3aea826a-3aa3-4285-902e-50c64f7b2120'::uuid, 'Ананд',       null::text, 'Эрэгтэй үсчид', 'Мастер үсчин',        false, false),
        ('780cb42d-3a2b-462e-b042-660820e5524e'::uuid, 'Отгонжаргал', null::text, 'Эмэгтэй үсчид', '1-р зэрэг үсчин',     true,  true),
        ('d4f2451a-5ae6-4e9b-8ba2-cfb3a133e7df'::uuid, 'Г. Мөнхзаяа', null::text, 'Маникюр баг',   'Маникюр мэргэжилтэн', true,  true))
        as v(id, name, short_name, group_name, tier, active, sel)
        on s.id = v.id and s.tenant_id = t and s.name = v.name and s.short_name is not distinct from v.short_name
       and s.group_name is not distinct from v.group_name and s.tier = v.tier and s.active = v.active
       and s.customer_selectable = v.sel) <> 7 then
    raise exception 'staff_members are not the rows read on 2026-10-03 (or this file is applied)';
  end if;
  if exists (select 1 from staff_members where tenant_id = t and name in ('Oyunaa', 'Badamaa', 'Uyanga', 'Zaya', 'Chimgee', 'Anand', 'Уранчимэг')) then
    raise exception 'a new name is already in staff_members (this file is applied, or someone added it)';
  end if;
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд'
                 and md5(body) = '5393956616f9edb8b5bad7eb55fe6713') then
    raise exception 'the «Салбарууд» document is not the one read on 2026-10-03';
  end if;
  if exists (select 1 from knowledge_documents where tenant_id = t and title = 'Үсчдийн нэр') then
    raise exception '«Үсчдийн нэр» already exists';
  end if;
end $$;

-- The names and levels. Rows are addressed by id AND tenant, so nothing of another tenant moves.
update staff_members s set name = v.name, short_name = v.short_name, tier = v.tier
  from tenants t,
       (values ('db1ea5f3-fea5-4732-817f-e129ffcb09bb'::uuid, 'Oyunaa',  'Оюунаа', 'SPECIAL үсчин'),
               ('31d9b688-b198-4459-b37f-8848a5b2a50b'::uuid, 'Badamaa', 'Бадмаа', 'Мастер үсчин'),
               ('40558cdc-d511-4b9d-98c4-e308e3a448aa'::uuid, 'Uyanga',  'Уянга',  '1-р зэрэг үсчин'),
               ('2b4b2be6-1b87-451d-a14d-8b25930ba86e'::uuid, 'Zaya',    'Заяа',   '1-р зэрэг үсчин')) as v(id, name, short_name, tier)
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and s.id = v.id;

-- Anand: back on, selectable like every other active hairdresser. Group «Эрэгтэй үсчид» kept.
update staff_members s set name = 'Anand', short_name = 'Ананд', active = true, customer_selectable = true
  from tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id and s.id = '3aea826a-3aa3-4285-902e-50c64f7b2120';

-- Chimgee (was Уранчимэг): new row, shaped like the other women's rows.
insert into staff_members (tenant_id, name, short_name, group_name, tier, customer_selectable, affects_price, active)
select t.id, 'Chimgee', 'Чимгээ', 'Эмэгтэй үсчид', '1-р зэрэг үсчин', true, false, true
  from tenants t where t.slug = 'matrix-eco-salon';

-- Not shown: Отгонжаргал (not in the founder's list) and the manicurist (manicure is off).
-- Switched off, never deleted: the rows stay for the revert and the history.
update staff_members s set active = false, customer_selectable = false
  from tenants t
 where t.slug = 'matrix-eco-salon' and s.tenant_id = t.id
   and s.id in ('780cb42d-3a2b-462e-b042-660820e5524e', 'd4f2451a-5ae6-4e9b-8ba2-cfb3a133e7df');

-- «Салбарууд»: only the hairdresser's name changes; every other line is the approved text.
update knowledge_documents k
   set body = replace(k.body, 'Оюунаа Яармаг салбарт ажилладаг.', 'Oyunaa Яармаг салбарт ажилладаг.'),
       updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Салбарууд';

-- The old names, as rows the model reads. DRAFT wording (prompt/drafts/tara_stylist_names.mn.txt).
insert into knowledge_documents (tenant_id, title, body, source)
select t.id, 'Үсчдийн нэр',
       E'Үсчдийн нэрийг латин үсгээр бичнэ: Oyunaa, Badamaa, Uyanga, Zaya, Chimgee, Anand.\n'
       || E'Оюунсүрэн, Оюунаа гэвэл Oyunaa.\n'
       || E'Бадамцэцэг, Бадмаа гэвэл Badamaa.\n'
       || E'Уянга гэвэл Uyanga.\n'
       || E'Батзаяа, Заяа гэвэл Zaya.\n'
       || E'Уранчимэг, Чимгээ гэвэл Chimgee.\n'
       || 'Ананд гэвэл Anand.',
       'founder 2026-10-03'
  from tenants t where t.slug = 'matrix-eco-salon';

-- Read back inside the transaction: six active hairdressers, the two switched off, one new document.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from staff_members where tenant_id = t and active and name in ('Oyunaa', 'Badamaa', 'Uyanga', 'Zaya', 'Chimgee', 'Anand')) <> 6 then
    raise exception 'read-back: six active hairdressers expected';
  end if;
  if exists (select 1 from staff_members where tenant_id = t and active and name in ('Отгонжаргал', 'Г. Мөнхзаяа')) then
    raise exception 'read-back: Отгонжаргал and the manicurist must be off';
  end if;
  if (select tier from staff_members where tenant_id = t and name = 'Oyunaa') <> 'SPECIAL үсчин' then
    raise exception 'read-back: Oyunaa is SPECIAL';
  end if;
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Салбарууд' and body like '%Oyunaa Яармаг салбарт ажилладаг.%') then
    raise exception 'read-back: «Салбарууд» not updated';
  end if;
end $$;

commit;
