-- Tenant #0 (Dalatech's own Page and website) knowledge base, ported from the prompt the
-- company's live site chatbot has been serving: `dalatech-chatbot`, `api/chat.js`,
-- `buildConversationSystemInstruction`.
--
-- Run with the tenant as an argument, never as a literal:
--   psql "$DB_URL" -v tenant=919e21d4-... -f scripts/provision/tenant0-knowledge.sql
--
-- ## Why there are no prices in here, and that is not an omission
--
-- D-075 is the founder's call and it is platform-wide: *prices never enter
-- `allowed_numbers`, and never enter the prefix*. `allowed_numbers` is a SET, so the
-- outbound guard checks that a numeral is on the tenant's list and NEVER that it belongs
-- to the thing being discussed. This tenant is the worst case that rule was written for:
-- five staff sharing two price points (three at one figure, two at another) and two setup
-- figures. A model that attaches Vira's monthly fee to Dali is quoting a real, allow-listed
-- number against the wrong product — more plausible to a customer than an invented one,
-- and therefore worse.
--
-- So every `₮` amount from the source prompt is dropped here. What is kept is everything
-- that is NOT a price: what each member of staff does, which are live and which are taking
-- pre-registrations, the rollout time, what the monthly fee covers, the discount tiers, the
-- payment split, and the contact route. That alone is what emits the tenant-data marker —
-- `hasTenantData` counts sections OTHER than `canned_responses` — so it is also what stops
-- this tenant short-circuiting to the handoff line before the model is ever called (D-033,
-- D-058).
--
-- Serving prices is a separate, built mechanism and a separate decision: a
-- `deterministic_replies` row is drafted verbatim BEFORE the model call and never enters
-- the prefix, so its numerals reach neither `allowed_numbers` nor the outbound guard, and
-- the price is bound to the product by the MATCH rather than by the model. That is D-075's
-- own "the platform serves the price line from the row". Those rows are customer-visible
-- Mongolian and wait for the founder.
--
-- ## Provenance
--
-- Every FAQ ANSWER here is a sentence from that live prompt, verbatim, so
-- `tenant_confirmed` is a statement about where the text came from and not a promotion.
-- It is also load-bearing rather than decorative: `sections.ts` EXCLUDES an unconfirmed FAQ
-- from the prefix, so a `seeded` row would insert cleanly and render nothing.
-- The question strings are composed, because the source prompt states several of these
-- facts as prose rather than as a question.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------- knowledge documents
-- Rendered as `title\nbody` under «ТАНИЛЦУУЛГА» (L3, ordinal 0). This table carries no
-- provenance column, so it renders unconditionally — which is why every line below is the
-- founder's own published wording with the price line removed, and nothing is paraphrased.

delete from knowledge_documents where tenant_id = :'tenant';

