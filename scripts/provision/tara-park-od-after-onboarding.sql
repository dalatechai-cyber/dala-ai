-- NOT APPLIED. DRAFT for the founder (round 2026-10-03; round 2, 2026-10-04). Tara Salon — Парк Од (slug tara-park-od).
--
-- What her own questionnaire cannot carry, written as Яармаг's approved configuration with
-- Парк Од's own details: the settings, the hairdressers' groups, the canned lines no onboarding
-- template has, the fixed replies, the out-of-scope topics, the dye question and the salon
-- knowledge. Every value here is written out (nothing is copied from Яармаг's rows at run time:
-- D-157, «onboard a branch from its own form, never by copying a sibling's rows»), and the
-- branch gate checks the result like any other row.
--
-- ORDER (docs/tenants/tara-park-od.md «Go-live steps»):
--   1. node scripts/onboard/tenant.ts --form intake/tara-park-od.docx --slug tara-park-od \
--        --wording intake/tara-park-od.wording.json \
--        --facebook-page-id <CONFIRMED Page id> --display-name "Tara Salon — Парк Од" --apply
--      (--wording on EVERY run: it writes Яармаг's approved assistant_identity and booking_line
--      and no refusal_topic; this file refuses to run if it was left out.)
--   2. THIS FILE, in one SQL editor session.
--   3. the same onboarding command with --apply again: its wording sheet now lists all 18
--      canned lines (11 from the form, the 7 below); the founder signs it
--      (… --apply --sign-wording <id> --signed-by <name>).
--   4. the client confirms the summary; node scripts/facts/branches.ts --group tara-salon;
--      publish dry run.
-- A later onboarding --apply leaves every row here as it is (settings, groups, canned lines,
-- fixed replies, topics, documents: re-run and read back on the local replica, 2026-10-03).
--
-- Wording: lines byte-identical to Яармаг's approved rows need no new approval; the lines
-- that differ are listed, exactly, in prompt/drafts/tara_park_od_wording.mn.txt, all of them
-- approved by the founder on 2026-10-04 (still unsigned: her wording sheet is signed at go-live
-- step 7, docs/tenants/tara-park-od.md).
-- Nothing here is live: the tenant has never been published, so the canned-edit guard
-- (0074/0075) is not engaged, and its channel stays in shadow with no token.
begin;

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  if (select live_revision_id from tenants where id = t) is not null then
    raise exception 'tara-park-od has been published: this file is for a tenant still being onboarded';
  end if;
  if (select count(*) from staff_members where tenant_id = t and active
        and name in ('Boloroo', 'Saraa', 'Tomoo', 'Bulgaa', 'Enhuush', 'Chimegee', 'Tuchku')) <> 7 then
    raise exception 'onboard tara-park-od from intake/tara-park-od.docx first (seven hairdressers expected)';
  end if;
  -- Onboarded WITH --wording: Яармаг's approved identity and booking lines, the founder's
  -- hand-off sentence (as Яармаг's in PR #283), and no refusal_topic.
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'handoff'
                 and md5(body) = 'b27d82e7982d1138bcefd0ebc66beaec') then
    raise exception 'her handoff is not the founder''s sentence: onboard with --wording intake/tara-park-od.wording.json';
  end if;
  if not exists (select 1 from canned_responses where tenant_id = t and kind = 'assistant_identity'
                 and md5(body) = 'c138602a0c8487d886708140c047cc79')
     or not exists (select 1 from canned_responses where tenant_id = t and kind = 'booking_line'
                 and md5(body) = 'ab37c405f432903485e5c82eef9d1d5d')
     or exists (select 1 from canned_responses where tenant_id = t and kind = 'refusal_topic') then
    raise exception 'onboard with --wording intake/tara-park-od.wording.json (her identity and booking lines are Яармаг''s; no refusal_topic)';
  end if;
  -- `yarmag_branch` and «Салбарууд» type Яармаг's CURRENT address. After Яармаг's November move
  -- (tara-yarmag-move-2026-11.sql) this file must first be updated to the VIP Center address.
  if not exists (select 1 from contact_points c join tenants y on y.id = c.tenant_id
                 where y.slug = 'matrix-eco-salon' and c.kind = 'address'
                   and c.value = 'Яармагийн Номин Хайпермаркетын баруун талд') then
    raise exception 'Яармаг''s address is no longer «Яармагийн Номин Хайпермаркетын баруун талд»: update yarmag_branch and «Салбарууд» in this file first';
  end if;
  -- No 1-р зэрэг price (config/branch-groups.json not_offered): her form leaves it out.
  if exists (select 1 from service_variants where tenant_id = t and variant_key = '1-р зэрэг') then
    raise exception 'a 1-р зэрэг price is in her rows: onboard from the round-2 form (intake/tara-park-od.docx)';
  end if;
  if exists (select 1 from deterministic_replies where tenant_id = t)
     or exists (select 1 from out_of_scope_topics where tenant_id = t)
     or exists (select 1 from canned_responses where tenant_id = t and kind in
          ('image_received', 'refusal_out_of_scope', 'refusal_service_unavailable', 'comment_private_reply',
           'voice_received', 'handover_reclaim', 'refusal_suitability')) then
    raise exception 'this file is already applied (or rows were added by hand)';
  end if;
  -- knowledge_documents has no unique title: a second «Салбарууд» would contradict the first.
  if exists (select 1 from knowledge_documents where tenant_id = t and title in
          ('Химийн хориглох заалт', 'Урамшуулал ба баримт', 'Химийн үйлчилгээний төрлүүд',
           'Будалтын хориглох заалт ба боломж', 'CICA — эмчилгээ, хими биш', 'TARA Lumi – үүсгэлттэй будалт', 'Салбарууд',
           'Үсчдийн нэр'))
     or exists (select 1 from disambiguation_pairs where tenant_id = t and trigger_term = 'Будаг') then
    raise exception 'a knowledge document or the «Будаг» question this file writes already exists';
  end if;
end $$;

-- 1. Settings as Яармаг's (read 2026-10-03): at most one emoji, no media alert, the same reply
--    age, cache mode and staff-takeover cool-down.
update tenants set reply_style = '{"max_emoji": 1}'::jsonb, media_handoff_alert = false,
       max_reply_age_minutes = 15, prompt_cache_mode = '5m', human_takeover_cooldown_minutes = 30
 where slug = 'tara-park-od';

-- 2. Hairdressers' groups (the roster says who serves whom: women with women, men with Tuchku).
update staff_members s set group_name = case when s.name = 'Tuchku' then 'Эрэгтэй үсчид' else 'Эмэгтэй үсчид' end
  from tenants t
 where t.slug = 'tara-park-od' and s.tenant_id = t.id
   and s.name in ('Boloroo', 'Saraa', 'Tomoo', 'Bulgaa', 'Enhuush', 'Chimegee', 'Tuchku');

-- 3. Canned lines no onboarding template has. UNREVIEWED: signed on her wording sheet (step 3).
--    Six are Яармаг's approved bytes; refusal_suitability differs only by the phone.
insert into canned_responses (tenant_id, kind, body)
select t.id, v.kind, v.body from tenants t,
  (values
    ('image_received', 'Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.'),
    ('refusal_out_of_scope', 'Уучлаарай, ямар үйлчилгээ, өнгө Танд тохирохыг би шийдэж өгөх боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.'),
    ('refusal_service_unavailable', 'Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна.'),
    ('comment_private_reply', 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.'),
    ('voice_received', 'Уучлаарай, би дуут зурвас сонсох боломжгүй. Та асуултаа бичиж илгээвэл баяртайгаар хариулна.'),
    ('handover_reclaim', 'Уучлаарай, хүлээлгэсэнд. Би үргэлжлүүлэн туслая. Танд юугаар туслах вэ?'),
    ('refusal_suitability', 'Уучлаарай, энэ таны үсэнд тохирох эсэхийг би шийдэж өгөх боломжгүй. Манай мэргэжилтэн үсийг тань харж хэлнэ. Та 99076874 дугаараар холбогдоно уу.')
  ) as v(kind, body)
 where t.slug = 'tara-park-od';

-- 4. Fixed replies (sent verbatim, no model). Яармаг's bytes and matchers, except `address`
--    (her address, no map link: she has no Maps listing) and `salon_phone` (99076874, her only number),
--    whose matcher words name Парк Од instead of Яармаг, and `stylist_tier`, which names only
--    her two levels (no 1-р зэрэг hairdresser works at Парк Од; approved 2026-10-04).
--    «Салбарууд» is symmetric (founder, 2026-10-04): `branch_count` is Яармаг's row byte for
--    byte, and `yarmag_branch` mirrors Яармаг's `park_od_branch` (Яармаг's address, Яармаг's own
--    numbers 99076874 and 91005498, and Яармаг's Page; never Яармаг's map link). Wording APPROVED
--    2026-10-04; phones corrected 2026-10-04 (founder, final: Парк Од's only number is 99076874,
--    99076874 and 91005498 are Яармаг's, no shared line).
--    D-177 (founder 2026-10-04: women's «Эмчилгээний хими» and «өнгө гаргалт» are not Tara
--    services; no price page), Яармаг's rows byte for byte (PR #283,
--    tara-yarmag-colour-and-treatment-perm-2026-10-04.sql) except the colour rows' last line, her
--    own `salon_phone` line. `treatment_perm_women` (APPROVED 2026-10-04) lands enabled.
--    `colour_lift` (women's colour rows, to anyone who does not say «эрэгтэй») and
--    `colour_lift_men` (the men's rows, «Бүтэн цайруулалт» included, only with «эрэгтэй»), each
--    under «Манай өнгөний үйлчилгээний үнэ:» and ending with her phone line, APPROVED 2026-10-04
--    (docs/approvals/tara-2026-10-04/08-colour-and-treatment-perm.mn.txt) and land enabled. The
--    rows are the price list's own, typed byte for byte; the fact gate checks them at publish.
--    `deposit_deducted`, `loan_apps` and `dye_brand` are the founder's approved answers of
--    2026-10-04, byte for byte as Яармаг's in PR #283 (tara-yarmag-answers-2026-10-04.sql: body,
--    matcher, placement); the same three answers are FAQs in her form. `dye_brand` serves the
--    hand-off sentence, so (with #283's code deployed) a person is told.
--    Not written: `park_od_branch` (it is her own branch), `tara_name` / `tara_rebrand`
--    (Парк Од was never Matrix).
insert into deterministic_replies (tenant_id, intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
select t.id, v.* from tenants t, (values
 ('acknowledgement', 'Өөр асуух зүйл байвал бичээрэй.', true, 'tenant_confirmed', 'whole_message', 'replace', '{ok,okey,okay,ок,окей,за,заа,"за за","аан за","аа за","за ойлголоо",ойлголоо,oilgoloo,za,zaa,"aan za","aa za","ok za",like}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('address', 'Хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот', true, 'tenant_confirmed', 'covers_message', 'replace', '{хаяг,байршил,байрла,хаана,hayag,hayg,xayg,bairshil,bairla,baishil,haana,haan}'::text[], '{уу,үү,вэ,бэ,ве,юу,сайн,байна,бна,бну,бнуу,танайх,танай,салон,салоны,байдаг,бдаг,тодорхой,явуулаад,өгөөч,өгөөрэй,чинь,хаашаа,болсон,uu,vv,we,ve,be,yu,sain,bna,bnu,bnuu,sn,hi,hello,tanaih,tanai,tanaah,salon,salonii,baidag,bdag,bdg,todorhoi,ywuulaad,yvuulaad,yavuulaad,ogooch,ogoorei,chin,haashaa,bolson,парк,park,од,od,салбар,салбарын,salbar,salbariin}'::text[], '{}'::text[], NULL::jsonb, false),
 ('assistant_who', 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.', true, 'tenant_confirmed', 'whole_message', 'replace', '{"chi hen","chi hen be","chi hen ve","chi hen we","chi hen бэ","chi hen вэ","chi henbe","chi henve","chi henwe","chi henбэ","chi henвэ","chi хэн","chi хэн be","chi хэн ve","chi хэн we","chi хэн бэ","chi хэн вэ","chi хэнbe","chi хэнve","chi хэнwe","chi хэнбэ","chi хэнвэ","ci hen","ci hen be","ci hen ve","ci hen we","ci hen yum","ci hen бэ","ci hen вэ","ci henbe","ci henve","ci henwe","ci henбэ","ci henвэ","ci хэн","ci хэн be","ci хэн ve","ci хэн we","ci хэн бэ","ci хэн вэ","ci хэнbe","ci хэнve","ci хэнwe","ci хэнбэ","ci хэнвэ","hen be","ta hen","ta hen be","ta hen ve","ta hen we","ta hen yum","ta hen бэ","ta hen вэ","ta henbe","ta henve","ta henwe","ta henбэ","ta henвэ","ta хэн","ta хэн be","ta хэн ve","ta хэн we","ta хэн бэ","ta хэн вэ","ta хэнbe","ta хэнve","ta хэнwe","ta хэнбэ","ta хэнвэ","та hen","та hen be","та hen ve","та hen we","та hen бэ","та hen вэ","та henbe","та henve","та henwe","та henбэ","та henвэ","та хэн","та хэн be","та хэн ve","та хэн we","та хэн бэ","та хэн вэ","та хэн юм","та хэнbe","та хэнve","та хэнwe","та хэнбэ","та хэнвэ","хэн бэ","чи hen","чи hen be","чи hen ve","чи hen we","чи hen бэ","чи hen вэ","чи henbe","чи henve","чи henwe","чи henбэ","чи henвэ","чи хэн","чи хэн be","чи хэн ve","чи хэн we","чи хэн бэ","чи хэн бэ сайн байна уу","чи хэн вэ","чи хэн юм","чи хэнbe","чи хэнve","чи хэнwe","чи хэнбэ","чи хэнвэ"}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('branch_count', 'Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.', true, 'tenant_confirmed', 'covers_message', 'replace', '{салбар,salbar}'::text[], '{танай,танайх,tanai,tanaih,хэдэн,хэд,heden,hed,өөр,oor,uur,бий,bii,байдаг,baidag,bdag,бдаг,вэ,бэ,ве,уу,үү,юу,ve,we,be,uu,vv,yu,tara,тара,salon,салон,салоны,сайн,байна,бна,sain,bna}'::text[], '{}'::text[], NULL::jsonb, false),
 ('booking', 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.', true, 'tenant_confirmed', 'covers_message', 'replace', '{авах,авья,авъя,авий,авмаар,авдаг,захиалах,захиалъя,захиалья,захиалмаар,захиалдаг,awah,avah,awhuu,avahuu,avhuu,awii,avii,awya,avya,awdag,avdag,awmaar,avmaar,zahialah,zahialya,zahialmaar,zahialdag}'::text[], '{цаг,цагаа,гэсэн,юм,би,танайх,танайд,онлайн,яаж,уу,үү,вэ,бэ,ве,юу,сайн,байна,бна,бну,бнуу,tsag,tsagaa,gesen,gsn,yum,bi,tanaih,tanaid,online,onlain,yaaj,uu,vv,we,ve,be,yu,sain,bna,bnu,bnuu,sn,hi,hello}'::text[], '{}'::text[], NULL::jsonb, false),
 ('correction_clarify', 'Уучлаарай, би буруу ойлгосон байна. Та юу асууж байгаагаа арай дэлгэрэнгүй бичнэ үү?', true, 'tenant_confirmed', 'on_correction', 'replace', '{bish,биш,buruu,буруу,oilgoogui,ойлгоогүй,oilgosongui,ойлгосонгүй}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('deposit_deducted', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["урьдчил", "урьчил", "урдчил", "uridchil", "urichil", "urdchil", "uridchl"]}, {"mode": "contains_stem", "stems": ["хасагд", "хасах", "хасна", "хасаад", "хасаж", "hasagd", "hasah", "hasna", "hasaad", "hasaj", "xasagd", "тооцогд", "тооцох", "тооцно", "тооцож", "tootsogd", "tootsoh", "tootsno", "tootsoj", "үнэнд", "unend", "vnend"]}]}'::jsonb, false),
 ('dye_brand', 'Энэ талаар манай ажилтан танд хариулна. Та 99076874 дугаараар холбогдоно уу.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["будаг", "будг", "будалт", "budag", "budg", "budalt"]}, {"mode": "contains_stem", "stems": ["брэнд", "бренд", "brand", "brend", "фирм", "firm", "хэрэглэд", "heregled", "ашигладаг", "ashigladag"]}]}'::jsonb, false),
 ('dye_prices', 'Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?', true, 'tenant_confirmed', 'covers_message', 'replace', '{будаг,будг,будах,будал,будуул,budag,budg,budah,budal,buduul}'::text[], '{үс,үсээ,үсний,үсийг,us,vs,usnii,vsnii,usee,vsee,хэд,хэдэн,хэдээр,hed,heden,hedeer,hedve,hedbe,вэ,бэ,ве,ve,we,be,үнэ,үнийн,vne,une,vniin,uniin,мэдээлэл,medeelel,сайн,байна,бнуу,бну,бна,уу,sain,bnu,bna,bnuu,sn,sainuu,сайнуу,танайх,танайд,tanaih,tanaah,tanaid,хийх,hiih,хийлгэх,hiilgeh,хийлгэхэд,болох,boloh,bolh,ямар,yamar,үнэтэй,unetei}'::text[], '{"Энгийн будаг","Үсний угийн будаг"}'::text[], NULL::jsonb, false),
 ('greeting', 'Сайн байна уу! Tara Salon-д тавтай морил. Танд юугаар туслах вэ?', true, 'tenant_confirmed', 'whole_message', 'replace', '{"сайн байна уу","сайн бна уу","сайн бн уу","сайн бнуу","сайн бну","сайн байнуу",сайнуу,"сайн уу","оройн мэнд","өглөөний мэнд","sain baina uu","sain bna uu","sain bnuu","sain bnu","sain bainu","sain bna u",sainuu,"sn bna uu","sn bnu","sn bnuu",hi,hii,hello,hey}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('holiday_hours_note', 'Баярын өдрийн цагийг 99076874 дугаараас лавлана уу.', true, 'tenant_confirmed', 'matcher', 'append', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "has_word", "words": ["баярын", "баяраар", "bayariin", "bayarin", "bayaraar", "нийтийн амралт", "нийтийн амралтын", "niitiin amralt", "niitiin amraltiin", "niitin amraltiin", "наадам", "наадмаар", "naadam", "naadmaar", "цагаан сар", "цагаан сараар", "tsagaan sar", "tsagaan saraar", "шинэ жил", "шинэ жилээр", "shine jil", "shine jileer"]}'::jsonb, false),
 ('like_welcome', 'Сайн байна уу! Tara Salon-д тавтай морил. Танд юугаар туслах вэ?', true, 'tenant_confirmed', 'whole_message', 'replace', '{like}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, true),
 ('loan_apps', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "contains_stem", "stems": ["зээл", "zeel", "storepay", "сторпэй", "lendmn", "pocketzero"]}'::jsonb, false),
 ('perm_types', 'Та аль химийг хийлгэх вэ?', true, 'tenant_confirmed', 'covers_message', 'replace', '{himi,хими,химий}'::text[], '{usnii,vsnii,usni,үсний,us,vs,үс,bish,биш,hed,хэд,hedve,hedbe,heden,хэдэн,hedeer,хэдээр,une,үнэ,vne,uniin,үнийн,vniin,ve,вэ,be,бэ,we,bnu,bna,bnuu,байна,бна,уу,uu,үү,vv,hiilgeh,хийлгэх,hiih,хийх,hiilgemeer,хийлгэмээр,yamar,ymar,ямар,medeelel,мэдээлэл,sain,сайн,bol,бол,ni,нь,bgaa,байгаа,bga,bi,би,gesen,гэсэн,gsn,gesn}'::text[], '{"Tara perm","Усан хими","Афро хими","Hippie & Jerry curl","Сэттинг хими","Шулуун хими","Эмчилгээний хими"}'::text[], NULL::jsonb, false),
 ('photo_send', 'Тийм, зургаа явуулаарай. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.', true, 'tenant_confirmed', 'covers_message', 'replace', '{зураг,зург,zurag,zurg,фото,foto}'::text[], '{явуулж,явуулах,явуулъя,явуулья,явуулбал,явуулчих,явуулмаар,yavuulj,yavuulah,yavuulya,yavuulbal,ywuulj,ywuulah,yvuulj,илгээж,илгээх,илгээе,ilgeej,ilgeeh,ilgeey,болох,болно,bolox,boloh,bolh,bolno,уу,үү,uu,vv,юу,yu,би,bi,танд,tand,та,ta,нарт,nart,сайн,байна,бна,бнуу,sain,bna,bnu,bnuu,sn,руу,ruu}'::text[], '{}'::text[], NULL::jsonb, false),
 ('colour_lift', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮\n\nТа 99076874 дугаараар холбогдоно уу.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["өнгө гаргал", "өнгө гаргуул", "өнгөө гаргуул", "ungu gargal", "ungu gargul", "ongo gargal", "ongo gargul", "vngv gargal"]}, {"mode": "not", "matcher": {"mode": "contains_stem", "stems": ["эрэгтэй", "eregtei", "eregtey"]}}]}'::jsonb, false),
 ('colour_lift_men', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эрэгтэй): 195,000₮\nБүтэн цайруулалт (эрэгтэй): 450,000₮\n\nТа 99076874 дугаараар холбогдоно уу.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["өнгө гаргал", "өнгө гаргуул", "өнгөө гаргуул", "ungu gargal", "ungu gargul", "ongo gargal", "ongo gargul", "vngv gargal"]}, {"mode": "contains_stem", "stems": ["эрэгтэй", "eregtei", "eregtey"]}]}'::jsonb, false),
 ('treatment_perm_women', 'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["эмчилгээний", "emchilgeenii", "emchilgeeni", "emchilgenii"]}, {"mode": "contains_stem", "stems": ["хими", "himi"]}, {"mode": "contains_stem", "stems": ["эмэгтэй", "emegtei", "emegtey"]}]}'::jsonb, false),
 ('price_which_service', 'Та ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.', true, 'tenant_confirmed', 'covers_message', 'replace', '{үнэ,үнийн,үнэтэй,vne,une,vniin,uniin,unetei,vnetei}'::text[], '{мэдээлэл,авья,авъя,авий,авах,хэд,хэдэн,ямар,танайх,уу,үү,вэ,бэ,ве,юу,сайн,байна,бна,бну,бнуу,medeelel,awii,avii,awya,avya,awah,avah,hed,hedve,hedbe,heden,yamar,ymar,tanaih,uu,vv,we,ve,be,yu,sain,bna,bnu,bnuu,sn,hi,hello}'::text[], '{}'::text[], NULL::jsonb, true),
 ('salon_phone', 'Та 99076874 дугаараар холбогдоно уу.', true, 'tenant_confirmed', 'covers_message', 'replace', '{утас,утсаа,утсыг,утасны,дугаар,utas,utsaa,utsiig,utasnii,dugaar}'::text[], '{холбогдох,салбарын,парк,од,салоны,танайх,өгөөч,өгөөрэй,хэд,уу,үү,вэ,бэ,ве,юу,сайн,байна,бна,бну,бнуу,holbogdoh,salbariin,park,od,salonii,tanaih,ogooch,ogoorei,hed,hedve,hedbe,uu,vv,we,ve,be,yu,sain,bna,bnu,bnuu,sn,hi,hello,танай,tanai}'::text[], '{}'::text[], NULL::jsonb, false),
 ('stylist_tier', 'SPECIAL болон Мастер үсчний ялгаа нь зэрэглэл болон үнэд байдаг. Аль зэрэглэлийн үсчинд үйлчлүүлэхээ та өөрөө сонгоно. Ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.', true, 'tenant_confirmed', 'covers_message', 'replace', '{мастер,мастр,master,mastr,special,спешл,спешиал}'::text[], '{үсчин,үсчинд,үсчний,үсчид,үсчнүүд,орвол,орох,орж,дээр,дээрээ,юу,үү,уу,илүү,сайн,бол,нь,1,р,1р,зэрэг,зэргийн,зэргээс,зэрэглэл,зэрэглэлийн,ялгаа,ялгаатай,ямар,аль,чадвартай,туршлагатай,болон,эсвэл,ба,би,вэ,бэ,юм,биз,uschin,us4in,vs4in,vschin,uschind,us4ind,vs4ind,orvol,oroh,orj,deer,yu,uu,vv,ilvv,iluu,ilvu,sain,bol,ni,zereg,zergiin,zergees,yalgaa,yalgaatai,yamar,al,esvel,eswel,ba,bi,ve,we,be,yum,biz}'::text[], '{}'::text[], NULL::jsonb, false),
 ('suitability_stylist', 'Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө.', true, 'tenant_confirmed', 'on_topic', 'append', '{suitability_lat_buda,suitability_lat_himi,suitability_lat_orh,suitability_lat_songo,suitability_lat_ungu,suitability_lat_vsend,suitability_mn_himi,suitability_mn_orh,suitability_mn_ungu}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('thanks', 'Зүгээр ээ 😊 Өөр асуух зүйл байвал бичээрэй.', true, 'tenant_confirmed', 'whole_message', 'replace', '{баярлалаа,"их баярлалаа","за баярлалаа","баярлалаа танд","танд баярлалаа","маш их баярлалаа",bayarlalaa,bayrlalaa,bayarllaa,bayrllaa,"ih bayarlalaa","za bayarlalaa","mash ih bayarlalaa",thanks,"thank you","thanks a lot",thx,"ok thanks"}'::text[], '{}'::text[], '{}'::text[], NULL::jsonb, false),
 ('yarmag_branch', E'Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд\nУтас: 76001888, 91005498\nФэйсбүүк хуудас: https://www.facebook.com/profile.php?id=100067872726164', true, 'tenant_confirmed', 'covers_message', 'replace', '{яармаг,ярмаг,yarmag,yaarmag}'::text[], '{салбар,салбарын,салбарт,salbar,salbariin,хаана,хаяг,хаягаа,байдаг,байрладаг,бдаг,утас,утсаа,дугаар,фэйсбүүк,фэйсбүүкийн,хуудас,хуудсаа,haana,hayag,hayg,baidag,bdag,bairladag,utas,utsaa,dugaar,facebook,fb,page,танай,танайх,вэ,бэ,ве,уу,үү,юу,сайн,байна,бна,бну,өгөөч,өгөөрэй,tanai,tanaih,ve,we,be,uu,vv,yu,sain,bna,bnu,ogooch,ogoorei}'::text[], '{}'::text[], NULL::jsonb, false),
 ('tomorrow_hours', 'Маргааш ({tomorrow.day}) {tomorrow.hours} ажиллана.', true, 'tenant_confirmed', 'matcher', 'replace', '{}'::text[], '{}'::text[], '{}'::text[], '{"mode": "all_of", "matchers": [{"mode": "contains_stem", "stems": ["маргааш", "margaash", "margash"]}, {"mode": "contains_stem", "stems": ["ажил", "ajil", "ажлл", "ajll", "онгорхой", "ongorhoi", "ongoroi", "нээлттэй", "neelttei", "neeltei", "амрах", "amrah", "амарна", "amarna", "амардаг", "amardag", "нийтийн", "niitiin", "niitin", "баярын", "bayariin", "bayarin", "баяраар", "bayaraar", "наадам", "naadam", "наадм", "naadm"]}, {"mode": "not", "matcher": {"mode": "has_word", "words": ["үнэ", "une", "үнэтэй", "unetei", "үнийг", "uniig", "үнийн", "uniin", "хаяг", "hayag", "hayg", "xayg", "байршил", "bairshil", "baishil", "хаана", "haana", "авмаар", "avmaar", "авах", "avah", "авъя", "avya", "avii", "авий", "авч", "avch", "захиалах", "zahialah", "захиалга", "zahialga", "захиалъя", "zahialya"]}}]}'::jsonb, false)
) as v(intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
 where t.slug = 'tara-park-od';

-- `assistant_maker`: Яармаг's 360 stems are every «who made you» spelling: five ways to say
-- «you», «hen»/«хэн», four verbs, nine endings, sorted by code point (the same array).
insert into deterministic_replies (tenant_id, intent, body, enabled, provenance, match_mode, placement, stems, cover_words, quote_services, matcher, requires_empty_history)
select t.id, 'assistant_maker', 'Намайг DalaTech бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.', true, 'tenant_confirmed', 'whole_message', 'replace',
       (select array_agg(s order by convert_to(s, 'UTF8'))
          from (select p || ' ' || h || ' ' || v || e as s
                  from unnest(array['chamaig', 'cmg', 'tanyg', 'таныг', 'чамайг']) p,
                       unnest(array['hen', 'хэн']) h,
                       unnest(array['butesen', 'hiisen', 'бүтээсэн', 'хийсэн']) v,
                       unnest(array['', ' be', ' ve', ' бэ', ' вэ', 'be', 've', 'бэ', 'вэ']) e) x),
       '{}'::text[], '{}'::text[], NULL::jsonb, false
  from tenants t where t.slug = 'tara-park-od';

-- 5. Out-of-scope topics: Яармаг's eleven, byte for byte (no branch detail in any of them).
insert into out_of_scope_topics (tenant_id, topic_key, matcher, decision_question, response_kind, deterministic_shortcircuit, provenance, quote_price, grounded_only)
select t.id, v.* from tenants t, (values
 ('nail_services', '{"mode": "contains_stem", "stems": ["маникюр", "педикюр", "хумс", "manikur", "pedikur", "hums"]}'::jsonb, 'Сүүлийн мессеж хумсны үйлчилгээний тухай асууж байна уу?', 'refusal_service_unavailable', false, 'tenant_confirmed', false, false),
 ('photo_consultation', '{"mode": "contains_stem", "stems": ["зураг", "зурган", "фото", "zurag", "zurgan", "foto"]}'::jsonb, 'Сүүлийн мессеж зураг харж зөвлөгөө өгөх тухай юу?', 'refusal_out_of_scope', false, 'tenant_confirmed', false, false),
 ('suitability_lat_buda', '{"mode": "stem_sequence", "stems": ["buda", "himi"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_lat_himi', '{"mode": "stem_sequence", "stems": ["usend", "himi"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_lat_orh', '{"mode": "stem_sequence", "stems": ["usend", "oroh"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_lat_songo', '{"mode": "stem_sequence", "stems": ["ongo", "songo"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_lat_ungu', '{"mode": "stem_sequence", "stems": ["ungu", "gara"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_lat_vsend', '{"mode": "stem_sequence", "stems": ["vsend", "ungu"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_mn_himi', '{"mode": "stem_sequence", "stems": ["үсэнд", "хими"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_mn_orh', '{"mode": "stem_sequence", "stems": ["үсэнд", "орох"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true),
 ('suitability_mn_ungu', '{"mode": "stem_sequence", "stems": ["өнгө", "гарах"], "windowCp": 40}'::jsonb, 'Сүүлийн мессеж ямар үйлчилгээ, өнгө энэ хүний өөрийнх нь үсэнд тохирохыг дүгнэж, сонгож өгөхийг хүсэж байна уу? Үйлчилгээ хийж болох эсэх, үнийг асууж байгаа бол үгүй.', 'refusal_suitability', false, 'tenant_confirmed', true, true)
) as v(topic_key, matcher, decision_question, response_kind, deterministic_shortcircuit, provenance, quote_price, grounded_only)
 where t.slug = 'tara-park-od';

-- 6. The dye question (Яармаг's bytes).
insert into disambiguation_pairs (tenant_id, trigger_term, question)
select t.id, 'Будаг', 'Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?' from tenants t where t.slug = 'tara-park-od';

-- 7. Salon knowledge: Яармаг's six documents byte for byte (the same services and products),
--    her own «Салбарууд», symmetric with Яармаг's (it names Яармаг: its address, the shared line,
--    its Page), and «Үсчдийн нэр», the Cyrillic spellings customers may type for her hairdressers.
--    Wording of both APPROVED by the founder on 2026-10-04, as written:
--    prompt/drafts/tara_park_od_wording.mn.txt. The level document comes from her form (5.2).
insert into knowledge_documents (tenant_id, title, body, source)
select t.id, v.title, v.body, v.source from tenants t, (values
 ('Химийн хориглох заалт', E'Цайруулсан үсэнд хими хийхгүй. Уураг нь будагтай урвалд орж, барьцалддаг.\nНимгэн үс гэмтээгүй бол хими барина. Гэмтсэн үс сэгсгэр болно.\nТом долгион барихгүй.\nБудсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно.\nЖирэмсэн үед будаг, хими хийхгүй. Үс цусаар дамжин шим тэжээл авдаг тул уурагт нөлөөлж болзошгүй.', 'Tara Salon, 2026-09-07, эзний хариулт; хоёр салбарт ижил'),
 ('Урамшуулал ба баримт', E'Урамшууллыг зараар зарлана.\nЦахим баримтыг зөвхөн үйлчилгээнд олгоно. Бараанд цахим баримт олгохгүй.', 'Tara Salon, 2026-09-07, эзний хариулт; хоёр салбарт ижил'),
 ('Химийн үйлчилгээний төрлүүд', E'Эмчилгээний хими нь ургамлын гаралтай, зөөлөн. Үсийг гэмтээдэггүй. 1 цаг 30 минут үргэлжилнэ.\nШулуун хими нь хүчтэй бөгөөд хүн бүрд тохирохгүй.\nЭмчилгээний хими болон шулуун хими хоёр ижил долгион үүсгэдэг. Ялгаа нь хүч ба зөөлөн байдалд.\nАфро хими нь жижиг, нягт буржгар. Ихэвчлэн эрэгтэй үйлчлүүлэгчид. Хөдөлмөр их шаардана, 4-5 цаг үргэлжилнэ.', 'Tara Salon, 2026-09-07, эзний хариулт; хоёр салбарт ижил'),
 ('Будалтын хориглох заалт ба боломж', E'Хараар будсан үсийг хоёр удаагийн будалтаар бор өнгөтэй болгож болно. Бүтэн будалт, үс гэмтэхгүй.\nСорын өмнө сорилт хийж болно.\nГэмтсэн үсэнд эхлээд CICA хийж, дараа нь өнгөтэй сор хийнэ.\nЖирэмсэн үед OTG будаг хийхгүй. Гэхдээ өнгөлөгч будаг болно.\nӨнгөлөгч будаг нь үсний гадаргуун давхаргад ажиллаж, нар салхинаас хамгаална. Жирэмсэн болон харшилтай хүнд аюулгүй. 70 хувь тэжээл, 30 хувь будаг.', 'Tara Salon, 2026-09-07, эзний хариулт; хоёр салбарт ижил'),
 ('CICA — эмчилгээ, хими биш', E'CICA эмчилгээний хими гэсэн үйлчилгээ БАЙХГҮЙ. Эмчилгээний хими бол ургамлын гаралтай зөөлөн хими.\nCICA бол тусдаа сэргээх эмчилгээ.\nCICA нь үсний гэмтсэн давхаргад ажиллана.\nБудалт болон мелировканд тэжээллэг найрлага ордоггүй.', 'Tara Salon, 2026-09-07, эзний хариулт; хоёр салбарт ижил'),
 ('TARA Lumi – үүсгэлттэй будалт', E'- Үсний өнгийг зөөлөн, уусалттай харагдуулна\n- Нүүрний өнгө төрхөд тохируулан өнгө сонгоно\n- Үндэс ургах үед огцом ялгарахгүй, арчилгаа хялбар\n- Зэсэрсэн, жигд бус өнгийг илүү зөөлөн, цэвэрхэн харагдуулна\n- Үсэнд хэмжээс, гэрэл сүүдэр үүсгэж илүү өтгөн, амьд харагдуулна\n- Өөрт тань тохирсон өнгөний шийдлийг зөвлөгөөний дагуу сонгоно\nҮсний урт, өтгөн шингэн болон өмнөх будалтын байдлаас шалтгаалан үнэ өөрчлөгдөж болно.', 'Tara Salon, 2026-10-01, эзний тайлбар; хоёр салбарт ижил'),
 ('Салбарууд', E'Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.\nЭнэ хуудас бол Парк Од салбарын хуудас.\nBoloroo Парк Од салбарт ажилладаг.\nПарк Од салбарын хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот.\nЯармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд.\nЯармаг салбарын утас: 76001888, 91005498.\nПарк Од салбарын утас: 99076874.\nХоёр салбарын үнэ ижил.\nЯармаг салбар өөрийн Фэйсбүүк хуудастай.', 'founder 2026-10-04'),
 ('Үсчдийн нэр', E'Үсчдийн нэрийг латин үсгээр бичнэ: Boloroo, Saraa, Tomoo, Bulgaa, Enhuush, Chimegee, Tuchku.\nБолороо, Болор гэвэл Boloroo.\nСараа гэвэл Saraa.\nТомоо, Төмөө гэвэл Tomoo.\nБулгаа гэвэл Bulgaa.\nЭнхүүш гэвэл Enhuush.\nЧимэгээ гэвэл Chimegee.\nТучку, Түчкү гэвэл Tuchku.', 'founder 2026-10-04')
) as v(title, body, source)
 where t.slug = 'tara-park-od';

-- 8. Reply cases, the same as Яармаг's in PR #283, INACTIVE: the production build runs every
--    tenant's active cases, and she has no snapshot until her first publish. Switch them on with
--    her publish (go-live step 10, docs/tenants/tara-park-od.md), the seven D-177 cases with
--    them.
insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note, active)
select t.id, v.msg, v.exp, v.inc::text[], v.exc::text[], v.note, false
  from tenants t, (values
  ('Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.', '{}', '{}',
   'answers 2026-10-04 (exact): the deposit is deducted from the price (founder, item 1)'),
  ('uridchilgaa unendee orj tootsogdoh uu', 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.', '{}', '{}',
   'answers 2026-10-04 (exact): the same, typed in Latin'),
  ('Зээлийн апп-аар төлж болох уу', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.', '{}', '{}',
   'answers 2026-10-04 (exact): no loan apps (founder, item 2)'),
  ('storepay baigaa yu', 'Одоогоор зээлийн аппаар төлбөр авдаггүй.', '{}', '{}',
   'answers 2026-10-04 (exact): a loan app named by its brand'),
  ('Ямар брэндийн будаг хэрэглэдэг вэ', 'Энэ талаар манай ажилтан танд хариулна. Та 99076874 дугаараар холбогдоно уу.', '{}', '{}',
   'answers 2026-10-04 (exact): the dye brand goes to staff and the shared line (founder, item 3)'),
  ('Урьдчилгаа төлбөр хэд вэ', null, '{}', '{"хасагдаж тооцогдоно"}',
   'answers 2026-10-04 (model): the deposit AMOUNT is not answered with the deduction line'),
  ('цагийн хуваарь', null, '{}', '{"зээлийн аппаар"}',
   'answers 2026-10-04 (model): «хуваарь» is not a loan question'),
  ('ungu gargalt hed ve', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮\n\nТа 99076874 дугаараар холбогдоно уу.', '{}', '{"эрэгтэй","Бүтэн цайруулалт","хийдэггүй","үзүүлэхгүй","боломжгүй","хийхгүй"}',
   'D-177: «өнгө гаргалт», no gender given: the women''s colour rows and the phone line, never «not offered»'),
  ('Өнгө гаргуулмаар байна, үнэ хэд вэ', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эмэгтэй): 150,000₮\nБүтэн сор: 210,000₮\n\nТа 99076874 дугаараар холбогдоно уу.', '{}', '{"эрэгтэй","Бүтэн цайруулалт","хийдэггүй","үзүүлэхгүй","боломжгүй","хийхгүй"}',
   'D-177: «өнгө гаргалт», Cyrillic, women''s rows'),
  ('eregtei hun ungu gargalt hed ve', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эрэгтэй): 195,000₮\nБүтэн цайруулалт (эрэгтэй): 450,000₮\n\nТа 99076874 дугаараар холбогдоно уу.', '{}', '{"эмэгтэй","Бүтэн сор","хийдэггүй","үзүүлэхгүй","боломжгүй","хийхгүй"}',
   'D-177: «өнгө гаргалт» from a man: the men''s rows only (founder 2026-10-04)'),
  ('Эрэгтэй хүн өнгө гаргуулж болох уу', E'Манай өнгөний үйлчилгээний үнэ:\nХэсэгчилсэн сор (эрэгтэй): 195,000₮\nБүтэн цайруулалт (эрэгтэй): 450,000₮\n\nТа 99076874 дугаараар холбогдоно уу.', '{}', '{"эмэгтэй","Бүтэн сор","хийдэггүй","үзүүлэхгүй","боломжгүй","хийхгүй"}',
   'D-177: «өнгө гаргалт» from a man, Cyrillic'),
  ('emegtei emchilgeenii himi hed ve', 'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', '{}', '{}',
   'D-177: women''s «Эмчилгээний хими» is not offered (founder 2026-10-04, approved line)'),
  ('Эмэгтэй эмчилгээний хими хийдэг үү', 'Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.', '{}', '{}',
   'D-177: women''s «Эмчилгээний хими», Cyrillic'),
  ('eregtei emchilgeenii himi hed ve', null, '{"189,000₮"}', '{"үзүүлэхгүй"}',
   'D-177: men''s «Эмчилгээний хими» stays as it is (189,000₮)')
  ) as v(msg, exp, inc, exc, note)
 where t.slug = 'tara-park-od'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = v.msg);

-- Read back.
do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'tara-park-od';
  if (select count(*) from deterministic_replies where tenant_id = t) <> 26 then raise exception 'read-back: 26 fixed replies expected'; end if;
  if (select count(*) from reply_cases where tenant_id = t and not active
        and (note like 'answers 2026-10-04%' or note like 'D-177:%')) <> 14 then
    raise exception 'read-back: fourteen inactive reply cases expected';
  end if;
  if (select count(*) from deterministic_replies where tenant_id = t and not enabled) <> 0
     or (select count(*) from deterministic_replies where tenant_id = t and provenance = 'tenant_confirmed'
           and intent in ('treatment_perm_women', 'colour_lift', 'colour_lift_men')) <> 3 then
    raise exception 'read-back: every fixed reply, the three D-177 rows included, must land on';
  end if;
  -- Яармаг's numbers (76001888, 91005498) only where she names Яармаг; her own line is 99076874.
  if exists (select 1 from deterministic_replies d where d.tenant_id = t and d.intent <> 'yarmag_branch'
               and (d.body like '%91005498%' or d.body like '%76001888%'))
     or exists (select 1 from knowledge_documents k where k.tenant_id = t and k.title <> 'Салбарууд'
               and (k.body like '%91005498%' or k.body like '%76001888%'))
     or exists (select 1 from canned_responses c where c.tenant_id = t and (c.body like '%91005498%' or c.body like '%76001888%')) then
    raise exception 'read-back: 76001888 and 91005498 are Яармаг''s, said only in yarmag_branch and «Салбарууд»';
  end if;
  if not exists (select 1 from deterministic_replies where tenant_id = t and intent = 'salon_phone'
                 and body = 'Та 99076874 дугаараар холбогдоно уу.') then
    raise exception 'read-back: her salon_phone line is 99076874';
  end if;
  if (select count(*) from knowledge_documents where tenant_id = t and title in ('Салбарууд', 'Үсчдийн нэр')) <> 2 then
    raise exception 'read-back: «Салбарууд» and «Үсчдийн нэр» expected once each';
  end if;
  if (select cardinality(stems) from deterministic_replies where tenant_id = t and intent = 'assistant_maker') <> 360 then raise exception 'read-back: 360 maker stems expected'; end if;
  if (select count(*) from out_of_scope_topics where tenant_id = t) <> 11 then raise exception 'read-back: 11 topics expected'; end if;
  if (select count(*) from canned_responses where tenant_id = t and reviewed_at is null) < 7 then raise exception 'read-back: the new lines must be unreviewed'; end if;
  if (select reply_style from tenants where id = t) <> '{"max_emoji": 1}'::jsonb then raise exception 'read-back: reply_style'; end if;
end $$;

commit;

-- 9. (Removed 2026-10-04: the D-177 rows are approved and land on; their cases switch on with her
--    publish, step 10 in docs/tenants/tara-park-od.md.)
