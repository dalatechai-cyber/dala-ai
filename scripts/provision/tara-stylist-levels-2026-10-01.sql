-- NOT APPLIED. WAITS FOR THE FOUNDER'S APPROVAL OF THE WORDING (D-169).
-- Tara Salon — Яармаг: the stylist-level reply and document name all three levels, SPECIAL,
-- Мастер and 1-р зэрэг (founder, 2026-10-01), and as before never recommend a higher level.
-- The drafted wording and what changed: prompt/drafts/tara_stylist_levels.mn.txt.
--
-- Apply it only after approving that wording, right after tara-price-list-2026-10-01.sql and
-- before the dry run, in the same SQL editor session. Nothing here is a canned row, so it adds
-- no `canned_stale` window of its own; the document reaches customers at the publish, the fixed
-- reply as soon as this commits. tara-price-list-2026-10-01-revert.sql also undoes this file.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from deposit_rules where tenant_id = t and applies_to = 'SPECIAL үсчин') then
    raise exception 'apply tara-price-list-2026-10-01.sql first';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'stylist_tier'
                 and body = 'Мастер болон 1-р зэргийн үсчний ялгаа нь зэрэглэл болон үнэд байдаг. Аль зэрэглэлийн үсчинд үйлчлүүлэхээ та өөрөө сонгоно. Ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.') then
    raise exception 'stylist_tier is not the approved line read on 2026-10-01 (or this file is applied)';
  end if;
  if not exists (select 1 from knowledge_documents where tenant_id = t and title = 'Мастер ба 1-р зэргийн үсчин'
                 and body like 'Мастер болон 1-р зэргийн үсчний ялгаа нь зэрэглэл болон үнэд байдаг.%') then
    raise exception 'the stylist-level document is not the one read on 2026-10-01';
  end if;
end $$;

-- The fixed reply: «SPECIAL, » added in front; the rest is the approved line byte for byte.
-- Matcher words for SPECIAL added beside «мастер».
update deterministic_replies d
   set body = 'SPECIAL, Мастер болон 1-р зэргийн үсчний ялгаа нь зэрэглэл болон үнэд байдаг. Аль зэрэглэлийн үсчинд үйлчлүүлэхээ та өөрөө сонгоно. Ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.',
       stems = d.stems || array['special', 'спешл', 'спешиал']::text[]
  from tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent = 'stylist_tier';

-- The document: the same change to its title and first line. «Салон зэрэглэлүүдийг хооронд нь
-- харьцуулж дүгнэдэггүй.» (never recommends a level) stays as it is.
update knowledge_documents k
   set title = 'SPECIAL, Мастер ба 1-р зэргийн үсчин',
       body = replace(k.body, 'Мастер болон 1-р зэргийн үсчний ялгаа', 'SPECIAL, Мастер болон 1-р зэргийн үсчний ялгаа'),
       updated_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and k.tenant_id = t.id and k.title = 'Мастер ба 1-р зэргийн үсчин';

-- Exact case: the fixed reply answers a SPECIAL question with the new line, no model.
insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, 'SPECIAL үсчин', d.body, 'D-169: the stylist-level reply names all three levels (founder 2026-10-01)'
  from tenants t join deterministic_replies d on d.tenant_id = t.id and d.intent = 'stylist_tier'
 where t.slug = 'matrix-eco-salon';

commit;
