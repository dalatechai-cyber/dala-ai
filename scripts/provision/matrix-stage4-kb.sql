-- Matrix Eco Salon — Stage 4: the knowledge base.
--
-- Every fact below came from Matrix on 2026-09-07, relayed by the founder, who marked it
-- tenant-confirmed. Several answers CORRECT what the salon said earlier; those are called
-- out in `docs/DECISIONS.md` (D-047) rather than silently overwritten here.
--
-- Idempotent: guarded on natural keys, so a second run changes nothing.
--
-- ## What this does NOT write, and why each is deliberate
--
--   * `service_variants`  — no prices were given. A price list is the one thing in this
--                           schema that must never be inferred (`allowed_numbers` is built
--                           from it and the outbound guard refuses any numeral not in it).
--                           So there are no variants, the price-list section renders empty,
--                           and prices are a reported blank.
--   * `faqs`              — the salon gave facts, not question/answer pairs. Composing the
--                           pairs would be putting my phrasing behind their provenance.
--                           The same facts live in `knowledge_documents`, which is prose
--                           the model reads rather than a line it reproduces.
--   * `disambiguation_pairs` — «цаг» is genuinely ambiguous and belongs here, but the
--                           QUESTION is customer-visible Mongolian and therefore the
--                           business's to write (D-046). This is the first gap-report
--                           finding waiting to happen.
--   * `deposit_rules`, `price_axes`, `tenant_booking` — the 20,000₮/10,000₮ deposits and
--                           the booking URL are evidenced from the ANCESTOR'S production
--                           behaviour, not from an answer Matrix gave. Evidence from a
--                           live bot is not the business confirming a fact (D-020), and
--                           `tenant_booking` has no provenance column in which to record
--                           the difference.
--   * `service_aliases`   — inventing these is the original D-020 sin. Not repeated.
--
-- ## One trap this file must not spring
--
-- `kindsReferencedBy` scans the WHOLE compiled prefix for `"lower_snake"` tokens in
-- straight double quotes and treats each as a canned kind the tenant must have provisioned;
-- a kind with no row makes `renderCannedSection` refuse and every reply 503s. Tenant text
-- therefore uses «…» throughout and contains no such token. Mongolian prose uses «…»
-- naturally, so this costs nothing — but it is why no body below quotes an ASCII word.

begin;

-- ---------------------------------------------------------------------------
-- 1. Staff. The roster is REPLACED, not appended: the previous nine are stale.
-- ---------------------------------------------------------------------------
--
-- Six work here; three do not. `active=false` rather than deleted, because a customer who
-- asks for Ананд by name should be recognised as asking for a real person who has left,
-- and a deleted row cannot tell that from a name nobody here has ever had.
--
-- Оюунаа works only at the Yarmag branch — which is THIS branch, so she is selectable on
-- this channel. That constraint matters for the other five branches and is recorded in the
-- branches document rather than in a column, because it is a fact about where she works
-- and not an attribute of this channel's roster.
insert into staff_members (tenant_id, name, short_name, active, customer_selectable)
select t.id, v.name, v.short_name, v.active, v.active
from tenants t
cross join (values
  ('Батзаяа',      'Zaya',    true),
  ('Отгонжаргал',  'Otgoo',   true),
  ('Г. Мөнхзаяа',  'Muugii',  true),
  ('Оюунсүрэн',    'Оюунаа',  true),
  ('Бадамцэцэг',   'Бадмаа',  true),
  ('Уянга',        null,      true),    -- goes by her own name
  ('Тэргэл',       null,      false),   -- not working
  ('Ананд',        null,      false),   -- left
  ('Мухлай',       null,      false)    -- left
) as v(name, short_name, active)
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from staff_members s where s.tenant_id = t.id and s.name = v.name
  );

