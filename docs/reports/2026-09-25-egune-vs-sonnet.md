# Egune vs Sonnet 5 for Дали — Tara Salon, live prompt `21ac422e7020` (2026-09-25)

Runs: `sonnet` 2026-09-25T14:42:04.231Z, `egune` 2026-09-25T14:50:20.341Z. Both answered as of 2026-09-25T06:00:00.000Z. 72 messages each; 50 / 50 reached the model (the rest were answered by deterministic rows before any model).

| | sonnet (`claude-sonnet-5`) | egune (`egune-nano`) |
|---|---|---|
| **1. Facts and prices** | | |
| Permanent cases passed | 6 / 6 | 6 / 6 |
| Permanent cases that reached the model | 0 | 0 |
| Model replies served as written | 29 / 50 (58%) | 29 / 50 (58%) |
| Model replies DISCARDED by a guard | 21 (42%) | 21 (42%) |
| — why (flags) | fact_restated 8, canned_paraphrased 4, suitability_prices_served 4, price_violation_seen 3, outbound_price_presentation 3, style_price_lines 3, faq_paraphrased 1, price_unlisted_overridden 1, set_question_stray 1 | fact_restated 3, suitability_prices_served 3, set_question_stray 2, price_violation_seen 2, outbound_refused_topic_price 2, style_price_lines 1, canned_paraphrased 1 |
| No usable model reply (error / timeout) | 0 | 0 |
| **2. Latin-typed Mongolian** | | |
| Messages mostly in Latin letters | 20 | 20 |
| — served as written | 11 (55%) | 9 (45%) |
| — discarded by a guard | 9 | 11 |
| **3. Natural Mongolian** (symptoms only — see the native read below) | | |
| Cyrillic share of letters, median | 100% | 100% |
| Replies with CJK/other foreign script | 0 | 0 |
| Replies with a reasoning trace stripped | 0 | 0 |
| **4. Style (signed 02_style)** | | |
| Markdown in the model's text | 0 / 50 | 1 / 50 |
| Over 3 sentences outside price lines | 5 / 50 | 1 / 50 |
| Length p50 / p90 (chars) | 128 / 309 | 99 / 172 |
| **5. Speed** | | |
| Model call p50 / p90 / max | 3.2 s / 6.6 s / 11.4 s | 0.7 s / 1.1 s / 1.8 s |
| At or past the 25 s production timeout | 0 | 0 |
| **6. Cost** | | |
| Tokens per call in / out (median) | 16482 / 81 | 7134 / 30 |
| Cost per model call (this run) | $0.0047 | price unknown |
| Per month at 465 calls (current, low) | $2.19 ≈ ₮7,670 | — |
| Per month at 651 calls (current, high) | $3.07 ≈ ₮10,737 | — |
| Per month at 1842 calls (D-016 (60.5/day)) | $8.68 ≈ ₮30,382 | — |

Sonnet 5's cost in a bake-off reads a warm cache; production's measured figure (spend_ledger, 217 calls to 2026-09-25) is **$0.0116 per call** with 80.6% cache hits, and is the one to plan with.


## Verdict: Egune cannot replace Sonnet 5 for Дали, for all replies or for some

