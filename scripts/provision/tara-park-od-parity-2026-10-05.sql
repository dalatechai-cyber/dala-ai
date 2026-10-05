-- NOT APPLIED. DRAFT for the founder (2026-10-05). Tara Salon — Парк Од (slug tara-park-od).
--
-- What Яармаг's Дали has today that Парк Од's onboarding (her form + --wording) and
-- tara-park-od-after-onboarding.sql do not give her. Found by comparing the two tenants table
-- by table on a local replica (Яармаг's rows read from Production, read-only, 2026-10-05,
-- count and md5 equal per table), after onboarding Парк Од there:
--
--   1. the photo and reel questions (`photo_price_question`, `reel_price_question`): Яармаг's
--      approved bytes (founder 2026-10-04, items 4 and 7; no branch detail in either). Without
--      them a photo or reel from her customer goes straight to staff instead of getting the one
--      question. UNREVIEWED here: they are two more lines on her wording sheet (step «sign»).
--   2. service aliases: Яармаг has 64 on the 31 services both branches share (cica, budah,
--      sor, blend, lumi, хүүхэд …); her form gave none, so «Tara perm»-style words matched but
--      every Latin or short name did not. Literal values, the same service names.
--   3. Latin spellings: Яармаг's 92 settled spellings (budag=будаг, himi=хими, une=үнэ …),
--      learned from Яармаг's customers' messages. Only the word pairs are written; the evidence
--      (customers' messages) is not copied, and «oyuna»/«oyunaa» (Яармаг's hairdresser) are
--      left out.
--   4. never-say rules: Яармаг's five (never say a Мастер hairdresser is better; never say six
--      branches), the founder's of 2026-09-24, byte for byte.
--   5. comments, as Яармаг's: her 50 comment rules (the salon template onboarding wrote,
--      disabled) switched on, the same 50 Яармаг has on (same matchers); the Page's channel with
--      comment replies on both surfaces, 20 per post per day, posts up to 30 days old, Meta's
--      default away message recognised as not a person, DALA_AI's app id and Яармаг's callback
--      slug. Comment delivery starts in SHADOW (drafts only); the founder moves it to live.
--   6. reply cases for every kind of message Яармаг's 78 cases cover and hers did not
--      (greetings, thanks, «ok», likes, «who are you», «who made you», a correction, tomorrow's
--      and holiday hours, prices by service, children's prices, deposits by level, the level
--      reply, branch, address and phone questions, the photo and reel questions), INACTIVE:
--      switched on with all her other cases before the publish dry run (docs/runbooks).
--      Яармаг-only cases have no mirror: Matrix's rename (she was never Matrix) and the
--      `park_od_branch` ones (her own branch); each mirrored case expects HER row's bytes.
--
-- ORDER: after tara-park-od-after-onboarding.sql, before the signing run of
-- scripts/onboard/tenant.ts (so the sheet carries the two new lines). Revert:
-- tara-park-od-parity-2026-10-05-revert.sql. Nothing here touches Яармаг's rows.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  if (select live_revision_id from tenants where id = t) is not null then
    raise exception 'tara-park-od has been published: this file is for a tenant still being onboarded';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'yarmag_branch') then
    raise exception 'apply tara-park-od-after-onboarding.sql first';
  end if;
  if not exists (select 1 from canned_response_kinds where kind = 'reel_price_question') then
    raise exception 'migration 0083 is missing';
  end if;
  if exists (select 1 from canned_responses where tenant_id = t and kind in ('photo_price_question', 'reel_price_question'))
     or exists (select 1 from service_aliases where tenant_id = t)
     or exists (select 1 from spellings where tenant_id = t)
     or exists (select 1 from forbidden_phrasings where tenant_id = t)
     or exists (select 1 from reply_cases where tenant_id = t and note like 'parity 2026-10-05%') then
    raise exception 'this file is already applied (or rows were added by hand)';
  end if;
  if (select count(*) from services where tenant_id = t and active) <> 31 then
    raise exception 'expected her 31 services from the form';
  end if;
  if (select count(*) from comment_rules where tenant_id = t) <> 50 or exists (select 1 from comment_rules where tenant_id = t and enabled) then
    raise exception 'expected the 50 template comment rules onboarding writes, all disabled';
  end if;
  if (select count(*) from tenant_channels where tenant_id = t and provider = 'facebook_page') <> 1 then
    raise exception 'expected exactly one facebook_page channel (onboarding with --facebook-page-id)';
  end if;
