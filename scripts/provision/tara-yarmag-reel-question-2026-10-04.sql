-- NOT APPLIED. Tara Яармаг (matrix-eco-salon): a shared reel or a video and «how much?» is
-- answered by Дали the way a photo is (founder, 2026-10-04, D-176 addendum «the reel line»). This
-- row switches it on for this tenant only; without it a reel, a video or a link to one goes to
-- staff exactly as before (D-152).
--
-- The row is the question a customer who sends a video, a reel or a link to one (with no words,
-- a price ask, or only a greeting) is asked. Its bytes are the line the founder APPROVED AS
-- WRITTEN on 2026-10-04 (prompt/drafts/tara_quality_2026-10-03.mn.txt, item 7), byte for byte:
--   «Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.»
-- A named service gets its price from the rows; staff get the chat only when the answer names
-- nothing the rows know, or another reel comes 10 to 60 minutes after the question.
--
-- Independent of tara-yarmag-photo-question-2026-10-04.sql: either may be applied alone. With both,
-- the two questions are one question (a reel after the photo question is a second picture).
--
-- ORDER (each step refuses or breaks replies if skipped):
--   1. Deploy the code (MODEL_INVISIBLE_KINDS has `reel_price_question`); otherwise this row
--      moves `canned_hash` and every DM reply refuses until a republish.
--   2. Apply migration 0083 (registers the kind; the D-163 trigger skips it). Before it the
--      insert is refused (unknown kind / model-visible to the trigger).
--   3. This file. Model-invisible: no republish needed for the row; the reply cases are checked
--      by the next build and publish.
-- An UNREVIEWED row of any kind refuses every reply (`canned_response_unreviewed`), so the row is
-- inserted signed or not at all.
--
-- Undo: the -revert.sql beside it (deleting the row switches the reel question off at once).
begin;

do $$
declare t uuid; clash int;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if not exists (select 1 from canned_response_kinds where kind = 'reel_price_question') then
    raise exception 'apply migration 0083 first (and deploy its code before it)';
  end if;
  if exists (select 1 from canned_responses where tenant_id = t and kind = 'reel_price_question') then
    raise exception 'this file is already applied';
  end if;
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'handover_notice' and reviewed_at is not null) then
    raise exception 'the hand-off after one question needs the reviewed handover_notice';
  end if;
  -- A Page reply case that sends a video link and expects the hand-off notice (D-152's probe)
  -- would now get the question: the build would fail. None was known on 2026-10-04; if one
  -- exists, change it to expect this row first, deliberately. The pattern follows VIDEO_PATHS
  -- (`handover/media.ts`); a website case is untouched (the question is never asked there).
  select count(*) into clash
    from reply_cases r join canned_responses n on n.tenant_id = r.tenant_id and n.kind = 'handover_notice'
   where r.tenant_id = t and coalesce(r.channel, 'facebook_page') <> 'web'
     and ((r.expected_body is not null and btrim(r.expected_body) = btrim(n.body)) or n.body = any(r.must_include))
     and r.customer_message ~* '(fb\.watch/|youtu\.be/|(facebook|fb)\.com/(share/[rv]/|reels?|watch|videos/)|instagram\.com/(reels?|tv)/|instagr\.am/reel/|(vm|vt)\.tiktok\.com/|tiktok\.com/(@[^/ ]+/video/|t/)|youtube\.com/(watch|shorts/|live/))';
  if clash > 0 then
    raise exception '% reply case(s) send a video link and expect the hand-off notice; update them to expect the reel question first', clash;
  end if;
end $$;

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'reel_price_question', t.default_locale,
       'Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.',
       'founder', now()
  from tenants t
 where t.slug = 'matrix-eco-salon';

-- Reply cases. A shared reel's attachment cannot be a reply case (cases carry no attachment), but a
-- reel shared as a link can (Tara's webhook 979 was one), and so can the text after the question.
-- None of these reaches the model. Expected bodies are read from the rows, so a later wording
-- change moves them together.
insert into reply_cases (tenant_id, history, customer_message, expected_body, must_include, must_not_include, note)
select t.id,
       case when v.after_question
            then jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'Сайн байна уу'),
                                   jsonb_build_object('role', 'assistant', 'content', q.body))
            else jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'Сайн байна уу'),
                                   jsonb_build_object('role', 'assistant', 'content', 'Сайн байна уу! Танд юугаар туслах вэ?'))
       end,
       v.msg,
       case v.expect when 'question' then q.body when 'notice' then n.body end,
       v.inc::text[], v.exc::text[], v.note
  from tenants t
  join canned_responses q on q.tenant_id = t.id and q.kind = 'reel_price_question'
  join canned_responses n on n.tenant_id = t.id and n.kind = 'handover_notice'
  join (values
    ('https://www.facebook.com/share/r/1AbCdEfGh/', false, 'question', '{}', '{}',
     'reel question 2026-10-04 (exact): a reel shared as a link alone gets the reel question, not staff (D-176)'),
    ('https://www.facebook.com/share/r/1AbCdEfGh/ hed ve', false, 'question', '{}', '{}',
     'reel question 2026-10-04 (exact): a reel link with «how much?» gets the reel question, not staff (D-176)'),
    ('энэ шиг болгомоор байна', true, 'notice', '{}', '{}',
     'reel question 2026-10-04 (exact): after the question, words naming nothing the rows know go to staff (D-176)'),
    ('hed ve', true, 'notice', '{}', '{}',
     'reel question 2026-10-04 (exact): «how much?» again after reading the question goes to staff, not a second question'),
    ('Будаг хэд вэ', true, null, '{"Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?"}', '{"ажилтан үзээд"}',
     'reel question 2026-10-04: the answer naming the service gets the dye rows from data, not staff')
  ) as v(msg, after_question, expect, inc, exc, note) on true
 where t.slug = 'matrix-eco-salon'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.note like 'reel question 2026-10-04%');

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'matrix-eco-salon';
  if (select count(*) from canned_responses where tenant_id = t and kind = 'reel_price_question' and reviewed_at is not null
        and body = 'Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.') <> 1
     or (select count(*) from reply_cases where tenant_id = t and note like 'reel question 2026-10-04%') <> 5 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
