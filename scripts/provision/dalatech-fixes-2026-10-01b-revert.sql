-- Revert of dalatech-fixes-2026-10-01b.sql (D-172): every row it changed goes back to what
-- it held before, byte for byte, and the rows it added are removed.
--
-- NOTE: this restores the price overview's pieces to «Вира сард 350,000₮», which is WRONG
-- since 2026-10-01 (D-171 set Вира to 250,000₮). Run it only to undo this file as a whole,
-- and publish nothing for DalaTech until the overview is fixed again.
begin;

create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
do $$ begin
  if (select count(*) from dt) <> 1 then raise exception 'tenant dalatech not found exactly once'; end if;
end $$;

create temp table ren (old text, new text) on commit drop;
insert into ren values
  (normalize('Дали — AI хүлээн авагч', NFC), normalize('Дали — Харилцагчийн менежер', NFC)),
  (normalize('Нова — сануулга, SMS', NFC), normalize('Нова — Захиалгын менежер', NFC)),
  (normalize('Вира — маркетинг менежер', NFC), normalize('Вира — Маркетинг менежер', NFC)),
  (normalize('Ора — хувийн туслах', NFC), normalize('Ора — Хувийн туслах', NFC)),
  (normalize('Эхо — утасны оператор', NFC), normalize('Эхо — Утасны оператор', NFC));

-- Added rows first (the fixed reply's cases name it in their note).
delete from reply_cases r using dt where r.tenant_id = dt.id and r.note like 'D-172: «what is Дали»%';
delete from deterministic_replies d using dt where d.tenant_id = dt.id and d.intent = 'dali_about';

-- Case 154 back to the fixed reply's body alone.
update reply_cases r
   set expected_body = x.body,
       note = nullif(replace(r.note, ' The question names Ора, so the coming-soon line is appended (D-172).', ''), '')
  from dt, deterministic_replies x
 where r.tenant_id = dt.id and r.active and x.tenant_id = dt.id and x.intent = 'extra_user_price'
   and r.customer_message = normalize('Орагийн нэмэлт хэрэглэгч хэд вэ?', NFC)
   and r.note like '%(D-172).%';

update reply_cases r
   set must_include = array_replace(r.must_include, normalize('Харилцагчийн менежер', NFC), normalize('хүлээн авагч', NFC)),
       note = nullif(replace(r.note, ' Answered by dali_about from 2026-10-01 (D-172).', ''), '')
  from dt where r.tenant_id = dt.id and r.note like '% Answered by dali_about from 2026-10-01 (D-172).%';

do $$
declare x record;
begin
  for x in select old, new from ren loop
    update reply_cases r set expected_body = replace(r.expected_body, '💬 ' || x.new || ':', '💬 ' || x.old || ':')
      from dt where r.tenant_id = dt.id and r.note like '% Renamed 2026-10-01 (D-172).%';
    update deterministic_replies d
       set body = replace(d.body, '💬 ' || x.new || ':', '💬 ' || x.old || ':'),
           items = replace(d.items::text, '💬 ' || x.new || ':', '💬 ' || x.old || ':')::jsonb
      from dt where d.tenant_id = dt.id and d.intent = 'price_overview';
  end loop;
end $$;

update reply_cases r
   set must_include = array_replace(r.must_include, normalize('💬 Дали — Харилцагчийн менежер: сард 250,000₮', NFC),
                                    normalize('💬 Дали — AI хүлээн авагч: сард 250,000₮', NFC)),
       note = nullif(replace(r.note, ' Renamed 2026-10-01 (D-172).', ''), '')
  from dt where r.tenant_id = dt.id and r.note like '% Renamed 2026-10-01 (D-172).%';

update deterministic_replies d
   set items = replace(replace(d.items::text,
                 normalize('маркетинг менежер: сард 250,000₮', NFC), normalize('маркетинг менежер: сард 350,000₮', NFC)),
                 normalize('Вира сард 250,000₮', NFC), normalize('Вира сард 350,000₮', NFC))::jsonb
  from dt where d.tenant_id = dt.id and d.intent = 'price_overview';

update knowledge_documents k set title = replace(k.title, r.new, r.old), updated_at = now()
  from dt, ren r where k.tenant_id = dt.id and starts_with(k.title, r.new || ' (');

update services s set name = r.old from dt, ren r where s.tenant_id = dt.id and s.name = r.new;

do $$
declare tid uuid := (select id from tenants where slug = 'dalatech');
begin
  if exists (select 1 from services where tenant_id = tid and name ~ '(Харилцагчийн менежер|Захиалгын менежер|— Маркетинг менежер|— Хувийн туслах|— Утасны оператор)')
     or exists (select 1 from knowledge_documents where tenant_id = tid and title ~ '(Харилцагчийн менежер|Захиалгын менежер|— Маркетинг менежер|— Хувийн туслах|— Утасны оператор)')
     or exists (select 1 from deterministic_replies where tenant_id = tid
                 and (intent = 'dali_about' or (body || coalesce(items::text, '')) ~ '(Харилцагчийн менежер|Захиалгын менежер|— Маркетинг менежер|— Хувийн туслах|— Утасны оператор)'))
     or exists (select 1 from reply_cases where tenant_id = tid and active and note like '%D-172%') then
    raise exception 'the revert did not restore every row';
  end if;
  if (select count(*) from services where tenant_id = tid
       and name in (normalize('Дали — AI хүлээн авагч', NFC), normalize('Нова — сануулга, SMS', NFC),
                    normalize('Вира — маркетинг менежер', NFC), normalize('Ора — хувийн туслах', NFC),
                    normalize('Эхо — утасны оператор', NFC))) <> 5
     or (select count(*) from deterministic_replies where tenant_id = tid and intent = 'price_overview'
          and position(normalize('"Вира сард 350,000₮"', NFC) in items::text) > 0
          and position(normalize('💬 Дали — AI хүлээн авагч:', NFC) in body) = 1) <> 1 then
    raise exception 'the revert did not bring back the old names and the overview as they were';
  end if;
end $$;

commit;