insert into knowledge_documents (tenant_id, title, body, source) values
(:'tenant',
 normalize('Дали — Хүлээн авагч (ИДЭВХТЭЙ, одоо ажиллаж байна)', NFC),
 normalize($doc$- Facebook, Instagram, вэбсайтад ирсэн зурваст шууд хариулж, үнэ, цаг, үйлчилгээний мэдээллийг өгнө.
- Захиалга, цаг товлолтыг бүртгэнэ. Шөнө ирсэн зурваст ч хариулна.
- Зөвхөн таны өгсөн үнэ, цаг, үйлчилгээний хүрээнд хариулна. Хөнгөлөлт өөрөө санал болгохгүй, шийдвэр шаардсан асуудлыг танд шилжүүлнэ.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction'),

(:'tenant',
 normalize('Вира — Бизнес аналитик (ИДЭВХТЭЙ)', NFC),
 normalize($doc$- Сар бүр борлуулалт, харилцагчийн тайланг бэлтгэж, өмнөх сартай харьцуулна.
- Аль үйлчилгээ өсч, аль харилцагч алга болсныг тоогоор хэлж, дараагийн сард юу өөрчлөхийг зөвлөнө.
- Дангаараа зарагдахгүй, өөр ажилтантай хамт авна.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction'),

(:'tenant',
 normalize('Эхо — Утасны оператор (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', NFC),
 normalize($doc$- Утсаар хүнтэй адил ярьж, асуултад хариулж, захиалгыг бүртгэнэ.
- Ажлын бус цаг, ачаалалтай үед ч дуудлага алдагдахгүй.
- Минутын үнийг хараахан зарлаагүй.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction'),

(:'tenant',
 normalize('Нова — Харилцагчийн менежер (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', NFC),
 normalize($doc$- Үйлчилгээний дараа сэтгэгдэл асууна. Цаг, төлбөр сануулна.
- Ирэхээ больсон харилцагчийг эргүүлэн дуудна.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction'),

(:'tenant',
 normalize('Ора — Хувийн туслах (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', NFC),
 normalize($doc$- Ора зөвхөн тантай ажиллана. Танай харилцагчид ч, багийнхан тань ч түүнтэй харьцахгүй.
- Мессенжер биш, зөвхөн танд нээгддэг чатаар ажиллана.
- Бичиг баримт унших, боловсруулах: гэрээ, албан бичиг, тайланг уншиж, гол агуулга, анхаарах ёстой зүйлийг нь товч хэлнэ. Шинээр боловсруулахдаа мэргэжлийн албан хэллэгээр найруулна.
- Танилцуулга бэлтгэх: уулзалт, хөрөнгө оруулагч, багийн хурлын танилцуулгыг бүтэц, тоо баримттай нь бэлдэнэ.
- Хугацаа хянах: гэрээний дуусах хугацаа, тайлангийн өдөр, төлбөрийн хуваарийг хөтөлж, хоцрохоос өмнө сануулна.
- Англи хэлнээс хөрвүүлэх: англиар ирсэн гэрээ, захидал, нэхэмжлэхийг утга санааг нь гээхгүйгээр монгол хэл рүү хөрвүүлж, ойлгомжтой тайлбарлана.
- Шийдвэр тунгаах: сонголт бүрийн давуу тал, эрсдэлийг эмхэлж, шийдэхээс өмнө тавих ёстой асуултыг санал болгоно.
- Түүнд өгсөн бичиг баримт, яриа тан дээрээ үлдэнэ. Багийнхан тань ч, танай харилцагчид ч харахгүй.
- Гэрээ бол түүний хийдэг олон ажлын нэг. Хууль зүйн зөвлөгөө өгөхгүй, өмгөөлөгчийг орлохгүй; гэрээний эцсийн шийдвэрийг та өөрөө гаргана.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction'),

(:'tenant',
 normalize('Таван AI ажилтан — нийтлэг', NFC),
 normalize($doc$- Ажилтан бүр сарын тогтмол төлбөртэй, нэг удаагийн суурилуулалттай.
- Дали, Вира, Эхо, Нова танай харилцагчидтай Facebook, Instagram, вэбсайт, утсаар монголоор өдөр шөнөгүй ярина.
- Ора харилцагчидтай ярихгүй — зөвхөн тантай ажиллана.
- Эхо, Нова, Ора хараахан ажиллаж эхлээгүй; урьдчилан бүртгүүлж болно.
- Ажилтнуудыг нэрээр нь дуудна. "Ара" гэдэг нь Далигийн, "Веда" гэдэг нь Вирагийн хуучин нэр.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction'),

(:'tenant',
 normalize('Бүтээгдэхүүн: вэбсайт', NFC),
 normalize($doc$- Ухаалаг вэбсайт: орчин үеийн дизайн, 5 хуудас, гар утсанд бүрэн тохирсон, агуулга удирдах админ самбар. Нэг удаагийн төлбөртэй, сарын төлбөргүй.
- Вэбсайтыг 7–10 ажлын өдөрт хүлээлгэн өгнө.
- Вэбсайт + Дали багцаар авах боломжтой.$doc$, NFC),
 'dalatech-chatbot buildConversationSystemInstruction');

-- ---------------------------------------------------------------- FAQs
-- «ТҮГЭЭМЭЛ АСУУЛТ», L3 ordinal 3. Answers verbatim; see the provenance note above.

delete from faqs where tenant_id = :'tenant';

insert into faqs (tenant_id, question, answer, ordinal, provenance) values
(:'tenant', normalize('Ямар бизнест тохиромжтой вэ?', NFC),
 normalize('Харилцагчийн асуулт байнга ирдэг жижиг, дунд бизнест: дэлгүүр, салон, эмнэлэг, ресторан, авто үйлчилгээ, сургалт.', NFC), 1, 'tenant_confirmed'),
(:'tenant', normalize('Техникийн мэдлэг хэрэгтэй юу?', NFC),
 normalize('Хэрэггүй. Тохиргоо, нэвтрүүлэлтийг бид хийнэ.', NFC), 2, 'tenant_confirmed'),
(:'tenant', normalize('Хүний ажилтныг орлох уу?', NFC),
 normalize('Орлохгүй. Давтан асуулт, захиалга, сануулга, тайлан зэрэг өдөр тутмын ачааллыг хариуцна; шийдвэр шаардсан асуудлыг танай багт шилжүүлнэ.', NFC), 3, 'tenant_confirmed'),
(:'tenant', normalize('AI ажилтан хэр хугацаанд ажиллаж эхэлдэг вэ?', NFC),
 normalize('AI ажилтан 3–5 хоногт ажиллаж эхэлнэ.', NFC), 4, 'tenant_confirmed'),
(:'tenant', normalize('Сарын төлбөрт юу багтдаг вэ?', NFC),
 normalize('Сарын төлбөрт сервер, загварын ашиглалт, хяналт, мэдээллийн шинэчлэлт, дэмжлэг багтана.', NFC), 5, 'tenant_confirmed'),
(:'tenant', normalize('Багийн хөнгөлөлт байдаг уу?', NFC),
 normalize('Хоёр ажилтан −10%, гурав −15%, дөрөв ба түүнээс дээш −20%. Хөнгөлөлт сарын төлбөрт хамаарна.', NFC), 6, 'tenant_confirmed'),
(:'tenant', normalize('Төлбөрийн нөхцөл ямар вэ?', NFC),
 normalize('Вэбсайт: гэрээ байгуулахад 50%, хүлээлгэн өгөхөд 50%. AI ажилтан: суурилуулалт нэг удаа, сарын төлбөр сар бүрийн эхэнд.', NFC), 7, 'tenant_confirmed'),
(:'tenant', normalize('Тусгай үнийн санал гаргадаг уу?', NFC),
 normalize('Тусгай үнийн саналыг бизнесийн чиглэл, автоматжуулах ажлын хүрээнд үндэслэн гаргана.', NFC), 8, 'tenant_confirmed');

-- ---------------------------------------------------------------- contact points
-- «ХОЛБОО БАРИХ», L3 ordinal 5. The primary key is (tenant_id, kind), so one row per kind
-- and therefore exactly one website URL.
--
-- There is deliberately NO `phone` row. The source prompt states in as many words that the
-- company publishes no number and forbids the model from producing one — and here that is
-- structural rather than an instruction (D-065): with no row, no number is in the prefix,
-- and the outbound guard refuses every numeral that is not in `allowed_numbers`.
--
-- The website row is what makes the URL quotable: `allowedUrls` is built from
-- `tenant_booking.booking_url` plus the URL-bearing contact kinds, and `urlsNotAllowed`
-- refuses a link that is in neither. Matching is on the CANONICAL form — scheme, host and
-- path — so this row covers `https://dalatech.online/` and does NOT cover
-- `app.dalatech.online`, which is why the demo tool is absent from the documents above.

delete from contact_points where tenant_id = :'tenant';

insert into contact_points (tenant_id, kind, value, is_escalation) values
(:'tenant', 'email',   'dalatech.ai@gmail.com',    true),
(:'tenant', 'website', 'https://dalatech.online/', false);

commit;