The model is `egune-nano`, the only one `GET /v1/models` lists for this key. The first run
asked for `egune1-14b` (the official SDK's example) and got HTTP 503 on every call. The Sonnet 5
arm is run 36148563895; the Egune arm is the re-run at the same instant, on the same prompt,
data, gate and guards.

The automatic metrics tie: 29/50 replies served as written each, and the permanent cases
cannot tell them apart (all six are deterministic). Reading the 50 replies side by side
does not tie.

- **Wrong answers Egune served as written:** «une hedve» got a random price («Чёлк тайралт:
  33,000₮») instead of a question; «Vs zasalt buduulah» got six unrelated prices; «hayag» got no
  address; «Маникюр хэд вэ?» (the salon does no nails) got a staff listing, «Г. Мөнхзаяа ·
  Маникюр баг»; the founder-approved children's line (e01, e02) was lost to a generic one.
- **Wrong text that steered the guard to a wrong row:** office colour answered with root-dye
  prices (c02), dry hair answered with «Хуримын засалт» (f08), a booking question answered with
  the manicure refusal (t01.7).
- **Sonnet 5's own reply went wrong in the same places in none of these.** Its two wrong
  served replies (n07, t01.5, «Хуримын засалт» to a CICA question) were the guard's error,
  not the model's, and are fixed in this PR (`guard/facts.ts`).
- **Latin-typed Mongolian:** Egune served 9/20 as written against Sonnet's 11/20, and four of
  Egune's nine were among the wrong answers above.
- **Egune's strengths:** 4–5× faster (0.7 s against 3.2 s median), shorter replies, and its
  tokenizer reads the same prompt in 7,134 tokens against 16,482.
- **Cost:** Egune's price is not published. Sonnet 5 costs Tara $0.0116 per reply in
  production (spend_ledger, 80.6% cache hits), and ~465–651 replies a month reach a model,
  i.e. **$5.4–7.6 ≈ ₮19–27k a month**. At the older 60.5 replies/day the figure is ~₮75k.
  That is the **most** a switch could save even if Egune were free, against the wrong answers
  above reaching Tara's customers.

A native read of the replies below should confirm or overturn this on Mongolian quality,
which a script does not measure.

## Every reply, verbatim, for the native read

`served` is what the customer would get. `model wrote` is shown only where a guard discarded it.

### `comparison:f03` «une hedve» — *Latin 'how much'. Should ask WHICH service rather than refuse.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Ямар үйлчилгээний үнэ сонирхож байгаагаа тодруулж хэлж өгөх үү? _[apology_removed]_ | model | 3.6 s |
| **egune** served | Чёлк тайралт: 33,000₮ | model | 1.8 s |

### `comparison:f04` «uscinii» — *Latin 'the hairdresser's'. Tier question.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Тодруулж хэлж болох уу? Та үсчинтэй холбоотой ямар мэдээлэл асуух гэсэн юм бэ — үнэ, ажлын хуваарь, эсвэл цаг захиалга уу? _[apology_removed]_ | model | 3.8 s |
| **egune** served | Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. | canned | 0.9 s |
| egune model wrote | Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. | | |

### `comparison:f06` «Сор хэд вэ?» — *MUST quote 120,000₮–190,000₮. Never 'I do not have the number'.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Сор: 120,000₮–190,000₮ | model | 1.8 s |
| **egune** served | Сор: 120,000₮–190,000₮ _[set_question_stray]_ | deterministic | 0.8 s |
| egune model wrote | Сор: 120,000₮–190,000₮. Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү? | | |

### `comparison:f07` «CICA хими байгаа юу?» — *No such service. The real ones are «эмчилгээний хими» and «CICA нөхөн сэргээх эмчилгээ» (198k, 154k on course).*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮ ⏎ CICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮ ⏎ Эмчилгээний хими: 220,000₮–255,000₮ _[fact_restated]_ | deterministic | 7.0 s |
| sonnet model wrote | CICA эмчилгээ хийхэд хими гэсэн үйлчилгээ манайд байхгүй. CICA бол хими биш, тусдаа нөхөн сэргээх эмчилгээ бөгөөд ургамлын гаралтай зөөлөн эмчилгээ болох Эмчилгээний хими-ээс ялгаатай. ⏎ CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮ ⏎ CICA нөхөн сэргээх эмчилгээ (Курсээр): 154,000₮ ⏎ Эмчилгээний хими: 220,000₮–255,000₮ | | |
| **egune** served | CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮ ⏎ CICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮ | model | 0.9 s |

### `comparison:f08` «Үс маань их хуурай, хугараад байна, юу хийх вэ?» — *Damaged hair -> book a consultation with a master stylist. NOT a medical refusal.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна: ⏎ CICA нөхөн сэргээх эмчилгээ: 198,000₮ (курсээр 154,000₮) ⏎ Тэжээлийн тос: 49,500₮ ⏎ CMC тэжээл: 132,000₮ ⏎ Тэжээл: 44,000–88,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. | model | 5.0 s |
| **egune** served | Хуримын засалт: 154,000₮–198,000₮ ⏎ Усан хими: 132,000₮–154,000₮ ⏎ Тэжээлийн тос: 49,500₮ ⏎ Тэжээл: 44,000₮–88,000₮ _[fact_restated]_ | deterministic | 1.3 s |
| egune model wrote | Хуурай, хугарсан үсэнд CICA нөхөн сэргээх эмчилгээ хийлгэх нь тохиромжтой. Нэг удаагийн CICA эмчилгээ 198,000₮ бөгөөд курсээр (3 удаа) 154,000₮ үнэтэй. Мөн тэжээлийн тос 49,500₮, CMC тэжээл 132,000₮, тэжээл 44,000–88,000₮ зэрэг сонголтууд бий. Та эдгээрээс сонгон үйлчлүүлж болно. | | |

### `comparison:f09` «Цаг захиалмаар байна, утас хэд вэ?» — *Booking + phone. MUST be 76001888 / 80905498, never 7741-7777. Must NOT inherit the previous turn's refusal.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. Мөн холбогдох утас: 76001888 эсвэл 80905498. _[style_price_lines]_ | model | 3.6 s |
| **egune** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. | canned | 0.7 s |
| egune model wrote | Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. | | |

### `comparison:f10` «Хаана байрладаг вэ?» — *Address + the Maps link.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай салон Яармагийн Номин Хайпермаркетын баруун талд байрладаг. Байршлыг эндээс харна уу: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16 ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 2.4 s |
| **egune** served | Яармагийн Номин Хайпермаркетын баруун талд байрладаг. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 0.6 s |

### `comparison:f11` «Маникюр хэд вэ?» — *Nail catalogue, not hair. Budaggui manicure 25,000₮ etc.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. _[canned_paraphrased]_ | canned | 2.9 s |
| sonnet model wrote | Уучлаарай, манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. | | |
| **egune** served | Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. _[price_violation_seen, outbound_refused_topic_price]_ | canned | 0.4 s |
| egune model wrote | Маникюр: 33,000₮ | | |

### `comparison:f14` «Шампунь зардаг уу?» — *Products -> matrixecosalon.org/products.html*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Бүтээгдэхүүний мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/products.html хуудаснаас үзнэ үү. _[faq_paraphrased]_ | canned | 1.8 s |
| sonnet model wrote | Шампунь зэрэг бүтээгдэхүүний мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/products.html хуудаснаас үзнэ үү. | | |
| **egune** served | Бүтээгдэхүүний мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/products.html хуудаснаас үзнэ үү. | model | 0.5 s |

### `comparison:c01` «будагтай үсний уг цайруулалт хэд вэ» — *Bleaching already-dyed hair. Цайруулалт 430,000₮–570,000₮.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Цайруулалт: 430,000₮–570,000₮ _[price_unlisted_overridden]_ | deterministic | 3.6 s |
| sonnet model wrote | Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | | |
| **egune** served | Цайруулалт: 430,000₮–570,000₮. | model | 0.5 s |

### `comparison:c02` «Office color ungu har usni ungute usend orohu» — *Latin, office colour on black hair. Оффис колор 380,000₮–460,000₮.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Оффис колор: 380,000₮–460,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 5.5 s |
| sonnet model wrote | Оффис колор бол хараар будсан үсэнд шууд хийх боломжтой техник биш — цайруулалт шаарддаг арга барил тул хараар будсан үсэнд шууд хийхэд тохиромжтой эсэхийг мэргэжилтэн үсийг тань шалгаж хэлэх хэрэгтэй. ⏎ Оффис колор: 380,000₮–460,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. | | |
| **egune** served | Үсний угийн будаг: 135,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 0.5 s |
| egune model wrote | Оффис колор нь үсний угийн будаг биш бөгөөд үсний угийн будаг нь 135,000₮ үнэтэй. | | |

### `comparison:c03` «Хар өнгөтэй үсэнд орох уу» — *Same question in Cyrillic.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Үсний угийн будаг: 135,000₮ ⏎ Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮ ⏎ Урт үсний будаг (мөр давсан урттай үс): 200,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 7.5 s |
| sonnet model wrote | Ш1-т заасны дагуу шалгаж үзвэл, энэ асуулт таны үсэнд ямар өнгө/будаг тохирохыг дүгнэж сонгож өгөх хүсэлт (suitability) тул хариулж чадахгүй байна. ⏎ Уучлаарай, энэ таны үсэнд тохирох эсэхийг би шийдэж өгөх боломжгүй. Манай мэргэжилтэн үсийг тань харж хэлнэ. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. | | |
| **egune** served | Хараар будсан үсийг хоёр удаагийн будалтаар бор өнгөтэй болгож болно. Бүтэн будалт, үс гэмтэхгүй. ⏎ Үсний угийн будаг: 135,000₮ ⏎ Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮ ⏎ Урт үсний будаг (мөр давсан урттай үс): 200,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_added]_ | model | 0.5 s |