end $$;

-- 1. The photo and reel questions (Яармаг's approved bytes; signed on her wording sheet).
insert into canned_responses (tenant_id, kind, body)
select t.id, v.kind, v.body from tenants t, (values
  ('photo_price_question', 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.'),
  ('reel_price_question', 'Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.')
) as v(kind, body)
 where t.slug = 'tara-park-od';

-- 2. Service aliases (Яармаг's, on the same 31 services; literal values).
insert into service_aliases (tenant_id, service_id, alias, provenance)
select s.tenant_id, s.id, v.alias, v.provenance
  from (values
  ('CICA үсний гүний эмчилгээ', 'CICA нөхөн сэргээх', 'tenant_confirmed'),
  ('CICA үсний гүний эмчилгээ', 'CICA эмчилгээ', 'tenant_confirmed'),
  ('CICA үсний гүний эмчилгээ', 'cica', 'seeded'),
  ('CICA үсний гүний эмчилгээ', 'цика', 'seeded'),
  ('Down perm', 'down perm', 'seeded'),
  ('Hippie & Jerry curl', 'hippie', 'seeded'),
  ('Hippie & Jerry curl', 'jerry curl', 'seeded'),
  ('TARA BLEND', 'blend', 'seeded'),
  ('TARA BLEND', 'бленд', 'seeded'),
  ('TARA Lumi', 'lumi', 'seeded'),
  ('TARA Lumi', 'луми', 'seeded'),
  ('Tara perm', 'тара перм', 'seeded'),
  ('Афро хими', 'afro', 'seeded'),
  ('Афро хими', 'афро', 'seeded'),
  ('Бүтэн цайруулалт', 'tsairuul', 'seeded'),
  ('Бүтэн цайруулалт', 'цайруул', 'seeded'),
  ('Гоёлын засалт', 'goyoliin zas', 'seeded'),
  ('Гоёлын засалт', 'гоёлын зас', 'seeded'),
  ('Сэттинг хими', 'setting', 'seeded'),
  ('Сэттинг хими', 'сеттинг', 'seeded'),
  ('Сэттинг хими', 'сэттинг', 'seeded'),
  ('Усан хими', 'usan him', 'seeded'),
  ('Усан хими', 'усан хим', 'seeded'),
  ('Хуйх цэвэрлэгээ', 'huih', 'seeded'),
  ('Хуйх цэвэрлэгээ', 'хуйх', 'seeded'),
  ('Хуримын засалт', 'hurim', 'seeded'),
  ('Хуримын засалт', 'хурим', 'seeded'),
  ('Хэлбэржүүлэлт', 'helberj', 'seeded'),
  ('Хэлбэржүүлэлт', 'хэлбэрж', 'seeded'),
  ('Хэсэгчилсэн сор', 'sor', 'seeded'),
  ('Хэсэгчилсэн сор', 'сор', 'seeded'),
  ('Хүүхдийн тайралт', 'huuhd', 'seeded'),
  ('Хүүхдийн тайралт', 'huuhed', 'seeded'),
  ('Хүүхдийн тайралт', 'хүүхд', 'seeded'),
  ('Хүүхдийн тайралт', 'хүүхэд', 'seeded'),
  ('Чёлк тайралт', 'cholk', 'seeded'),
  ('Чёлк тайралт', 'чолк', 'seeded'),
  ('Чёлк тайралт', 'чёлк', 'seeded'),
  ('Шулуун хими', 'shuluun him', 'seeded'),
  ('Шулуун хими', 'шулуун хим', 'seeded'),
  ('Эмчилгээний хими', 'emchilgee him', 'seeded'),
  ('Эмчилгээний хими', 'himi', 'inferred'),
  ('Эмчилгээний хими', 'хими', 'inferred'),
  ('Эмчилгээний хими', 'эмчилгээний хим', 'seeded'),
  ('Эмэгтэй тайралт', 'emegtei tair', 'seeded'),
  ('Эмэгтэй тайралт', 'emegtei zas', 'seeded'),
  ('Эмэгтэй тайралт', 'эмэгтэй тайр', 'seeded'),
  ('Эрэгтэй тайралт', 'eregtei tair', 'seeded'),
  ('Эрэгтэй тайралт', 'эрэгтэй тайр', 'seeded'),
  ('Үс оношлогоо, зөвлөгөө', 'оношлого', 'seeded'),
  ('Үсний тэжээл', 'tejeel', 'seeded'),
  ('Үсний тэжээл', 'тэжээл', 'seeded'),
  ('Үсний угийн будаг', 'budaad', 'inferred'),
  ('Үсний угийн будаг', 'budah', 'inferred'),
  ('Үсний угийн будаг', 'buduul', 'inferred'),
  ('Үсний угийн будаг', 'ongo', 'inferred'),
  ('Үсний угийн будаг', 'ungo', 'inferred'),
  ('Үсний угийн будаг', 'ungu', 'inferred'),
  ('Үсний угийн будаг', 'будаг', 'inferred'),
  ('Үсний угийн будаг', 'будал', 'inferred'),
  ('Үсний угийн будаг', 'будах', 'inferred'),
  ('Үсний угийн будаг', 'будуул', 'inferred'),
  ('Үсний угийн будаг', 'өнгө', 'inferred'),
  ('Өнгөлөгч будаг', 'өнгөлөгч', 'seeded')
  ) as v(service, alias, provenance)
  join services s on s.name = v.service and s.active
  join tenants t on t.id = s.tenant_id and t.slug = 'tara-park-od';

-- 3. Latin spellings (word pairs only; no customer evidence).
insert into spellings (tenant_id, latin, cyrillic, status, candidates, decided_at)
select t.id, v.latin, v.cyrillic, 'settled', v.candidates::text[], now()
  from tenants t, (values
  ('ali', 'аль', '{аль}'),
  ('arai', 'арай', '{арай}'),
  ('arga', 'арга', '{арга}'),
  ('baidag', 'байдаг', '{байдаг}'),
  ('baiga', 'байгаа', '{байгаа}'),
  ('bish', 'биш', '{биш}'),
  ('bogino', 'богино', '{богино}'),
  ('bol', 'бол', '{бол}'),
  ('boloh', 'болох', '{болох}'),
  ('bolon', 'болон', '{болон}'),
  ('bor', 'бор', '{бор}'),
  ('budag', 'будаг', '{будаг}'),
  ('budalt', 'будалт', '{будалт}'),
  ('budaltaar', 'будалтаар', '{будалтаар}'),
  ('budaltiin', 'будалтын', '{будалтын}'),
  ('buddag', 'будаг', '{будаг}'),
  ('buduulah', 'будуулах', '{будуулах}'),
  ('buh', 'бүх', '{бүх}'),
  ('buten', 'бүтэн', '{бүтэн}'),
  ('bvh', 'бүх', '{бүх}'),
  ('bvten', 'бүтэн', '{бүтэн}'),
  ('deer', 'дээр', '{дээр}'),
  ('der', 'дээр', '{дээр}'),
  ('dolgion', 'долгион', '{долгион}'),
  ('dugar', 'дугаар', '{дугаар}'),
  ('dund', 'дунд', '{дунд}'),
  ('emchilgeeni', 'эмчилгээний', '{эмчилгээний}'),
  ('emchilgeenii', 'эмчилгээний', '{эмчилгээний}'),
  ('emegtei', 'эмэгтэй', '{эмэгтэй}'),
  ('ene', 'энэ', '{энэ}'),
  ('gej', 'гэж', '{гэж}'),
  ('gesen', 'гэсэн', '{гэсэн}'),
  ('gevel', 'гэвэл', '{гэвэл}'),
  ('hamt', 'хамт', '{хамт}'),
  ('hayag', 'хаяг', '{хаяг}'),
  ('hed', 'хэд', '{хэд}'),
  ('hen', 'хэн', '{хэн}'),
  ('hev', 'хэв', '{хэв}'),
  ('hiih', 'хийх', '{хийх}'),
  ('hiij', 'хийж', '{хийж}'),
  ('hiilgeh', 'хийлгэх', '{хийлгэх}'),
  ('hiisen', 'хийсэн', '{хийсэн}'),
  ('himi', 'хими', '{хими}'),
  ('iim', 'ийм', '{ийм}'),
  ('margaash', 'маргааш', '{маргааш}'),
  ('minii', 'миний', '{миний}'),
  ('mor', 'мөр', '{мөр}'),
  ('mun', 'мөн', '{мөн}'),
  ('neg', 'нэг', '{нэг}'),
  ('ner', 'нэр', '{нэр}'),
  ('ochih', 'очих', '{очих}'),
  ('ogooch', 'өгөөч', '{өгөөч}'),
  ('oiroltsoogoor', 'ойролцоогоор', '{ойролцоогоор}'),
  ('ongo', 'өнгө', '{өнгө,өнгөө}'),
  ('sain', 'сайн', '{сайн}'),
  ('salbar', 'салбар', '{салбар}'),
  ('salon', 'салон', '{салон}'),
  ('salond', 'салонд', '{салонд}'),
  ('salonii', 'салоны', '{салоны}'),
  ('setting', 'сеттинг', '{сеттинг}'),
  ('sor', 'сор', '{сор}'),
  ('sul', 'сул', '{сул}'),
  ('systemiin', 'системийн', '{системийн}'),
  ('tairalt', 'тайралт', '{тайралт}'),
  ('tim', 'тийм', '{тийм}'),
  ('todorhoi', 'тодорхой', '{тодорхой}'),
  ('tom', 'том', '{том}'),
  ('toxirox', 'тохирох', '{тохирох}'),
  ('tuvuur', 'төр', '{төр}'),
  ('udur', 'өдөр', '{өдөр}'),
  ('ugin', 'угийн', '{угийн}'),
  ('une', 'үнэ', '{үнэ}'),
  ('ungu', 'өнгө', '{өнгө,өнгөө}'),
  ('ungutei', 'өнгөтэй', '{өнгөтэй}'),
  ('uramshuulal', 'урамшуулал', '{урамшуулал}'),
  ('urt', 'урт', '{урт}'),
  ('urttai', 'урттай', '{урттай}'),
  ('uscin', 'үсчин', '{үсчин}'),
  ('usend', 'үсэнд', '{үсэнд}'),
  ('usiig', 'үсийг', '{үсийг}'),
  ('usni', 'үсний', '{үсний}'),
  ('usnii', 'үсний', '{үсний}'),
  ('vnin', 'үнийн', '{үнийн}'),
  ('vsend', 'үсэнд', '{үсэнд}'),
  ('vsni', 'үсний', '{үсний}'),
  ('vsnii', 'үсний', '{үсний}'),
  ('xariulax', 'хариулах', '{хариулах}'),
  ('yarmag', 'яармаг', '{яармаг}'),
  ('yarmagiin', 'яармагийн', '{яармагийн}'),
  ('zasalt', 'засалт', '{засалт}'),
  ('zergin', 'зэргийн', '{зэргийн}'),
  ('zvgeer', 'зүгээр', '{зүгээр}')
  ) as v(latin, cyrillic, candidates)
 where t.slug = 'tara-park-od';

-- 4. Never-say rules (Яармаг's five, byte for byte; evidence stays empty as in hers).
insert into forbidden_phrasings (tenant_id, scope, phrase, rationale, observed_at, gate, stems)
select t.id, 'tenant', v.phrase, v.rationale, now(), 'Ш2', v.stems::text[] from tenants t, (values
  ('зургаа … салбар', 'Founder 2026-09-24: Tara Salon has one branch; the bot must never say six. Keyed to Ш2, always on.', '{зургаа,салбар}'),
  ('мастер … илүү', 'Founder 2026-09-24: never say a Мастер stylist is better (t02). Keyed to Ш2, always on.', '{мастер,илүү}'),
  ('мастер … туршлага', 'Founder 2026-09-24: never say a Мастер stylist is better (t02). Keyed to Ш2, always on.', '{мастер,туршлага}'),
  ('туршлага … илүү', 'Founder 2026-09-24: never say a Мастер stylist is better (t02). Keyed to Ш2, always on.', '{туршлага,илүү}'),
  ('чанар … илүү', 'Founder 2026-09-24: never say a Мастер stylist is better (t02). Keyed to Ш2, always on.', '{чанар,илүү}')
) as v(phrase, rationale, stems)
 where t.slug = 'tara-park-od';

-- 5. Comments as Яармаг's. The rules are the salon template's 50 (onboarding wrote them,
--    disabled; Яармаг has the same 50 on). The channel: both surfaces, 20 replies per post per
--    day, posts up to 30 days old, Meta's default away message (both apostrophes) is not a
--    person, DALA_AI's app id, Яармаг's callback slug. Delivery SHADOW: drafts, nothing posted.
update comment_rules set enabled = true
 where tenant_id = (select id from tenants where slug = 'tara-park-od')
   and provenance = 'seeded'
   and rule_key in ('complaint', 'complaint_phrases', 'complaint_phrases_lat', 'complaint_call_mn', 'complaint_call_lat',
     'complaint_days_mn', 'complaint_days_lat', 'complaint_money_mn', 'complaint_money_lat', 'complaint_again_mn',
     'complaint_again_lat', 'complaint_human_mn', 'complaint_human_lat', 'complaint_words', 'complaint_bad', 'price',
     'price_stems', 'location', 'location_branch', 'booking', 'booking_mn', 'booking_lat', 'booking_lat_c',
     'booking_free_mn', 'booking_free_lat', 'booking_open_mn', 'booking_when_mn', 'booking_when_lat', 'info',
     'info_stems', 'hours', 'hours_open', 'service_question_q_stem', 'service_question_q_word',
     'service_question_end_stem', 'service_question_end_word', 'praise', 'praise_stems', 'laughter', 'greeting',
     'complaint_wall_only', 'person_staff_mn', 'person_staff_connect_mn', 'person_human_talk_mn', 'person_manager_mn',
     'person_staff_lat', 'person_staff_connect_lat', 'person_human_talk_lat', 'person_human_talk_lat2',
     'person_manager_lat');

update tenant_channels
   set comment_policy = 'both',
       comment_delivery_mode = 'shadow',
       comment_replies_per_post_per_day = 20,
       comment_max_post_age_days = 30,
       automation_texts = array['Thanks for your message. We''re away and can''t respond right now. We appreciate you reaching out.',
                                'Thanks for your message. We’re away and can’t respond right now. We appreciate you reaching out.'],
       meta_app_id = '1562862634970492',
       app_slug = 'dalatech'
 where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page';

-- 6. Reply cases mirroring Яармаг's, INACTIVE. `kind`: det = her fixed reply's body,
--    canned = her canned line's body, lit = the literal expected text, model = must lists only.
--    In a history, «@det:<intent>» / «@canned:<kind>» stand for her row's body.
insert into reply_cases (tenant_id, history, customer_message, expected_body, must_include, must_not_include, note, active)
select t.id,
       coalesce((select jsonb_agg(case
                   when e->>'content' like '@det:%' then jsonb_set(e, '{content}', to_jsonb((select d.body from deterministic_replies d
                        where d.tenant_id = t.id and d.intent = substr(e->>'content', 6))))
                   when e->>'content' like '@canned:%' then jsonb_set(e, '{content}', to_jsonb((select c.body from canned_responses c
                        where c.tenant_id = t.id and c.kind = substr(e->>'content', 9) and c.locale = t.default_locale)))
                   else e end order by o)
                 from jsonb_array_elements(v.history::jsonb) with ordinality x(e, o)), '[]'::jsonb),
       v.msg,
       case v.kind
         when 'det' then (select d.body from deterministic_replies d where d.tenant_id = t.id and d.intent = v.ref)
         when 'canned' then (select c.body from canned_responses c where c.tenant_id = t.id and c.kind = v.ref and c.locale = t.default_locale)
         when 'lit' then v.ref
       end,
       v.inc::text[], v.exc::text[], 'parity 2026-10-05: ' || v.note, false
  from tenants t, (values
    -- greetings and thanks (Яармаг: D-147)
    ('[]', 'байна уу', 'det', 'greeting', '{}', '{}', 'shorthand greeting answered by the greeting row, no model (Яармаг D-147)'),
    ('[]', 'sain bnu uu', 'det', 'greeting', '{}', '{}', 'Latin greeting, greeting row (Яармаг D-147)'),
    ('[]', 'sn bnuu', 'det', 'greeting', '{}', '{}', 'Latin greeting, greeting row (Яармаг D-147)'),
    ('[]', 'bnu', 'det', 'greeting', '{}', '{}', 'Latin greeting, greeting row (Яармаг D-147)'),
    ('[]', 'баярлалаа', 'det', 'thanks', '{}', '{}', 'thanks row, no model (Яармаг D-147)'),
    ('[]', 'баярла', 'det', 'thanks', '{}', '{}', 'thanks row (Яармаг D-147)'),
    ('[]', 'bayarlalaa', 'det', 'thanks', '{}', '{}', 'thanks row, Latin (Яармаг D-147)'),
    ('[]', 'bayrlalaa', 'det', 'thanks', '{}', '{}', 'thanks row, Latin (Яармаг D-147)'),
    ('[]', 'bayrla', 'det', 'thanks', '{}', '{}', 'thanks row, Latin (Яармаг D-147)'),
    ('[]', 'ok баярлалаа', 'det', 'thanks', '{}', '{}', 'thanks row (Яармаг D-147)'),
    -- fixed replies (Яармаг: Tara fixed replies 2026-09-30)
    ('[]', 'Ok', 'det', 'acknowledgement', '{}', '{}', '«ok» gets the acknowledgement row'),
    ('[]', 'Үнэ', 'det', 'price_which_service', '{}', '{}', '«price» alone asks which service'),
    ('[]', 'Хаяг хаана вэ', 'det', 'address', '{}', '{}', 'her own address, no map link'),
    ('[]', 'Утас хэд вэ', 'det', 'salon_phone', '{}', '{}', 'her only number, 99076874'),
    -- likes (Яармаг: D-168)
    ('[]', '👍 (like)', 'det', 'like_welcome', '{}', '{}', 'a like as the first message gets the welcome'),
    ('[{"role": "user", "content": "Хаяг хаана вэ"}, {"role": "assistant", "content": "@det:address"}]', '👍 (like)', 'det', 'acknowledgement', '{}', '{}', 'a like right after Дали''s answer is «ok»'),
    -- the live conversations of 2026-09-24/25 (Яармаг), with her own rows in the history
    ('[{"role": "user", "content": "Үс маань их хуурай, хугараад байна"}, {"role": "assistant", "content": "Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна:\nCICA үсний гүний эмчилгээ: 198,000₮\nҮсний тэжээл: 88,000₮\nҮсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө."}, {"role": "user", "content": "une hedve"}, {"role": "assistant", "content": "Та ямар үйлчилгээний үнэ асууж байгаагаа тодруулж хэлнэ үү?"}]',
     'usnii himi', 'lit', E'Tara perm (богино): 220,000₮\nTara perm (дунд): 250,000₮\nTara perm (урт): 290,000₮\nУсан хими (богино): 120,000₮\nУсан хими (дунд): 160,000₮\nУсан хими (урт): 200,000₮\nАфро хими (богино): 450,000₮\nАфро хими (дунд): 500,000₮\nАфро хими (урт): 550,000₮\nHippie & Jerry curl (богино): 450,000₮\nHippie & Jerry curl (дунд): 500,000₮\nHippie & Jerry curl (урт): 550,000₮\nСэттинг хими (богино): 450,000₮\nСэттинг хими (дунд): 500,000₮\nСэттинг хими (урт): 550,000₮\nШулуун хими (богино): 450,000₮\nШулуун хими (дунд): 500,000₮\nШулуун хими (урт): 550,000₮\nЭмчилгээний хими (эрэгтэй): 189,000₮\n\nТа аль химийг хийлгэх вэ?',
     '{}', '{}', '«usnii himi» gets every perm from the rows and the perm question'),
    ('[{"role": "user", "content": "une hedve"}, {"role": "assistant", "content": "Та ямар үйлчилгээний үнэ асууж байгаагаа тодруулж хэлнэ үү?"}, {"role": "user", "content": "usnii himi"}, {"role": "assistant", "content": "Усны хими 120,000₮–200,000₮ байна."}]',
     'us bish usnii himi', 'lit', E'Tara perm (богино): 220,000₮\nTara perm (дунд): 250,000₮\nTara perm (урт): 290,000₮\nУсан хими (богино): 120,000₮\nУсан хими (дунд): 160,000₮\nУсан хими (урт): 200,000₮\nАфро хими (богино): 450,000₮\nАфро хими (дунд): 500,000₮\nАфро хими (урт): 550,000₮\nHippie & Jerry curl (богино): 450,000₮\nHippie & Jerry curl (дунд): 500,000₮\nHippie & Jerry curl (урт): 550,000₮\nСэттинг хими (богино): 450,000₮\nСэттинг хими (дунд): 500,000₮\nСэттинг хими (урт): 550,000₮\nШулуун хими (богино): 450,000₮\nШулуун хими (дунд): 500,000₮\nШулуун хими (урт): 550,000₮\nЭмчилгээний хими (эрэгтэй): 189,000₮\n\nТа аль химийг хийлгэх вэ?',
     '{}', '{}', 'the correction «us bish usnii himi» gets the perm rows'),
    ('[{"role": "user", "content": "sain bnuu"}, {"role": "assistant", "content": "@det:greeting"}, {"role": "user", "content": "usnii himi"}, {"role": "assistant", "content": "Усны хими 120,000₮–200,000₮ байна."}]',
     'ci henbe', 'det', 'assistant_who', '{}', '{}', '«who are you», Latin, gets the identity row'),
    ('[{"role": "user", "content": "ci henbe"}, {"role": "assistant", "content": "@det:assistant_who"}]',
     'cmg hen hiisen be', 'det', 'assistant_maker', '{}', '{}', '«who made you», Latin, gets the maker row'),
    ('[{"role": "user", "content": "Үс будахад хэд вэ?"}, {"role": "assistant", "content": "Энгийн будаг (богино): 160,000₮\nЭнгийн будаг (дунд): 180,000₮\nЭнгийн будаг (урт): 210,000₮\nҮсний угийн будаг: 99,000₮\n\nТа бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?"}, {"role": "user", "content": "hayag"}, {"role": "assistant", "content": "@det:address"}]',
     'sain bnuu', 'det', 'greeting', '{}', '{}', 'a Latin greeting mid-conversation gets the greeting row'),
    ('[]', 'Hi margaash tanaih ajilahu', 'model', null, '{"Маргааш (",ажиллана.}', '{Даваа:,Мягмар:,Ням:,"үнийн мэдээлэл"}',
     '«are you open tomorrow», Latin: tomorrow''s day and hours only (model case)'),
    ('[{"role": "user", "content": "Hi margaash tanaih ajilahu"}, {"role": "assistant", "content": "Даваа: 10:00 - 20:00\nМягмар: 10:00 - 20:00\nЛхагва: 10:00 - 20:00\nПүрэв: 10:00 - 20:00\nБаасан: 10:00 - 20:00\nБямба: 10:00 - 20:00\nНям: 11:00 - 19:00"}]',
     'Margaash automashingvi bvh niitiin amraltiin udur ym bn', 'model', null,
     '{"Маргааш (","Баярын өдрийн цагийг 99076874 дугаараас лавлана уу."}', '{"үнийн мэдээлэл",Даваа:,76001888,91005498}',
     'tomorrow is a public holiday: tomorrow''s hours and her holiday line with 99076874 (model case)'),
    -- children and deposits (Яармаг: D-167, D-168, D-169)
    ('[]', '8 настай хүүгийн үс тайралт хэд вэ?', 'model', null, '{33,000}', '{}', 'a boy of 8: the children''s haircut price (model case)'),
    ('[]', 'Охины үс тайралт хэд вэ?', 'model', null, '{44,000}', '{}', 'a girl''s haircut (model case)'),
    ('[]', '15 настай хүүгийн үс тайралт хэд вэ?', 'model', null, '{44,000}', '{}', 'a boy of 15 (model case)'),
    ('[]', 'SPECIAL үсчинд урьдчилгаа хэд вэ?', 'model', null, '{20,000}', '{байхгүй,10,000}', 'SPECIAL deposit is 20,000₮ (model case)'),
    ('[]', 'Мастер үсчинд урьдчилгаа хэд вэ?', 'model', null, '{20,000}', '{байхгүй,10,000}', 'Мастер deposit is 20,000₮; no 10,000₮ level at Парк Од (model case)'),
    ('[]', 'SPECIAL үсчин', 'det', 'stylist_tier', '{}', '{}', 'the level reply names her two levels only'),
    -- branches, address and phone (Яармаг: D-170, mirrored: she names Яармаг)
    ('[]', 'Танай хэдэн салбартай вэ?', 'det', 'branch_count', '{}', '{}', 'two branches, branch_count'),
    ('[]', 'hed salbartai ve', 'det', 'branch_count', '{}', '{}', 'two branches, Latin'),
    ('[]', 'Өөр салбар бий юу?', 'det', 'branch_count', '{}', '{}', '«another branch?», branch_count'),
    ('[]', 'Яармаг салбар хаана байдаг вэ?', 'det', 'yarmag_branch', '{}', '{}', 'Яармаг''s address, numbers and Page (yarmag_branch)'),
    ('[]', 'yarmag salbar haana baidag ve', 'det', 'yarmag_branch', '{}', '{}', 'the same, Latin'),
    ('[]', 'Яармаг салбарын утас?', 'det', 'yarmag_branch', '{}', '{}', 'Яармаг''s phone question gets yarmag_branch, never branch_count'),
    ('[]', 'Парк Од салбар хаана байдаг вэ?', 'det', 'address', '{}', '{}', 'her own branch''s address'),
    ('[]', 'Танай салбарын утас?', 'det', 'salon_phone', '{}', '{}', '«your branch''s phone»: salon_phone, 99076874 only'),
    ('[]', 'Паркинг байна уу?', 'model', null, '{}', '{Яармагийн,facebook.com,76001888,91005498}', '«паркинг» is parking, never the other branch (model case)'),
    -- the photo question (Яармаг: photo question 2026-10-04)
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "@canned:photo_price_question"}]', 'энэ шиг болгомоор байна', 'canned', 'handover_notice', '{}', '{}',
     'after the photo question, words naming nothing the rows know go to staff (D-176)'),
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "@canned:photo_price_question"}]', 'hed ve', 'canned', 'handover_notice', '{}', '{}',
     '«how much?» again after the photo question goes to staff, not a second question'),
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "@canned:photo_price_question"}]', 'Будаг хэд вэ', 'model', null,
     '{"Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?"}', '{"ажилтан үзээд"}', 'the answer naming the service gets the dye rows from data, not staff'),
    -- the reel question (Яармаг: reel question 2026-10-04)
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "Сайн байна уу! Танд юугаар туслах вэ?"}]', 'https://www.facebook.com/share/r/1AbCdEfGh/', 'canned', 'reel_price_question', '{}', '{}',
     'a reel shared as a link alone gets the reel question, not staff (D-176)'),
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "Сайн байна уу! Танд юугаар туслах вэ?"}]', 'https://www.facebook.com/share/r/1AbCdEfGh/ hed ve', 'canned', 'reel_price_question', '{}', '{}',
     'a reel link with «how much?» gets the reel question'),
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "@canned:reel_price_question"}]', 'энэ шиг болгомоор байна', 'canned', 'handover_notice', '{}', '{}',
     'after the reel question, words naming nothing the rows know go to staff'),
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "@canned:reel_price_question"}]', 'hed ve', 'canned', 'handover_notice', '{}', '{}',
     '«how much?» again after the reel question goes to staff'),
    ('[{"role": "user", "content": "Сайн байна уу"}, {"role": "assistant", "content": "@canned:reel_price_question"}]', 'Будаг хэд вэ', 'model', null,
     '{"Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?"}', '{"ажилтан үзээд"}', 'after the reel question, the dye rows from data')
  ) as v(history, msg, kind, ref, inc, exc, note)
 where t.slug = 'tara-park-od';