-- ---------------------------------------------------------------------------
-- 2. Services. Names and durations only — no prices exist yet.
-- ---------------------------------------------------------------------------
--
-- The earlier answer «only office colour and perm run over an hour» was WRONG and the
-- salon corrected it. `duration_minutes` carries a single number; a range goes in
-- `turnaround_text`, which is what that column is for.
insert into services (tenant_id, name, category, unit, duration_minutes, turnaround_text)
select t.id, v.name, v.category, v.unit, v.duration_minutes, v.turnaround_text
from tenants t
cross join (values
  ('Эмчилгээний хими', 'хими',      'service', 90,   null),
  ('Афро хими',        'хими',      'service', null, '4-5 цаг'),
  ('Шулуун хими',      'хими',      'service', null, null),
  ('CICA эмчилгээ',    'эмчилгээ',  'session', null, null),
  ('CMC тос',          'эмчилгээ',  'service', null, null),
  ('Сор',              'будалт',    'service', null, null),
  ('Office өнгө',      'будалт',    'service', null, null),
  ('Омбре',            'будалт',    'service', null, null)
) as v(name, category, unit, duration_minutes, turnaround_text)
where t.slug = 'matrix-eco-salon'
  and not exists (select 1 from services s where s.tenant_id = t.id and s.name = v.name);

-- ---------------------------------------------------------------------------
-- 3. Contact points
-- ---------------------------------------------------------------------------
-- The salon replaced 7741-7777 (and -7771, -7776) with these two on 2026-09-19. The
-- VALUE and the GUARD both carried the old number, and that pair is why this mattered:
-- the guard asked whether a row holding 7741-7777 existed, the republish had removed it,
-- so a re-run would not have been a no-op — it would have inserted the dead number back
-- as a second escalation contact, and the next publish would have compiled it into the
-- prefix and into allowed_numbers. An idempotency guard keyed on the value it inserts
-- stops being idempotent the moment that value changes.
--
-- Comma form, not «эсвэл»: this is a DATA row that renders as `- Утас: …`. The sentence
-- form belongs in the canned bodies, where it is a sentence.
insert into contact_points (tenant_id, kind, value, is_escalation)
select t.id, 'phone', '76001888, 80905498', true
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from contact_points c
    where c.tenant_id = t.id and c.kind = 'phone' and c.value = '76001888, 80905498'
  );