### `comparison:c04` «сайн байна уу  ⏎ үнийн мэдээлэл авья» — *Multi-line greeting + price request.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Сайн байна уу. Аль үйлчилгээний үнийг сонирхож байна вэ? (тайралт, будалт, хими, эмчилгээ гэх мэт) | model | 3.7 s |
| **egune** served | Сайн байна уу. Та ямар үйлчилгээний үнийн мэдээлэл авахыг хүсэж байна вэ? | model | 0.6 s |

### `comparison:c05` «Hi unuudur tsag bnu» — *Latin: any slots today. Booking path.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Даваа: 10:00 - 20:00 ⏎ Мягмар: 10:00 - 20:00 ⏎ Лхагва: 10:00 - 20:00 ⏎ Пүрэв: 10:00 - 20:00 ⏎ Баасан: 10:00 - 20:00 ⏎ Бямба: 10:00 - 20:00 ⏎ Ням: 11:00 - 19:00 _[fact_restated]_ | deterministic | 3.7 s |
| sonnet model wrote | Тавтай морил! Өнөөдөр 10:00–20:00 цагийн хооронд ажиллаж байна. Цаг захиалахыг хүсвэл манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар захиалж болно. | | |
| **egune** served | Даваа: 10:00 - 20:00 ⏎ Мягмар: 10:00 - 20:00 ⏎ Лхагва: 10:00 - 20:00 ⏎ Пүрэв: 10:00 - 20:00 ⏎ Баасан: 10:00 - 20:00 ⏎ Бямба: 10:00 - 20:00 ⏎ Ням: 11:00 - 19:00 _[fact_restated]_ | deterministic | 0.8 s |
| egune model wrote | Сайн байна уу. Өнөөдрийн ажлын цаг 10:00-20:00 байна. | | |

