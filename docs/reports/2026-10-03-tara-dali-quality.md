# Tara Яармаг — Дали's replies, 2026-09-26 to 2026-10-03

Read-only review of every Messenger DM of the last seven days (tenant `matrix-eco-salon`, live
project, SELECT only; Ulaanbaatar time). Customer messages are paraphrased or quoted only where
they carry nothing that identifies a person. Judged against `docs/standards/dali.md` §4.

## The picture

| | Count |
|---|---|
| Conversations with a customer DM | 134 |
| Customer text messages | 315 |
| Answered by a fixed reply / an approved line / the model | 108 / 35 / 122 |
| Not answered: held because the bot itself had just handed the chat to staff for a photo or reel | 50 (in 34 chats) |
| Reply decided but not sent: the photo's hand-off landed while the text reply was being written (`human_replied_before_send`) | 8 |
| Send failed (Meta token error during the 2026-09-26 Anthropic credit outage) | 1 |
| Weak or wrong replies that were sent (my reading, list below) | 68 — 26 of them already fixed by files applied 2026-09-30 to 2026-10-01, 42 still possible today |
| Good replies | about 188 of the 257 delivered text replies |

Public comments (25 public + 25 private replies) are reviewed rows only and were not judged.

## 1. The biggest problem: a photo or reel, then silence

A customer sends a photo or a reel of a hair colour with «how much is this?». Дали sends the
approved hand-off line («Баярлалаа! Таны илгээсэн зураг…манай ажилтан үзээд удахгүй хариулна 😊»),
the chat goes to staff for 30 minutes, and the price question is left to staff. That is the
founder's rule (D-151/D-152: «the person who can see the photo answers the price»), working as
built. What happened next, read from the staff echoes:

- 34 chats, 50 unanswered customer texts (the big burst was 2026-09-30 20:50 to 2026-10-01 01:30).
- Only 8 of the 34 chats got any staff reply, after 8 min, 12 min, 1h52, 1h55, 2h13, 2h17, 13h48
  and 24h32. **26 chats never got an answer.**
- Tara's media alert is off (D-153), and the hourly reclaim (F4) does not cover the bot's own
  media hand-off (counted `meta_holds_thread`), so nothing told anyone and nothing came back.
- In 8 more chats the customer's text reply was dropped because the photo's hand-off landed
  first (all `human_replied_before_send`); seven of those eight customers got nothing from Дали but the
  hand-off line.

**Cause:** not a defect in a row or in code; a decided rule whose other half (a person answering)
is not happening. **Fix:** the founder's choice (below, "What the founder decides"). Nothing built.

## 2. Weak replies still possible today (42)