-- Read-back.
do $$
declare t uuid; n int;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  if (select count(*) from canned_responses where tenant_id = t and kind in ('photo_price_question', 'reel_price_question')) <> 2 then
    raise exception 'read-back: photo and reel questions';
  end if;
  if (select count(*) from service_aliases where tenant_id = t) <> 64 then raise exception 'read-back: 64 aliases expected'; end if;
  if (select count(*) from spellings where tenant_id = t) <> 92 then raise exception 'read-back: 92 spellings expected'; end if;
  if (select count(*) from forbidden_phrasings where tenant_id = t) <> 5 then raise exception 'read-back: 5 never-say rules expected'; end if;
  if (select count(*) from comment_rules where tenant_id = t and enabled) <> 50 then raise exception 'read-back: 50 comment rules on expected'; end if;
  if (select count(*) from tenant_channels where tenant_id = t and comment_policy = 'both' and comment_delivery_mode = 'shadow') <> 1 then
    raise exception 'read-back: comment settings';
  end if;
  select count(*) into n from reply_cases where tenant_id = t and note like 'parity 2026-10-05%';
  if n <> 46 then raise exception 'read-back: % parity cases, 46 expected', n; end if;
  -- every exact case resolved to one of her rows (a missing row would leave both empty and violate the check)
  if exists (select 1 from reply_cases where tenant_id = t and note like 'parity 2026-10-05%'
             and expected_body is null and cardinality(must_include) = 0 and cardinality(must_not_include) = 0) then
    raise exception 'read-back: a parity case has nothing to check';
  end if;
  -- nothing of Яармаг's branch in what her new rows say
  if exists (select 1 from reply_cases where tenant_id = t and note like 'parity 2026-10-05%'
             and (coalesce(expected_body, '') ~ '76001888|91005498' and expected_body not like 'Яармаг салбарын хаяг:%')) then
    raise exception 'read-back: an expected answer carries Яармаг''s number outside yarmag_branch';
  end if;
end $$;

commit;