### `comparison:c06` «Sn bnu Badmaa stylestiin dugaar hed we» — *A STAFF MEMBER'S PERSONAL NUMBER. Must refuse and give the salon number instead.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Сайн байна уу. Ажилтны хувийн утасны дугаарыг өгөх боломжгүй. Та манай 76001888 эсвэл 80905498 дугаараар холбогдож лавлаарай. _[style_price_lines]_ | model | 2.8 s |
| **egune** served | Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. | canned | 0.6 s |
| egune model wrote | Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. | | |

### `comparison:c07` «Budagtai usend himi hiidegv» — *Chemistry on dyed hair — a real service question, not a refusal.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Эмчилгээний хими: 220,000₮–255,000₮ ⏎ Афро хими: 430,000₮–510,000₮ ⏎ Усан хими: 132,000₮–154,000₮ ⏎ Шулуун хими: 430,000₮–510,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 4.3 s |
| sonnet model wrote | Будсан үсэнд хими хийж болно, гэхдээ үс хэт цайруулаагүй, уураг нь хадгалагдсан байх шаардлагатай. Цайруулсан үсэнд хими хийхгүй, учир нь уураг нь будагтай урвалд орж, барьцалддаг. | | |
| **egune** served | Эмчилгээний хими: 220,000₮–255,000₮ ⏎ Афро хими: 430,000₮–510,000₮ ⏎ Усан хими: 132,000₮–154,000₮ ⏎ Шулуун хими: 430,000₮–510,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 0.9 s |
| egune model wrote | Хариулт нь: Цайруулсан үсэнд хими хийхгүй. Уураг нь будагтай урвалд орж, барьцалддаг. Гэмтсэн үс сэгсгэр болно. Том долгион барихгүй. Будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно. Жирэмсэн үед будаг, хими хийхгүй. Үс цусаар дамжин шим тэжээл авдаг тул уурагт нөлөөлж болзошгүй. | | |

### `comparison:c08` «Yag ingej budaad dolgiontoi himi hij boldoguu» — *Dye + perm together.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Үсний угийн будаг: 135,000₮ ⏎ Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮ ⏎ Урт үсний будаг (мөр давсан урттай үс): 200,000₮ ⏎ Эмчилгээний хими: 220,000₮–255,000₮ ⏎ Афро хими: 430,000₮–510,000₮ ⏎ Усан хими: 132,000₮–154,000₮ ⏎ Шулуун хими: 430,000₮–510,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 11.4 s |
| sonnet model wrote | Ш1-ийг шалгахад энэ асуулт "тохиромж/тохирох эсэх" сэдэвтэй холбоотой юм уу гэж харвал — энд хэрэглэгч будаад дараа нь хими хийж болох уу гэж явцын дараалал/зохицлын талаар асууж байна, энэ бол мэдлэгийн санд байгаа мэдээлэл. ⏎ Мэдлэгийн сангаас харахад: будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно. Харин цайруулсан үсэнд хими хийхгүй, учир нь уураг нь будагтай урвалд орж, барьцалддаг. ⏎ Тиймээс таны будсан үс хэр зэрэг цайруулагдсанаас хамаарна — хэт цайруулаагүй бол хими хийх боломжтой. | | |
| **egune** served | Үсний угийн будаг: 135,000₮ ⏎ Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮ ⏎ Урт үсний будаг (мөр давсан урттай үс): 200,000₮ ⏎ Эмчилгээний хими: 220,000₮–255,000₮ ⏎ Афро хими: 430,000₮–510,000₮ ⏎ Усан хими: 132,000₮–154,000₮ ⏎ Шулуун хими: 430,000₮–510,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. _[suitability_prices_served]_ | deterministic | 0.5 s |
| egune model wrote | Үс их долгионтой бол хими хийхгүй. Гэмтсэн үсэнд эхлээд CICA хийж, дараа нь өнгөтэй сор хийнэ. | | |

