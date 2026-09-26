-- DalaTech (tenant #0): the founder's decision of 2026-09-26 (fourth set).
--
--  6. Дали does not answer by phone: that is Эхо's job, and Эхо is not built. On 2026-09-26
--     02:23 Дали described itself to a customer as answering «Facebook, Instagram, вэбсайт
--     болон утсаар» — it had read the shared line below, which gave all four customer-facing
--     staff one channel list ending in «утсаар». «утсаар» is removed, Instagram stays (it is
--     next to be built), and Эхо leaves this list because its only channel is the phone,
--     which its own document («Эхо — Утасны оператор») already says.
--     A knowledge-base document, so it reaches customers at the next PUBLISH.
begin;

update knowledge_documents k
   set body = replace(k.body,
         normalize('- Дали, Вира, Эхо, Нова танай харилцагчидтай Facebook, Instagram, вэбсайт, утсаар монголоор өдөр шөнөгүй ярина.', NFC),
         normalize('- Дали, Вира, Нова танай харилцагчидтай Facebook, Instagram, вэбсайтаар монголоор өдөр шөнөгүй ярина.', NFC)),
       source = 'founder 2026-09-26'
  from tenants t
 where t.id = k.tenant_id and t.slug = 'dalatech' and k.title = normalize('Таван AI ажилтан — нийтлэг', NFC);

-- Refuse to commit a no-op: the line must be gone, and exactly one document must carry the new one.
do $$ begin
  if exists (select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
              where t.slug = 'dalatech' and k.body like '%утсаар%' and k.title <> normalize('Эхо — Утасны оператор (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', NFC)) then
    raise exception 'утсаар is still in a DalaTech document other than Эхо''s';
  end if;
  if (select count(*) from knowledge_documents k join tenants t on t.id = k.tenant_id
       where t.slug = 'dalatech' and k.body like '%Дали, Вира, Нова танай харилцагчидтай Facebook, Instagram, вэбсайтаар%') <> 1 then
    raise exception 'the corrected line is not in exactly one document';
  end if;
end $$;

commit;
