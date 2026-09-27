-- Founder's approvals of 2026-09-27 (D-152).
--
--  1. The media hand-off line for BOTH DalaTech and Tara, reviewed. A photo, a video or a
--     link to one gets it, and the conversation goes to staff (handover/media.ts). The kind
--     is model-invisible, so the row moves no canned_hash and is served from the next
--     message on, without a republish.
--  2. Tara's rename is finished: the appended «Шинэ мэдээллийг удахгүй хүргэнэ» line
--     (tara_rebrand) is switched off; the one answer about Matrix is the founder's line;
--     the first line of the «Салбарууд» KB document matches it (reaches the model at the
--     next publish).
begin;
create temp table notice(slug text) on commit drop;
insert into notice values ('dalatech'), ('matrix-eco-salon');

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'handover_notice', 'mn-MN',
       normalize('Баярлалаа! Таны илгээсэн зураг, бичлэг, холбоосыг манай ажилтан үзээд удахгүй хариулна 😊', NFC),
       'founder', now()
  from tenants t join notice n on n.slug = t.slug
on conflict (tenant_id, kind, locale) do update
  set body = excluded.body, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at;

create temp table tara on commit drop as select id from tenants where slug = 'matrix-eco-salon';

update deterministic_replies d
   set body = normalize('Тийм ээ, Matrix Eco Salon одоо Tara Salon нэртэй болсон.', NFC)
  from tara where d.tenant_id = tara.id and d.intent = 'tara_name';
update deterministic_replies d set enabled = false
  from tara where d.tenant_id = tara.id and d.intent = 'tara_rebrand';

update knowledge_documents k
   set body = normalize(replace(k.body, 'Манай салон одоо Tara Salon нэртэй болсон.',
                                'Matrix Eco Salon одоо Tara Salon нэртэй болсон.'), NFC),
       updated_at = now()
  from tara where k.tenant_id = tara.id and k.title = normalize('Салбарууд', NFC);

update reply_cases r
   set expected_body = normalize('Тийм ээ, Matrix Eco Salon одоо Tara Salon нэртэй болсон.', NFC)
  from tara where r.tenant_id = tara.id and r.expected_body like '%Шинэ мэдээллийг удахгүй хүргэнэ%';

insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active)
select tara.id, 'facebook_page', normalize('matrix salon mun uu', NFC),
       normalize('Тийм ээ, Matrix Eco Salon одоо Tara Salon нэртэй болсон.', NFC),
       array[]::text[], array[]::text[], 'D-152 founder 2026-09-27: the one answer about Matrix, exact', true
  from tara
 where not exists (select 1 from reply_cases r where r.tenant_id = tara.id and r.customer_message = normalize('matrix salon mun uu', NFC));

do $$ declare n int; begin
  select count(*) into n from canned_responses c join tenants t on t.id = c.tenant_id
   where c.kind = 'handover_notice' and c.reviewed_at is not null and t.slug in ('dalatech', 'matrix-eco-salon');
  if n <> 2 then raise exception 'expected 2 reviewed notices, found %', n; end if;
  select count(*) into n from deterministic_replies d join tenants t on t.id = d.tenant_id
   where t.slug = 'matrix-eco-salon' and d.enabled and d.body like '%Шинэ мэдээллийг%';
  if n <> 0 then raise exception '% enabled rows still say «Шинэ мэдээллийг»', n; end if;
  select count(*) into n from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'matrix-eco-salon' and k.title = 'Салбарууд' and k.body like 'Matrix Eco Salon одоо Tara Salon нэртэй болсон.%';
  if n <> 1 then raise exception 'Салбарууд first line not updated (% rows)', n; end if;
  select count(*) into n from reply_cases r join tenants t on t.id = r.tenant_id
   where t.slug = 'matrix-eco-salon' and r.active and r.expected_body like '%Шинэ мэдээллийг%';
  if n <> 0 then raise exception '% reply cases still expect the old line', n; end if;
end $$;
commit;