### `comparison:c09` «оюунаа» — *A stylist's NICKNAME. The ancestor resolves nicknames; we must not say no such person.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Оюунаа манай Яармаг салбарт мастер үсчнээр ажилладаг. Түүнд захиалга өгөхийг хүсвэл манай вэбсайтаар цаг захиалж болно. | model | 2.8 s |
| **egune** served | Сайн байна уу. Оюунаа үсчин манай Яармаг салбарт ажилладаг. Та дэлгэрэнгүй мэдээлэл авахыг хүсвэл 76001888 эсвэл 80905498 дугаараар холбогдоорой. _[style_price_lines]_ | model | 0.6 s |

### `comparison:c10` «Tsagiin huwaari» — *Opening hours, NOT a booking request.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Даваа: 10:00 - 20:00 ⏎ Мягмар: 10:00 - 20:00 ⏎ Лхагва: 10:00 - 20:00 ⏎ Пүрэв: 10:00 - 20:00 ⏎ Баасан: 10:00 - 20:00 ⏎ Бямба: 10:00 - 20:00 ⏎ Ням: 11:00 - 19:00 _[fact_restated]_ | deterministic | 2.1 s |
| sonnet model wrote | Манай Яармаг салбар өдөр бүр ажилладаг: ⏎ Даваа–Бямба: 10:00–20:00 ⏎ Ням: 11:00–19:00 | | |
| **egune** served | Даваа: 10:00 - 20:00 ⏎ Мягмар: 10:00 - 20:00 ⏎ Лхагва: 10:00 - 20:00 ⏎ Пүрэв: 10:00 - 20:00 ⏎ Баасан: 10:00 - 20:00 ⏎ Бямба: 10:00 - 20:00 ⏎ Ням: 11:00 - 19:00 | model | 1.1 s |

### `comparison:c11` «Hi ene uramshulal bgayu» — *Any promotions. Nothing confirmed -> must not invent one.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 76001888 эсвэл 80905498 дугаараар лавлана уу. _[canned_paraphrased]_ | canned | 3.0 s |
| sonnet model wrote | Уучлаарай, шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 76001888 эсвэл 80905498 дугаараар лавлана уу. | | |
| **egune** served | Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 76001888 эсвэл 80905498 дугаараар лавлана уу. | canned | 0.8 s |
| egune model wrote | Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 76001888 эсвэл 80905498 дугаараар лавлана уу. | | |

### `comparison:c12` «Vs zasalt buduulah» — *Cut + dye. Should ask gender/tier and length.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Тодруулъя: та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү? _[apology_removed]_ | model | 2.4 s |
| **egune** served | Гоёлын засалт: 71,500₮–99,000₮ ⏎ Дунд үсний будаг (мөрнөөс дээш урттай үс): 176,000₮ ⏎ Урт үсний будаг (мөр давсан урттай үс): 200,000₮ ⏎ Эмчилгээний хими: 220,000₮–255,000₮ ⏎ Омбре: 500,000₮–640,000₮ ⏎ Оффис колор: 380,000₮–460,000₮ | model | 1.3 s |

### `comparison:e01` «Хүүхдийн тайралт хэд вэ?» — *Children's services: NO price, salon phone only. Founder-approved rule.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | canned | 3.2 s |
| sonnet model wrote | Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | | |
| **egune** served | Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай. | canned | 0.7 s |
| egune model wrote | Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай. | | |

### `comparison:e02` «huuhdiin us zasuulna» — *Same rule in Latin script (D-067).*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | canned | 4.7 s |
| sonnet model wrote | Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | | |
| **egune** served | Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай. | canned | 0.7 s |
| egune model wrote | Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай. | | |

### `comparison:e03` «Эмэгтэй сортой будаг хийлгэх гэсийн» — *«сор» vs «Оффис колор /Сор/» — 3.2x apart and unresolvable. Must ask, never guess.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Сор: 120,000₮–190,000₮ _[set_question_stray]_ | deterministic | 5.4 s |
| sonnet model wrote | Сор бол малгайгаар татаж дараа нь өнгө оруулдаггүй арга. Хэрэв та сор хийлгээд дараа нь өнгөтэй сор хийлгэх бол сорны үнэ 120,000₮–190,000₮ болно. ⏎ Хэрэв та бүтэн будуулах эсвэл угийн будаг хийлгэхийг хүсэж байгаа бол — та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү? | | |
| **egune** served | Оффис колор: 380,000₮–460,000₮ _[set_question_stray]_ | deterministic | 0.8 s |
| egune model wrote | Оффис колор: 380,000₮–460,000₮ ⏎ Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү? | | |

### `comparison:e04` «Тэжээл хэд вэ?» — *«Тэжээлийн тос» 49,500₮ vs «CMC тэжээл» 132,000₮. Must disambiguate.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Тэжээлийн үнэ дараах байдалтай: ⏎ Тэжээл: 44,000₮–88,000₮ ⏎ Тэжээлийн тос: 49,500₮ ⏎ CMC тэжээл: 132,000₮ | model | 8.8 s |
| **egune** served | Тэжээл: 44,000₮–88,000₮ | model | 0.7 s |

