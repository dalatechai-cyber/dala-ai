-- ONLY IF NEEDED. Undoes tara-yarmag-answers-2026-10-04.sql: the hand-off line returns to the
-- bytes read on 2026-10-04 (signed again, it was the founder's approved line), the three fixed
-- replies, FAQs and reply cases go. A D-163 edit: publish matrix-eco-salon at once after COMMIT.
begin;

set local dala.canned_edit = 'republish';

update canned_responses c
   set body = normalize('Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 91005498 дугаараар холбогдоно уу.', NFC),
       reviewed_by = 'founder', reviewed_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'handoff' and c.locale = t.default_locale
   and c.body = 'Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.';

delete from deterministic_replies d using tenants t
 where t.slug = 'matrix-eco-salon' and d.tenant_id = t.id and d.intent in ('deposit_deducted', 'loan_apps', 'dye_brand');

delete from faqs f using tenants t
 where t.slug = 'matrix-eco-salon' and f.tenant_id = t.id
   and f.question in ('Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу?', 'Зээлийн аппаар төлбөр төлж болох уу?', 'Ямар брэндийн будаг хэрэглэдэг вэ?');

delete from reply_cases r using tenants t
 where t.slug = 'matrix-eco-salon' and r.tenant_id = t.id and r.note like 'answers 2026-10-04%';

commit;