-- ---------------------------------------------------------------------------
-- 4. Knowledge documents — the substance
-- ---------------------------------------------------------------------------
--
-- These are prompt CONTEXT (L3), not sentences sent to a customer. The facts are Matrix's;
-- the Mongolian phrasing around them is mine, and that distinction is reported to the
-- founder rather than buried — a native-speaker read before Stage 5 is the right check.
insert into knowledge_documents (tenant_id, title, body, source)
select t.id, v.title, v.body, 'Matrix Eco Salon, 2026-09-07, эзний хариулт'
from tenants t
cross join (values
(
  'Химийн үйлчилгээний төрлүүд',
  'Эмчилгээний хими нь ургамлын гаралтай, зөөлөн. Үсийг гэмтээдэггүй. 1 цаг 30 минут үргэлжилнэ.' || chr(10) ||
  'Шулуун хими (сеттинг) нь хүчтэй бөгөөд хүн бүрд тохирохгүй.' || chr(10) ||
  'Эмчилгээний хими болон шулуун хими хоёр ижил долгион үүсгэдэг. Ялгаа нь хүч ба зөөлөн байдалд.' || chr(10) ||
  'Афро хими нь жижиг, нягт буржгар. Ихэвчлэн эрэгтэй үйлчлүүлэгчид. Хөдөлмөр их шаардана, 4-5 цаг үргэлжилнэ.'
),
(
  'CICA ба CMC — эмчилгээ, хими биш',
  'CICA эмчилгээний хими гэсэн үйлчилгээ БАЙХГҮЙ. Эмчилгээний хими бол ургамлын гаралтай зөөлөн хими.' || chr(10) ||
  'CICA бол тусдаа сэргээх эмчилгээ. Нэг удаагийн CICA нь ойролцоогоор 50 удаагийн үсний масктай тэнцэнэ.' || chr(10) ||
  'CICA нь үсний гэмтсэн давхаргад ажиллана. Нэг курс нь 3 удаа, хооронд нь 3-5 хоногийн зайтай.' || chr(10) ||
  'CMC бол тэжээллэг тос. Меланиныг идэвхжүүлж, гялбаа нэмнэ. Будалт, химийн өмнө хийхэд сайн.' || chr(10) ||
  'Будалт болон мелировканд тэжээллэг найрлага ордоггүй.'
),
(
  'Сор, office өнгө, омбре',
  'Энгийн сор бол малгайгаар татаж авах арга. Дараа нь өнгө оруулахгүй.' || chr(10) ||
  'Office өнгө бол арга барил: 30 хувийн цайруулалт, малгай, дараа нь үндсийг сүүдэрлэж, үзүүрийг цайвар будгаар гэрэлтүүлнэ.' || chr(10) ||
  'Office өнгөний будгийг фольго дээрх үсийг харж сонгоно.' || chr(10) ||
  'Омбре бол 70 хувийн цайруулалт.'
),
(
  'Химийн хориглох заалт',
  'Цайруулсан үсэнд хими хийхгүй. Уураг нь будагтай урвалд орж, барьцалддаг.' || chr(10) ||
  'Нимгэн үс гэмтээгүй бол хими барина. Гэмтсэн үс сэгсгэр болно.' || chr(10) ||
  'Том долгион барихгүй.' || chr(10) ||
  'Будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно.' || chr(10) ||
  'Жирэмсэн үед будаг, хими хийхгүй. Үс цусаар дамжин шим тэжээл авдаг тул уурагт нөлөөлж болзошгүй.'
),
(
  'Будалтын хориглох заалт ба боломж',
  'Хараар будсан үсийг хоёр удаагийн будалтаар бор өнгөтэй болгож болно. Бүтэн будалт, үс гэмтэхгүй.' || chr(10) ||
  'Сорын өмнө сорилт хийж болно.' || chr(10) ||
  'Гэмтсэн үсэнд эхлээд CICA хийж, дараа нь өнгөтэй сор хийнэ.' || chr(10) ||
  'Жирэмсэн үед OTG будаг хийхгүй. Гэхдээ тонирование будаг болно.' || chr(10) ||
  'Тонирование нь үсний гадаргуун давхаргад ажиллаж, нар салхинаас хамгаална. Жирэмсэн болон харшилтай хүнд аюулгүй. 70 хувь тэжээл, 30 хувь будаг.'
),
(
  'Салбарууд',
  'Матрикс эко салон нийт зургаан салбартай.' || chr(10) ||
  'Энэ хуудас бол Яармаг салбар. Паранчайс бол өөр салбар.' || chr(10) ||
  'Бусад салбарын мэдээллийг 76001888 эсвэл 80905498 дугаараар лавлана уу.' || chr(10) ||
  'Энд байгаа зарим үйлчилгээ бусад салбарт байхгүй.' || chr(10) ||
  'Оюунаа зөвхөн Яармаг салбарт ажилладаг.'
),
(
  'Урамшуулал ба баримт',
  'Урамшууллыг зараар зарлана.' || chr(10) ||
  'Одоогоор эмчилгээний химийн урамшуулал 9 сарын 20 хүртэл үргэлжилж байна.' || chr(10) ||
  'Цахим баримтыг зөвхөн үйлчилгээнд олгоно. Бараанд цахим баримт олгохгүй.'
)
) as v(title, body)
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from knowledge_documents k where k.tenant_id = t.id and k.title = v.title
  );

-- ---------------------------------------------------------------------------
-- 5. One refusal: photo consultations
-- ---------------------------------------------------------------------------
--
-- Matrix will not answer from a photo — the customer has to come in and have their hair
-- looked at. This is the ONLY refusal topic seeded, and it is seeded because they stated
-- it as a rule rather than because a pattern was inferred from traffic (D-020, and the
-- earlier instruction that `refusal_health` must not be seeded from evidence that does
-- not exist). Stems are 5+ characters, well clear of MIN_STEM_CHARS.
--
-- `deterministic_shortcircuit` stays FALSE: a short-circuit that fires wrongly refuses a
-- paying customer with no model in the loop, and it is off per topic per tenant until a
-- measured precision run says otherwise.
insert into out_of_scope_topics (tenant_id, topic_key, matcher, decision_question,
                                 response_kind, deterministic_shortcircuit, provenance)
select t.id, 'photo_consultation',
       '{"mode":"contains_stem","stems":["зураг","зурган","фото"]}'::jsonb,
       'Сүүлийн мессеж зураг харж зөвлөгөө өгөх тухай юу?',
       'refusal_out_of_scope', false, 'tenant_confirmed'
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from out_of_scope_topics o
    where o.tenant_id = t.id and o.topic_key = 'photo_consultation'
  );

commit;