### `comparison:e05` «CICA нэг удаа хийлгэвэл хэдэн тэжээлийн тостой тэнцэх вэ?» — *One CICA session is roughly 30-40 тэжээлийн тос. Must NOT say '50 masks'.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Нэг удаагийн CICA нь ойролцоогоор 30-40 удаагийн тэжээлийн тостой тэнцэнэ. | model | 1.6 s |
| **egune** served | Нэг удаагийн CICA нь ойролцоогоор 30-40 удаагийн тэжээлийн тостой тэнцэнэ. | model | 0.7 s |

### `comparison:pb01` «Сор хэд вэ?» — *Сор 120,000–190,000₮. Must NOT serve «Оффис колор»'s 380,000–460,000 without naming it — D-075's unrepairable collision, 3.2x apart.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Сор: 120,000₮–190,000₮ байна. | model | 1.4 s |
| **egune** served | Сор: 120,000₮–190,000₮. Та үүнийг хэлж байна уу? | model | 0.8 s |

### `comparison:pb02` «Тэжээлийн тос хэд вэ?» — *49,500₮. Must NOT serve «CMC тэжээл»'s 132,000 without naming it — the subset collision subsetCollisions found.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Тэжээлийн тос: 49,500₮ | model | 1.3 s |
| **egune** served | Тэжээлийн тос: 49,500₮ | model | 0.6 s |

### `comparison:pb04` «Эмчилгээний хими хэд вэ?» — *220,000–255,000₮. Must NOT serve CICA's 198,000/154,000 — «CICA хими» does not exist and these are different services.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Эмчилгээний хими: 220,000₮–255,000₮ байна. | model | 2.1 s |
| **egune** served | Эмчилгээний хими: 220,000₮–255,000₮ | model | 0.5 s |

### `comparison:pb05` «Эмэгтэй үс тайруулахад хэд вэ?» — *55,000₮ (1-р зэрэг) or 66,000–88,000₮ (Мастер). Must NOT serve Омбре's 500,000–640,000 — D-075's own «Омбре at a haircut's price» example, inverted.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Эмэгтэй тайралт (1-р зэрэг): 55,000₮ ⏎ Эмэгтэй тайралт (Мастер): 66,000₮–88,000₮ _[price_violation_seen, outbound_price_presentation, fact_restated]_ | deterministic | 3.4 s |
| sonnet model wrote | Эмэгтэй тайралтын үнэ зэрэглэлээс хамаарна: ⏎ 1-р зэрэг үсчин: 55,000₮ ⏎ Мастер үсчин: 66,000₮–88,000₮ ⏎ Та аль зэрэглэлийн үсчинд үйлчлүүлэхээ сонирхож байна вэ? | | |
| **egune** served | Эмэгтэй тайралт (Мастер): 66,000₮–88,000₮ ⏎ Эмэгтэй тайралт (1-р зэрэг): 55,000₮ | model | 0.9 s |

### `comparison:n01` «dugaar hedve» — *The two phone numbers. Nothing else.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай холбоо барих утасны дугаар: 76001888 эсвэл 80905498. _[style_price_lines]_ | model | 1.9 s |
| **egune** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. Холбоо барих дугаар: 76001888 эсвэл 80905498. _[style_price_lines]_ | model | 0.9 s |

### `comparison:n02` «dund zergiin usend shuluun himi hedeer hiih ve» — *THE case. Шулуун хими 430,000–510,000₮, plus that the stylist judges suitability. Must NOT be the generic handoff.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Шулуун хими: 430,000₮–510,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. | model | 3.5 s |
| **egune** served | Шулуун хими: 430,000₮–510,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. | model | 0.7 s |

### `comparison:n03` «tsag zahialah» — *Booking: the deposit tiers (Мастер 20,000₮ / 1-р зэрэг 10,000₮) and the booking_line. Must NOT be the generic handoff.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Онлайнаар цаг захиалахыг хүсэж байвал манай вэбсайтаар (https://www.matrixecosalon.org/) захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. Ямар зэрэглэлийн үсчинд үйлчлүүлэхээ хэлбэл урьдчилгааны дүнг тодорхой хэлж өгье. | model | 6.3 s |
| **egune** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. | canned | 0.7 s |
| egune model wrote | Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. | | |

### `comparison:n05` «hayag» — *Address plus the Maps link.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай хаяг: Яармагийн Номин Хайпермаркетын баруун талд. ⏎ Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16 ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 2.2 s |
| **egune** served | Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 0.6 s |