| # | Customer asked (anonymised) | Дали sent | Should have said | Category | Cause | Fix / status |
|---|---|---|---|---|---|---|
| 1 | «how much to dye my hair», in Latin or with extra words (12 replies, 2026-09-29 to 10-03) | The colour question alone («Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх үү?»), no price | The dye rows, then that question (the fixed reply `dye_prices`) | Missed price (A4) | The message was not fully covered by `dye_prices`' words, so the model answered; it copied the row's question without the rows, and no guard added them | **Code fixed** (`handle.ts`, `set_question_unpriced`): when the customer asked a price, a set row's question with no price is served as the set row. Tests in `compose.test.ts`; reply cases need the model. About 9 of the 12 asked with a price word; the rest («Сортой будалт», «Цагаан үсний будалт») stay as they were |
| 2 | «can I book a time and come» in Latin (2026-10-01); «is there a time today» (2026-10-03) | «Уучлаарай, би энэ асуултад хариулж чадахгүй байна…» (hand-off line) | Deposits, then the booking line | Should have answered; wrong refusal | The model wrote the booking line with one word changed (0.992, 0.984) inside a longer reply; the drift check treats any adaptation found inside a reply as unsure and serves the hand-off line (D-126 addendum) | **Code fixed**: an adaptation holding 0.9 or more of the row as one unbroken run (`EMBEDDED_CERTAIN_SHARE`) gets its row. New booking stems «авч/awch» were drafted and dropped after review: they also mean «bring» and «buy» |
| 3 | «manicure?» in Latin (2026-09-30) | Hand-off line | «Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна.» | Wrong refusal | Same as #2, at 0.982 of the no-nails line | **Code fixed** (#2) |
| 4 | Price list examples (2026-10-01): model listed «маникюр» as a service; another reply asked «…or a manicure question?» (2) | Mentions manicure | No manicure at all (founder rule) | Stale old service | The manicurist's staff row (Маникюр баг) is still active | Fixed by the rename worker's `tara-yarmag-stylist-names-2026-10-03.sql` (branch `claude/tara-park-od-tenant`): switches her off. Not written here |
| 5 | «is stylist O. working / with O. today?» (2026-09-28, 10-01) (2) | «…Оюунсүрэн (Оюунаа) … мастер үсчин» | Oyunaa, SPECIAL; no schedule (Ш4) plus the booking line | Wrong fact (level), old name | Staff row tier «Мастер үсчин», Cyrillic names | Rename worker's file (Oyunaa, SPECIAL). Not written here |
| 6 | «I'll come» typed as «ochinoo» (2026-09-30) | «'Очиноо' is not in our team; our female stylists: … Отгонжаргал …» | Booking line or a short «welcome» | Misunderstood; lists a stylist not in the founder's list | Model read a verb as a name; Отгонжаргал's row is active | Rename worker's file switches Отгонжаргал off. The misreading itself: model, no fix |
| 7 | A treatment perm price, twice (2026-10-02, 10-03) | «Эмчилгээний хими (эрэгтэй): 189,000₮» + «if you meant women's, no price, call» | Depends on a fact | Possibly wrong service | The list has Эмчилгээний хими for men only; the KB calls it a gentle perm | **Question for the founder** (`prompt/drafts/tara_quality_2026-10-03.mn.txt`) |
| 8 | «Is the deposit taken off the price?» (2026-10-02) (2) | «I cannot answer, call» | The salon's answer | No answer (data gap) | Not in Tara's data | **Draft FAQ**, two options, founder picks |
| 9 | «Do you take a loan / instalment app?» (2026-10-01, three chats) (3) | Price refusal once, hand-off twice | The salon's answer | No answer (data gap) | Not in data | **Draft FAQ**, two options |
| 10 | «Which dye brand do you use?» (2026-10-03) | Hand-off line | The salon's answer | No answer (data gap) | Not in data | **Draft FAQ** |
| 11 | «colour lift» («өнгө гаргалт») price, Latin or Cyrillic (2 sent wrong: out-of-scope refusal, price refusal; more answered with dye rows) | Refusal | The matching service's rows | Wrong service match | No row or alias names «өнгө гаргалт» | **Question for the founder** (which service), then an alias |
| 12 | «shoulder length» after «full dye» (2026-10-01) | Six lines: Энгийн будаг and Өнгөлөгч будаг, all lengths | «Энгийн будаг (дунд): 180,000₮» | Over-long | The two services have identical prices, so the price guard cannot tell which the model meant and serves both | Open (data: two services, one price list) |
| 13 | «address and price», «perm price and address», «address, and do you do colour analysis» (3) | One part only | Every part (E10) | Incomplete | Model; E10 is prompt-only | No fix this round |
| 14 | «black dyed hair with grey: can a highlight be done?» and «lots of grey, can I do full dye» (2) | Hand-off line (the guard caught invented prices) | The relevant rows + «Үсэнд тань аль нь тохирохыг манай үсчин зөвлөж өгнө.» | Should have used the suitability rule | The suitability gate words («орох», «тохирох») did not match «ордог», «болох» | Open: matcher words, next round with the model run |
| 15 | «is a perm OK on fine soft hair?» (2026-10-02) | Model offered to suggest which perm suits | The stylist decides (suitability line) | Borderline advice | Same gate gap as #14 | Open |
| 16 | Complaint: the street sign was gone and the customer turned back at the door (2026-09-28) | «Уучлаарай, ойлгомжгүй байна…» | Apology + address + map link | Should have handed off | No complaint row covers it; model misread | No fix (wording is the founder's); relevant to the November move |
| 17 | «another branch near the city centre?» in Latin (2026-10-02) | Hand-off line (asked again in Cyrillic, answered well) | `branch_count` / Парк Од | Should have answered | «salvar» spelling, plus words no row covers | No fix: no row can cover «city centre» without guessing |
| 18 | «Үнэ» after «haircut + colour» (2026-10-01) | Cut prices only | Cut and dye rows | Incomplete | Model | No fix |
| 19 | Same dye rows sent twice in a row after the customer said «full» (2026-10-01) | Repeat | The length rows | Repeated answer | `dye_prices` fires on every dye word | Open, minor |
| 20 | «Тайралт нь орох уу» (2026-10-01) | Reply starting with «<br>» | No markup (D4) | Format | Model; D4 is prompt-only | No fix |
| 21 | «grey hair a lot» / «with grey hair you can dye» (2) | «didn't understand» / mild advice | A question about the service | Weak | Model | No fix |

## 3. Weak replies already fixed by files applied since (26)

Stale old services and prices before `tara-price-list-2026-10-01.sql` was applied (between 14:00 and 16:00 on
2026-10-01): Сэттинг хими answered as «Шулуун хими (сеттинг)» (5, one with «strong perm, not for
everyone»), Оффис колор / Омбре / Сор ranges (5), TARA Lumi unknown (2), «we don't do big waves» (1),
colour lift refused (2), «Sortoi budalt» → hand-off on an unformatted Сор range (1). Before
`tara-branches` / `tara-branch-count` (applied 2026-10-01): «only Яармаг, a second branch soon» (3).
Before 2026-09-30: address question → hand-off and a failed send during the credit outage (1),
«bnu» → «didn't understand» (1, fixed 2026-09-27), the retired rebrand line appended (2), deposits
without SPECIAL (1), a shared reel answered with the off-topic refusal and then «I can't see the
link» (2).

## 4. Pending provision files, read on the live project

| File | Applied? | Evidence |
|---|---|---|
| `tara-price-list-2026-10-01.sql` | Yes | New services and prices active, old ones inactive; replies changed between 14:00 and 16:00 on 2026-10-01 |
| `tara-branches-2026-10-01.sql`, `tara-branch-count-2026-10-01.sql` | Yes | `park_od_branch`, `branch_count` rows; «Салбарууд» document |
| `tara-stylist-levels-2026-10-01.sql` | Yes | `stylist_tier` starts «SPECIAL, Мастер…» |
| `tara-yarmag-move-2026-11.sql` | No, by design | For the November move |
| Rename worker's `tara-yarmag-stylist-names-2026-10-03.sql` | No (in progress on its branch) | Staff rows still Cyrillic; manicurist and Отгонжаргал active; Oyunaa «Мастер» |

So no weak reply of this week is "a ready fix not yet applied" from this repo's own files; #4–#6
wait on the rename worker's file.
