-- NOT APPLIED. Tara Яармаг (matrix-eco-salon): the salon's answers of 2026-10-04 as rows. Every
-- customer sentence here was APPROVED by the founder on 2026-10-04 (tara_quality_2026-10-03 items
-- 1-3, «both branches»); nothing new is said. Парк Од needs the same rows byte for byte in her
-- own file (D-157: never copied from this tenant's rows); see NOTES.md.
--
-- 1. The hand-off line (`handoff`), served whenever Дали cannot answer from the data (A8, F3),
--    becomes the founder's approved sentence for «anything Дали doesn't know» (answer 3):
--      «Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.»
--    Why the handoff row and not a new kind: it IS the line for "not in the data"; every guard
--    refusal, model refusal and cut reply already ends on it, so one row covers every case.
--    It drops «Уучлаарай, би энэ асуултад хариулж чадахгүй байна» and 91005498 (the founder's
--    sentence names only the shared line). `handoff` is model-visible, so this is a D-163 edit:
--    the transaction declares the republish, and the tenant is PUBLISHED AT ONCE after COMMIT.
--    The row is signed in the same statement (reviewed_by founder: his sentence, 2026-10-04).
-- 2. Three fixed replies (word-for-word facts go in fixed replies, D-174), no model:
--      deposit_deducted «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.»
--      loan_apps        «Одоогоор зээлийн аппаар төлбөр авдаггүй.»
--      dye_brand        the hand-off sentence above (answer 3: no brand line). Served with the
--                       hand-off row's bytes, it counts as a hand-off, so a person is told (F5;
--                       needs this round's code deployed: `handle.ts`, D-176's last bullet).
--    Matchers checked against this week's real phrasings and against the live rows: «Урьдчилгаа
--    төлбөр хэд вэ» (the amount) and «цагийн хуваарь» reach none of them; «Будаг хэд вэ» still
--    reaches dye_prices.
-- 3. The same three as FAQs, so the model has them when a question has several parts (E10);
--    FAQ answers are pinned (A10).
-- 4. Exact reply cases for each, and the controls.
--
-- Run as ONE transaction (psql -v ON_ERROR_STOP=1 -f, or the SQL editor), then at once:
--   node scripts/publish/tenant.ts --slug matrix-eco-salon            (dry run: diff, gates, cases)
--   node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
-- plus the founder's one --with-model dry run (D-151). Undo: the -revert.sql beside it (also a
-- D-163 edit, also published at once).
begin;

set local dala.canned_edit = 'republish';

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'handoff'
                 and body = 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 91005498 дугаараар холбогдоно уу.') then
    raise exception 'handoff is not the line read on 2026-10-04; read it again before applying';
  end if;
  if exists (select 1 from deterministic_replies where tenant_id = t and intent in ('deposit_deducted', 'loan_apps', 'dye_brand')) then
    raise exception 'this file is already applied';
  end if;
end $$;

-- 1. The hand-off line, signed in the same statement (D-163: a live row is never left unsigned).
update canned_responses c
   set body = normalize('Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.', NFC),
       reviewed_by = 'founder', reviewed_at = now()
  from tenants t
 where t.slug = 'matrix-eco-salon' and c.tenant_id = t.id and c.kind = 'handoff' and c.locale = t.default_locale;

-- 2. Fixed replies.
insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, matcher, requires_empty_history, provenance, placement, quote_services)
select t.id, v.intent, normalize(v.body, NFC), true, 'matcher', '{}'::text[], '{}'::text[], v.matcher::jsonb, false, 'tenant_confirmed', 'replace', '{}'::text[]
  from tenants t, (values
  ('deposit_deducted', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.',
   '{"mode": "all_of", "matchers": [
      {"mode": "contains_stem", "stems": ["урьдчил", "урьчил", "урдчил", "uridchil", "urichil", "urdchil", "uridchl"]},
      {"mode": "contains_stem", "stems": ["хасагд", "хасах", "хасна", "хасаад", "хасаж", "hasagd", "hasah", "hasna", "hasaad", "hasaj", "xasagd",
                                          "тооцогд", "тооцох", "тооцно", "тооцож", "tootsogd", "tootsoh", "tootsno", "tootsoj", "үнэнд", "unend", "vnend"]}]}'),
  ('loan_apps', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.',
   '{"mode": "contains_stem", "stems": ["зээл", "zeel", "storepay", "сторпэй", "lendmn", "pocketzero"]}'),
  ('dye_brand', 'Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.',
   '{"mode": "all_of", "matchers": [
      {"mode": "contains_stem", "stems": ["будаг", "будг", "будалт", "budag", "budg", "budalt"]},
      {"mode": "contains_stem", "stems": ["брэнд", "бренд", "brand", "brend", "фирм", "firm", "хэрэглэд", "heregled", "ашигладаг", "ashigladag"]}]}')
  ) as v(intent, body, matcher)
 where t.slug = 'matrix-eco-salon';

-- 3. FAQs (compiled at publish).
insert into faqs (tenant_id, question, answer, ordinal, provenance)
select t.id, normalize(v.q, NFC), normalize(v.a, NFC), v.o, 'tenant_confirmed'
  from tenants t, (values
  ('Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу?', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.', 12),
  ('Зээлийн аппаар төлбөр төлж болох уу?', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.', 13),
  ('Ямар брэндийн будаг хэрэглэдэг вэ?', 'Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.', 14)
  ) as v(q, a, o)
 where t.slug = 'matrix-eco-salon';

-- 4. Reply cases: each row answers its question exactly, with no model; the controls go
-- elsewhere. All deterministic, so every build and publish checks them.
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note)
select t.id, v.msg, v.exp, v.inc::text[], v.exc::text[], v.note
  from tenants t, (values
  ('Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.', '{}', '{}',
   'answers 2026-10-04 (exact): the deposit is deducted from the price (founder, item 1)'),
  ('uridchilgaa unendee orj tootsogdoh uu', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.', '{}', '{}',
   'answers 2026-10-04 (exact): the same, typed in Latin'),
  ('Зээлийн апп-аар төлж болох уу', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.', '{}', '{}',
   'answers 2026-10-04 (exact): no loan apps (founder, item 2)'),
  ('storepay baigaa yu', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.', '{}', '{}',
   'answers 2026-10-04 (exact): a loan app named by its brand'),
  ('Ямар брэндийн будаг хэрэглэдэг вэ', 'Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.', '{}', '{}',
   'answers 2026-10-04 (exact): the dye brand goes to staff and the shared line (founder, item 3)'),
  ('Урьдчилгаа төлбөр хэд вэ', null, '{}', '{"хасагдаж тооцогдоно"}',
   'answers 2026-10-04 (model): the deposit AMOUNT is not answered with the deduction line'),
  ('цагийн хуваарь', null, '{}', '{"зээлийн аппаар"}',
   'answers 2026-10-04 (model): «хуваарь» is not a loan question')
  ) as v(msg, exp, inc, exc, note)
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = v.msg);

-- Read back inside the transaction.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from deterministic_replies where tenant_id = t and intent in ('deposit_deducted', 'loan_apps', 'dye_brand') and enabled) <> 3
     or (select count(*) from faqs where tenant_id = t and ordinal in (12, 13, 14)) <> 3
     or not exists (select 1 from canned_responses where tenant_id = t and kind = 'handoff' and reviewed_at is not null
                    and body = 'Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.')
     or (select count(*) from reply_cases where tenant_id = t and note like 'answers 2026-10-04%') <> 7 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
-- NOW publish matrix-eco-salon (dry run, then --publish): the hand-off line moved the canned hash.