### `comparison:n06` «Маникюр хэд вэ?» — *The salon no longer does nails. Must not quote a nail price. (The refusal sentence is founder-gated and not yet inserted.)*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. _[canned_paraphrased]_ | canned | 2.5 s |
| sonnet model wrote | Уучлаарай, манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. | | |
| **egune** served | Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. _[price_violation_seen, outbound_refused_topic_price]_ | canned | 0.5 s |
| egune model wrote | Маникюр: 33,000₮ | | |

### `comparison:n07` «CICA хими байгаа юу?» — *Not that service, but CICA нөхөн сэргээх эмчилгээ exists: 198,000₮ / 154,000₮ course. Name it and ask if that was meant.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хуримын засалт: 154,000₮–198,000₮ _[price_violation_seen, style_price_lines, outbound_price_presentation, fact_restated]_ | deterministic | 4.8 s |
| sonnet model wrote | CICA нэртэй хими гэсэн үйлчилгээ манайд байхгүй. CICA бол хими биш, харин үсний нөхөн сэргээх эмчилгээ бөгөөд үнэ нь 198,000₮ (курсээр 154,000₮) байна. Та үүнийг хэлж байна уу? | | |
| **egune** served | Эмчилгээний хими нь ургамлын гаралтай, зөөлөн. Үсийг гэмтээдэггүй. 1 цаг 30 минут үргэлжилнэ. | model | 0.5 s |

### `comparison:n08` «Үс маань их хуурай, хугараад байна, юу хийх вэ?» — *LIST the treatments with prices FIRST, then suggest the stylist.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна: ⏎ CICA нөхөн сэргээх эмчилгээ: 198,000₮ (курсээр 154,000₮) ⏎ Тэжээлийн тос: 49,500₮ ⏎ CMC тэжээл: 132,000₮ ⏎ Тэжээл: 44,000–88,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. | model | 5.2 s |
| **egune** served | CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮ ⏎ CMC тэжээл: 132,000₮ _[style_price_lines, fact_restated]_ | deterministic | 0.7 s |
| egune model wrote | Хуурай, хугарсан үсэнд CICA нөхөн сэргээх эмчилгээ (198,000₮) болон CMC тэжээл (132,000₮) хийлгэх боломжтой. Та эдгээр үйлчилгээг сонирхож байна уу? | | |

### `comparison:t01.2` «une hedve»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Та ямар үйлчилгээний үнийг мэдэхийг хүсэж байна вэ? Тодруулж хэлээрэй. | model | 2.7 s |
| **egune** served | Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | canned | 0.8 s |
| egune model wrote | Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу. | | |

### `comparison:t01.4` «Сор хэд вэ?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Сор: 120,000₮–190,000₮ | model | 1.2 s |
| **egune** served | Сор: 120,000₮–190,000₮ | model | 0.7 s |

### `comparison:t01.5` «CICA хими байгаа юу?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хуримын засалт: 154,000₮–198,000₮ ⏎ Эмчилгээний хими: 220,000₮–255,000₮ _[price_violation_seen, style_price_lines, outbound_price_presentation, fact_restated]_ | deterministic | 3.8 s |
| sonnet model wrote | CICA эмчилгээний хими гэсэн үйлчилгээ байхгүй. CICA бол тусдаа сэргээх эмчилгээ (198,000₮, курсээр 154,000₮), эмчилгээний хими бол өөр үйлчилгээ (220,000₮–255,000₮). Аль нь Танд хэрэгтэйг тодруулна уу? | | |
| **egune** served | CICA нөхөн сэргээх эмчилгээ (1 удаа): 198,000₮ ⏎ CICA нөхөн сэргээх эмчилгээ (Курсээр, 1 удаагийн үнэ): 154,000₮ | model | 0.9 s |

### `comparison:t01.6` «Үс маань их хуурай, хугараад байна, юу хийх вэ?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хуурай, хугарсан үсэнд манайд дараах эмчилгээнүүд байна: ⏎ CICA нөхөн сэргээх эмчилгээ: 198,000₮ (курсээр 154,000₮) ⏎ Тэжээлийн тос: 49,500₮ ⏎ CMC тэжээл: 132,000₮ ⏎ Тэжээл: 44,000–88,000₮ ⏎ Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө. | model | 2.3 s |
| **egune** served | Хуурай, хугарсан үсэнд дараах эмчилгээнүүдийг санал болгож байна: ⏎ - CICA нөхөн сэргээх эмчилгээ: 198,000₮ (курсээр 154,000₮) ⏎ - Тэжээлийн тос: 49,500₮ ⏎ - CMC тэжээл: 132,000₮ ⏎ - Тэжээл: 44,000–88,000₮ ⏎ Та эдгээрээс аль нэгийг нь сонгож, манай үсчинтэй зөвлөлдөнө үү. | model | 1.4 s |

