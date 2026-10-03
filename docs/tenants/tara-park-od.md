# Tara Salon — Парк Од (slug `tara-park-od`, prepared, not onboarded)

A branch of Tara Salon and its own tenant (D-157). **Open since 2026-10-01 (founder). Nothing
of hers is in the project's database.** Her questionnaire is filled and proven on a local
replica (2026-10-03, again with the founder's round-2 answers on 2026-10-04); onboarding on the
project waits for the steps at the end.

## Facts (founder, confirmed 2026-10-03)

| Fact | Value |
|---|---|
| Name customers see | «Tara Salon» (form 1.1); the label people read is «Tara Salon — Парк Од» (`--display-name`) |
| Facebook Page | https://www.facebook.com/profile.php?id=100067391025472. **Page id: CONFIRM** (below) |
| Address | Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот. Equals `config/branch-groups.json` `allow_addresses` byte for byte. No Google Maps listing yet, so no map link anywhere |
| Phone | 76001888 only (the shared main line of both branches, `allow_phones`). Яармаг's 91005498 is never hers: the branch gate refuses it in her rows |
| Hours | Monday–Saturday 10:00–20:00, Sunday 11:00–19:00 |
| Hairdressers | Boloroo (SPECIAL, the owner), Saraa, Tomoo, Bulgaa, Enhuush, Chimegee, Tuchku (all Мастер; Tuchku the only man). Shown by these Latin names everywhere, the roster the model reads included; the Cyrillic spellings customers may type are only in the knowledge document «Үсчдийн нэр» (approved by the founder as written, 2026-10-04) |
| Hand-off chats | Answered by the owner, Boloroo (founder, 2026-10-04; form 2.3). Her `handoff` line is the founder's sentence «Энэ талаар манай ажилтан танд хариулна. Та 76001888 дугаараар холбогдоно уу.», as Яармаг's (PR #283). Nothing in the data routes alerts to Boloroo yet: the needs-person alert reaches the founder's Telegram, as for Яармаг |
| Prices, services | Identical to Яармаг's 2026-10-01 list (31 services), and the same booking link https://www.matrixecosalon.org/ — except that she carries **no 1-р зэрэг price** (59 prices): she has no 1-р зэрэг hairdresser and never quotes or offers that level (founder, 2026-10-04). `config/branch-groups.json` `not_offered` lets the branch gate accept the missing row; every price she does carry must equal Яармаг's |
| Deposit | 20,000₮ for every Парк Од level (SPECIAL and Мастер). Дали never says it is non-refundable |
| Children | Served: girls with a female hairdresser, boys with Tuchku; the hairdresser's level deposit |
| Manicure, pedicure | Absent: no service, price or staff of hers offers them |
| Reports and invoices | bolotuyagongor@gmail.com (billing record, `--billing-email`; not written by this round) |
| Booking account | tarasalon.parkod@gmail.com (exists, founder 2026-10-04); one Gmail per hairdresser, each sharing her calendar with it («make changes to events»), as booking@matrixecosalon.org does for Яармаг. No calendar ids yet |
| Reply style | At most one emoji (`reply_style {"max_emoji":1}`), polite «та», never recommends a level |
| Staff takeover | As Яармаг: 30-minute cool-down, the reviewed `handover_reclaim` and `handover_notice` lines, no media alert |
| The other branch | Her Дали names Яармаг (founder, 2026-10-04: «Салбарууд» symmetric): Яармаг's address, the shared 76001888 and Яармаг's Page, in KB «Салбарууд» and the fixed reply `yarmag_branch`; never 91005498 or Яармаг's map link. On Яармаг's November move both rows change with it (`tara-yarmag-move-2026-11.sql`) |
| Domain | The site moves to **tarasalon.org** (Namecheap; founder 2026-10-04). Until the switch every live link stays on matrixecosalon.org; on the switch her booking link, booking line, fixed reply `booking`, products FAQ, website contact and the two price-page rows change with Яармаг's |

## What is prepared (round 2026-10-03, branch `claude/tara-park-od-tenant`)

| File | What |
|---|---|
| `intake/tara-park-od.answers.json` | Her questionnaire's answers, from the facts above, with Яармаг's approved wording where the form asks for words (FAQs, the level text), the three approved quality answers as FAQs, and 2.3 = Boloroo |
| `intake/tara-park-od.wording.json` | Her own wording for templated sentences, passed with `--wording` on EVERY onboarding run (recorded on the tenant; a run without it, or with another file, is refused unless `--wording-changed`): the founder's `handoff` sentence and Яармаг's approved `assistant_identity` and `booking_line`, and no `refusal_topic` |
| `intake/tara-park-od.docx` | The real client form (`dali-form-v2-blank.docx`) filled from it by `scripts/onboard/fixtures/fill.ts` |
| `scripts/provision/tara-park-od-after-onboarding.sql` | What the form cannot carry: settings, hairdressers' groups, 7 canned lines, 25 fixed replies (the answers `deposit_deducted`, `loan_apps`, `dye_brand` as #283's; the 2 price-page rows disabled), 9 reply cases (inactive until her publish), 11 out-of-scope topics, the dye question, 8 knowledge documents, and the commented price-page go-live step (the `price_page` contact, as #283's). Refuses to run unless onboarding used `--wording`, her rows carry no 1-р зэрэг price, and Яармаг's address is still the one it types. NOT applied |
| `prompt/drafts/tara_park_od_wording.mn.txt` | Every line of hers that differs from Яармаг's approved bytes, exactly |

**Proven on a local PostgreSQL 16 + PostgREST 12.2.3 replica** (never the project), 2026-10-04,
from a fresh copy of Яармаг's gate-relevant rows (read-only read of 2026-10-03; Яармаг's staff,
«Салбарууд», contact points, branch rows and FAQs re-read on 2026-10-04 and unchanged) with the
stylist-names draft applied:

- onboarding dry run with `--wording`: 31 services, 7 days, 3 contacts, 7 staff, 5 FAQs, 1 deposit
  rule, 11 lines to sign, 36 reply cases; branch gate «no other branch's details, and the shared
  facts agree» (the missing 1-р зэрэг row accepted by `not_offered`); nothing written.
- `--apply` (replica only), then `tara-park-od-after-onboarding.sql` (a second run refused), then
  `--apply` again: every canned line, fixed reply, document and FAQ of hers byte-identical before
  and after the re-run (md5 over all four), «canned_responses unchanged — no signature disturbed».
  Her wording sheet holds 18 lines, `assistant_identity` and `booking_line` in Яармаг's bytes.
- `scripts/facts/branches.ts --group tara-salon` and `scripts/publish/tenant.ts` dry runs for BOTH
  tenants: branch gate clean, facts gate «every copy agrees».
- Compiled sections: her roster is Latin only and nothing she reads carries «1-р зэрэг»;
  Яармаг's roster is Latin only, «1-р зэргийн үсчин».
- The real matcher over her rows: «Яармаг салбар хаана байдаг вэ?», «Яармаг салбарын утас?»,
  «yarmag salbar haana bdag ve» → `yarmag_branch`; «Танайх хэдэн салбартай вэ?» → `branch_count`;
  «Хаяг хаана вэ», «Парк Од салбар хаана байдаг вэ?» → her own `address`; «Өнгө гаргалт хэд вэ?»,
  «ungu gargalt hed ve» → `price_page_color` appended; «Эмэгтэй хүнд эмчилгээний хими хийдэг үү?»,
  «emegtei emchilgeenii himi hed ve» → `price_page_treatment_perm` appended; «Эмчилгээний хими хэд
  вэ», «ямар өнгө гарах вэ», «Усан хими хэд вэ» → neither.
- A later `--apply` WITHOUT `--wording`, or with another wording file, is refused; a
  `refusal_topic` written by an earlier run is removed by the next run with the file. Before the
  follow-up file writes her «Үсчдийн нэр», the gate names each `staff_aliases` entry as «in none
  of tara-park-od's rows» (a note, never a refusal); after it, none.
- Her nine new reply cases (#283's seven answers and two price-page cases), switched on with the
  price-page rows and her lines signed ON THE REPLICA ONLY (a simulated signature, then restored):
  5/5 exact cases pass, 4 need the model (not run, no spend).
- Controls (all caught): her KB with 91005498, Яармаг's map link, «Oyunaa» and «Chimgee» (4 LEAK;
  her own «Chimegee» is not confused with Яармаг's «Chimgee»); her FAQ saying «Энэ хуудас бол
  Яармаг салбарын хуудас» with Яармаг's address (2 LEAK: outside `other_branch_in`); Яармаг's
  «Үсчдийн нэр» lines pasted into her KB (5 LEAK, the Cyrillic ones through `staff_aliases`);
  «Болороо» in Яармаг's KB (LEAK); a 1-р зэрэг price row in her rows (DRIFT «carries … which it
  does not offer»); a changed Мастер price (DRIFT); the round-1 control form (91005498, a Яармаг
  hairdresser, a changed price, a 1-р зэрэг row) refused at onboarding, 4 findings, nothing written.
- The November move SQL on the replica: both tenants moved (Яармаг's address row and reply,
  Парк Од's «Салбарууд» and `yarmag_branch`), branch gate clean after it, a second run refused,
  the revert byte-identical (and refused when the move is not applied); with Парк Од only partly
  provisioned (neither row yet) it moves and reverts Яармаг alone; with Парк Од not provisioned
  likewise. After the move, `tara-park-od-after-onboarding.sql` refuses until its two Яармаг
  address lines are updated.

## Page id

`--facebook-page-id` takes the Page's numeric id. 100067391025472 is the number in her
profile link; it is expected to be the Page id but cannot be checked here
(`developers.facebook.com` is blocked). Until confirmed it is a placeholder. **The founder
confirms it** in one of two ways: on the Page itself (Settings, Page transparency or About:
«Page ID»), or with her Page token, `GET https://graph.facebook.com/v21.0/me?fields=id,name`
(the `id` must be 100067391025472 and the `name` her Page's). If it differs, onboard with the
real id.

## Open questions for the founder

1. The Page id (above). Яармаг's Page link her Дали gives
   (https://www.facebook.com/profile.php?id=100067872726164, from the website's data) was
   confirmed by the founder on 2026-10-04.
2. Wording: none waits. «Салбарууд», `yarmag_branch`, «Үсчдийн нэр» (every Cyrillic spelling as
   written), the three FAQ questions and the price-page sentence were approved on 2026-10-04
   (`prompt/drafts/tara_park_od_wording.mn.txt`); the price-page rows stay disabled (step 10).
3. The shared price list's men's SPECIAL cut («Эрэгтэй тайралт» SPECIAL 89,000₮): her only man,
   Tuchku, is Мастер. If she should not quote it either, it is one more `not_offered` entry and
   one line out of her form (same mechanism as 1-р зэрэг).
4. Is another bot or a Meta away message running on her Page (form 11.3)? Яармаг's Page has one.
5. How Boloroo is told about a hand-off (today the alert reaches the founder's Telegram only).
6. The prices of «өнгө гаргалт» and women's «Эмчилгээний хими» for the website's price page: the
   founder's answer points customers there, but the new site's list has neither yet.

## Go-live steps, in order (nothing is live until the last)

1. **Facts:** confirm the Page id; answer the open questions above.
2. **Calendars:** tarasalon.parkod@gmail.com exists; each hairdresser's Gmail shares her calendar
   with it («Make changes to events»). Website booking is the lead's (`PARKOD_CALENDAR_*`).
3. **QPay:** her own merchant under the same Quick QR partner login, with her own bank account
   (`POST /v2/merchant/company`, the lead's design). Яармаг's merchant is unchanged.
4. **Page access:** a Page admin grants DalaTech access to her Page (form 11.5); the Page is
   subscribed to the app; her Page token is sealed by hand (`scripts/kek/seal.ts`).
5. **Onboard** (operator's machine, `SUPABASE_SECRET_PUBLISH`), dry run first, then `--apply`:
   `node scripts/onboard/tenant.ts --form intake/tara-park-od.docx --slug tara-park-od --wording intake/tara-park-od.wording.json --facebook-page-id <confirmed id> --display-name "Tara Salon — Парк Од"`
   (`--wording` on EVERY run of this command, the signing runs included: without it the
   template's identity and booking lines are written back over hers, unsigned)
   (billing, optional: `--billing-name … --billing-email bolotuyagongor@gmail.com`).
6. **Apply** `scripts/provision/tara-park-od-after-onboarding.sql` (one SQL editor session).
   Re-running the onboarding command afterwards leaves its rows alone (checked on the replica).
7. **Sign wording** (approved 2026-10-04, `prompt/drafts/tara_park_od_wording.mn.txt`): re-run
   step 5's command with `--apply` to get the wording sheet, which then holds all 18 canned lines
   (11 from the form, 7 from step 6); the founder signs it (`--apply --sign-wording <id> --signed-by <name>`).
8. **Client confirms** the summary (`--apply --client-confirmed "<name>" --confirmed-on <date> --summary <id>`).
   Both gates passed switches her reply cases on.
9. **Check:** `node scripts/facts/branches.ts --group tara-salon` (clean), then
   `node scripts/publish/tenant.ts --slug tara-park-od` (dry run), then once `--with-model`
   (the one paid pre-publish run, D-151, with the founder's go-ahead).
10. **Publish:** `node scripts/publish/tenant.ts --slug tara-park-od --publish`, then switch on the
    seven answer cases: `update reply_cases set active = true where tenant_id = <hers> and note like 'answers 2026-10-04%'`.
    The two price-page fixed replies stay disabled until https://www.matrixecosalon.org/services.html
    (or, after the switch, the tarasalon.org page) shows the new price list WITH a price for
    «өнгө гаргалт» and for women's «Эмчилгээний хими» (the new site's list has neither on
    2026-10-04: the salon must give them and the website add them), and migration 0083 is
    applied: run the commented step 9 of `tara-park-od-after-onboarding.sql` (rows on, the
    `price_page` contact «Үнийн хуудас» declared, the two cases on) the same day as Яармаг's
    (#283's `tara-yarmag-price-page-2026-10-04.sql` step 2), then publish both.
11. **Switch on:** the Reception entitlement and budget (money: founder), read the shadow
    replies, then move the channel to `live`.

**Each branch's Дали names the other** (D-170, symmetric since 2026-10-04): address, the shared
line and Page, from `allow_names` («Парк Од», «Яармаг») and `allow_addresses` (both addresses,
and Яармаг's VIP Center address ahead of the move). Onboard her address row with exactly the
listed text, or Яармаг's publish refuses.
