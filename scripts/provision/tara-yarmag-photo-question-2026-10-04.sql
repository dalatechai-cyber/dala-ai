-- NOT APPLIED. Tara Яармаг (matrix-eco-salon): a photo and «how much?» is answered by Дали
-- (founder, 2026-10-04, D-176; reverses D-152 for this case). This row switches it on for this
-- tenant only; without it the code keeps D-152 exactly.
--
-- The row is the question a customer who sends a photo (with no words, or with a price ask) is
-- asked: which service, the hair length. Its bytes are Tara's APPROVED `image_received` line,
-- reviewed by the founder (D-076 addendum), word for word:
--   «Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.»
-- so no new sentence reaches a customer. Its new USE (the one question after a photo) was
-- APPROVED by the founder on 2026-10-04 (prompt/drafts/tara_quality_2026-10-03.mn.txt, item 4).
-- The reel and video question is its own row and file: tara-yarmag-reel-question-2026-10-04.sql.
--
-- ORDER (each step refuses or breaks replies if skipped):
--   1. Deploy the code (MODEL_INVISIBLE_KINDS has `photo_price_question`); otherwise this row
--      moves `canned_hash` and every DM reply refuses until a republish.
--   2. Apply migration 0083 (registers the kind; the D-163 trigger skips it). Before it the
--      insert is refused (unknown kind / model-visible to the trigger).
--   3. This file. Model-invisible: no republish needed for the row; the reply cases are checked
--      by the next build and publish.
-- An UNREVIEWED row of any kind refuses every reply (`canned_response_unreviewed`), so the row is
-- inserted signed or not at all.
--
-- Undo: the -revert.sql beside it (deleting the row switches D-176 off for this tenant at once).
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from canned_response_kinds where kind = 'photo_price_question') then
    raise exception 'apply migration 0083 first (and deploy its code before it)';
  end if;
  if exists (select 1 from canned_responses where tenant_id = t and kind = 'photo_price_question') then
    raise exception 'this file is already applied';
  end if;
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'image_received' and reviewed_at is not null
                 and body = 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.') then
    raise exception 'image_received is not the approved line read on 2026-10-04';
  end if;
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'handover_notice' and reviewed_at is not null) then
    raise exception 'the hand-off after one question needs the reviewed handover_notice';
  end if;
end $$;

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'photo_price_question', t.default_locale, c.body, 'founder', now()
  from tenants t
  join canned_responses c on c.tenant_id = t.id and c.kind = 'image_received' and c.locale = t.default_locale
 where t.slug = 'matrix-eco-salon';

-- Reply cases. The photo itself cannot be a reply case (cases carry no attachment); the text
-- that follows the question can, and none of these reaches the model. Expected bodies are read
-- from the rows, so a later wording change moves them together.
insert into reply_cases (tenant_id, history, customer_message, expected_body, must_include, must_not_include, note)
select t.id, jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'Сайн байна уу'),
                               jsonb_build_object('role', 'assistant', 'content', q.body)),
       v.msg, case when v.exact then n.body end, v.inc::text[], v.exc::text[], v.note
  from tenants t
  join canned_responses q on q.tenant_id = t.id and q.kind = 'photo_price_question'
  join canned_responses n on n.tenant_id = t.id and n.kind = 'handover_notice'
  join (values
    ('энэ шиг болгомоор байна', true, '{}', '{}',
     'photo question 2026-10-04 (exact): after the question, words naming nothing the rows know go to staff (D-176)'),
    ('hed ve', true, '{}', '{}',
     'photo question 2026-10-04 (exact): «how much?» again after reading the question goes to staff, not a second question'),
    ('Будаг хэд вэ', false, '{"Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?"}', '{"ажилтан үзээд"}',
     'photo question 2026-10-04: the answer naming the service gets the dye rows from data, not staff')
  ) as v(msg, exact, inc, exc, note) on true
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.note like 'photo question 2026-10-04%');

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from canned_responses where tenant_id = t and kind = 'photo_price_question' and reviewed_at is not null) <> 1
     or (select count(*) from reply_cases where tenant_id = t and note like 'photo question 2026-10-04%') <> 3 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