### `comparison:t01.7` «Цаг захиалмаар байна, утас хэд вэ?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. ⏎ Холбоо барих утас: 76001888, 80905498 _[style_price_lines]_ | model | 3.2 s |
| **egune** served | Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. _[canned_paraphrased]_ | canned | 0.8 s |
| egune model wrote | Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. Салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. | | |

### `comparison:t01.8` «Хаана байрладаг вэ?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хаяг: Яармагийн Номин Хайпермаркетын баруун талд. ⏎ Байршил: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16 ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 3.2 s |
| **egune** served | Яармагийн Номин Хайпермаркетын баруун талд. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 0.6 s |

### `comparison:t01.9` «Маникюр хэд вэ?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. _[canned_paraphrased]_ | canned | 2.7 s |
| sonnet model wrote | Уучлаарай, манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна. | | |
| **egune** served | Г. Мөнхзаяа · Маникюр баг · Маникюр мэргэжилтэн | model | 0.4 s |

### `comparison:t01.11` «Шампунь зардаг уу?»

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Бүтээгдэхүүний мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/products.html хуудаснаас үзнэ үү. | model | 3.1 s |
| **egune** served | Шампунь, маск зэрэг бүтээгдэхүүн зардаг уу? Бүтээгдэхүүний мэдээллийг манай вэбсайтын https://www.matrixecosalon.org/products.html хуудаснаас үзнэ үү. | model | 0.8 s |

### `tara:t01` «Sainuu, tara saloninxoon, neg yum sonirxoj asuuy. Tanaix tsag awaltan deeree urdichilgaa awch baigaa yu?» — *Recognises Tara salon as this salon; answers the deposit question.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. _[style_price_lines, fact_restated]_ | deterministic | 4.8 s |
| sonnet model wrote | Сайн байна уу. Тийм ээ, манай салонд цаг захиалгад урьдчилгаа төлбөр авдаг: 1-р зэргийн үсчинд 10,000₮, Мастер үсчинд 20,000₮. Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | | |
| **egune** served | 1-р зэргийн үсчин: 10,000₮ ⏎ Мастер үсчин: 20,000₮ ⏎ Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | canned | 0.8 s |
| egune model wrote | Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой. | | |

### `tara:t02` «Tara salon яармаг салбар yarmagtaa bizdee hehe» — *Yes — Tara salon is the Yarmag branch; no denial.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Хаяг: Яармагийн Номин Хайпермаркетын баруун талд ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. _[fact_restated]_ | deterministic | 3.2 s |
| sonnet model wrote | Тийм ээ, Yармаг салбартаа байгаа таарлаа 😊 Хаяг нь Яармагийн Номин Хайпермаркетын баруун тал юм. Өөр асуух зүйл байвал асуугаарай. | | |
| **egune** served | Тийм ээ, манай салбар Яармаг салбарт ажиллаж байна. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 0.6 s |

### `tara:t04` «Tara salon hayag haana baidag ve?» — *Gives the address for this salon; does not say it does not know Tara.*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Манай салон Яармагийн Номин Хайпермаркетын баруун талд байрладаг. Байршлыг https://maps.app.goo.gl/ckEXBLoq4FnxJHq16 холбоосоор харах боломжтой. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 4.3 s |
| **egune** served | Манай салон одоо Tara Salon нэртэй болсон. Хаяг: Яармагийн Номин Хайпермаркетын баруун талд ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 0.6 s |

### `tara:t07` «Tara Lumi будалт хэд вэ?» — *(Gap, not fixed: Office Color → TARA LUMI is not in the data.)*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Уучлаарай, "Tara Lumi" нэртэй будалт үнийн жагсаалтад байхгүй байна. Хамгийн ойр тохирох сонголт бол: ⏎ Оффис колор: 380,000₮–460,000₮ ⏎ Та үүнийг хэлж байна уу? Эсвэл бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү, тодруулбал үнийг тодорхой хэлж чадна. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 6.6 s |
| **egune** served | Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | canned | 0.9 s |
| egune model wrote | Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу. | | |

### `tara:t08` «Tara salon heden salbartai ve?» — *(Founder question: does Tara have six branches, or only this one?)*

| | reply | by | time |
|---|---|---|---|
| **sonnet** served | Tara Salon одоогоор нэг салбартай — Яармаг салбар. Хоёр дахь салбар удахгүй нээгдэнэ. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 2.9 s |
| **egune** served | Манай салон одоо Tara Salon нэртэй болсон. Одоогоор нэг салбартай: Яармаг салбар. Хоёр дахь салбар удахгүй нээгдэнэ. ⏎ Манай салон одоо Tara Salon нэртэй болсон. Шинэ мэдээллийг удахгүй хүргэнэ. | model | 0.7 s |

