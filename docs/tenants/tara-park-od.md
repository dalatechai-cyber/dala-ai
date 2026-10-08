# Tara Salon — Парк Од (slug `tara-park-od`; in Production through runbook B8, 2026-10-08; B9 waits on D-181: docs/runbooks/park-od-dali-2026-10-05.md)

A branch of Tara Salon and its own tenant (D-157). **Open since 2026-10-01 (founder). In the
project's database since 2026-10-08 (founder: runbook B1 to B8 done; never published, channel in
shadow).** Her questionnaire is filled and proven on a local
replica (2026-10-03, again with the founder's round-2 answers on 2026-10-04); onboarding on the
project waits for the steps at the end.

## Facts (founder, confirmed 2026-10-03)

| Fact | Value |
|---|---|
| Name customers see | «Tara Salon» (form 1.1); the label people read is «Tara Salon — Парк Од» (`--display-name`) |
| Facebook Page | https://www.facebook.com/profile.php?id=100067391025472. **Page id: CONFIRM** (below) |
| Address | Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот. Equals `config/branch-groups.json` `allow_addresses` byte for byte. No Google Maps listing yet, so no map link anywhere |
| Phone | 99076874, her only number (founder, 2026-10-04, final). 76001888 and 91005498 are Яармаг's; no line is shared (`allow_phones` is empty). Her rows may give Яармаг's numbers only in KB «Салбарууд» and `yarmag_branch` (`say_phones` with `other_branch_in`); the branch gate refuses them anywhere else |
| Hours | Monday–Saturday 10:00–20:00, Sunday 11:00–19:00 |
| Online booking | Opens on the website on **Monday 2026-10-05** (founder, 2026-10-04: matrix_website `PARKOD_BOOKING=on`). Her Дали sends customers to book online (`booking`, `deposit_required`), so her rows go live only with her own publish, after that day |
| Hairdressers | Boloroo (SPECIAL, the owner), Saraa, Tomoo, Bulgaa, Enhuush, Chimegee, Tuchku (all Мастер; Tuchku the only man). Shown by these Latin names everywhere, the roster the model reads included; the Cyrillic spellings customers may type are only in the knowledge document «Үсчдийн нэр» (approved by the founder as written, 2026-10-04) |
| Hand-off chats | Answered by the owner, Boloroo (founder, 2026-10-04; form 2.3). Her `handoff` line is the founder's sentence «Энэ талаар манай ажилтан танд хариулна. Та 99076874 дугаараар холбогдоно уу.», Яармаг's sentence (PR #283) with her own number. Nothing in the data routes alerts to Boloroo yet: the needs-person alert reaches the founder's Telegram, as for Яармаг |
| Prices, services | Identical to Яармаг's 2026-10-01 list (31 services), and the same booking link https://www.matrixecosalon.org/ — except that she carries **no 1-р зэрэг price** and **no SPECIAL men's cut** (58 prices): she has no 1-р зэрэг hairdresser and never quotes or offers that level (founder, 2026-10-04), and her only men's hairdresser, Tuchku, is Мастер, so her men's cut is «Эрэгтэй тайралт: 69,000₮» only (founder, 2026-10-08). `config/branch-groups.json` `not_offered` lets the branch gate accept the missing row; every price she does carry must equal Яармаг's |
| Deposit | 20,000₮ for every Парк Од level (SPECIAL and Мастер). Дали never says it is non-refundable |
| Children | Served: girls with a female hairdresser, boys with Tuchku; the hairdresser's level deposit |
| Manicure, pedicure | Absent: no service, price or staff of hers offers them |
| Reports and invoices | bolotuyagongor@gmail.com (billing record, `--billing-email`; not written by this round) |
| Booking account | tarasalon.parkod@gmail.com (exists, founder 2026-10-04); the seven hairdressers' calendars live inside it, shared with the website's service account («make changes to events»), Ulaanbaatar time; ids in the website's `PARKOD_CALENDAR_*` (2026-10-04) |
| Reply style | At most one emoji (`reply_style {"max_emoji":1}`), polite «та», never recommends a level |
| Staff takeover | As Яармаг: 30-minute cool-down, the reviewed `handover_reclaim` and `handover_notice` lines, no media alert |
| The other branch | Her Дали names Яармаг (founder, 2026-10-04: «Салбарууд» symmetric): Яармаг's address, Яармаг's numbers 76001888 and 91005498, and Яармаг's Page, in KB «Салбарууд» and the fixed reply `yarmag_branch`; never Яармаг's map link. On Яармаг's November move both rows change with it (`tara-yarmag-move-2026-11.sql`) |
| Domain | The site moves to **tarasalon.org** (Namecheap; founder 2026-10-04). Until the switch every live link stays on matrixecosalon.org; on the switch her booking link, booking line, fixed replies `booking` and `deposit_required`, the products FAQ and the «Заавал эхлээд урьдчилгаа төлөх үү?» FAQ, website contact and the two price-page rows change with Яармаг's |

## What is prepared (round 2026-10-03, branch `claude/tara-park-od-tenant`)

| File | What |
|---|---|
| `intake/tara-park-od.answers.json` | Her questionnaire's answers, from the facts above, with Яармаг's approved wording where the form asks for words (FAQs, the level text), the three approved quality answers as FAQs, and 2.3 = Boloroo |
| `intake/tara-park-od.wording.json` | Her own wording for templated sentences, passed with `--wording` on EVERY onboarding run (recorded on the tenant; a run without it, or with another file, is refused unless `--wording-changed`): the founder's `handoff` sentence and Яармаг's approved `assistant_identity` and `booking_line`, and no `refusal_topic` |
| `intake/tara-park-od.docx` | The real client form (`dali-form-v2-blank.docx`) filled from it by `scripts/onboard/fixtures/fill.ts` |
| `scripts/provision/tara-park-od-after-onboarding.sql` | What the form cannot carry: settings, hairdressers' groups, 7 canned lines, 28 fixed replies (the answers `deposit_deducted`, `loan_apps`, `dye_brand` as #283's; D-177's `treatment_perm_women`, `colour_lift` and `colour_lift_men`, all on), 31 reply cases (inactive; switched on before her publish dry run), 11 out-of-scope topics, the dye question, 8 knowledge documents,  Refuses to run unless onboarding used `--wording`, her rows carry no 1-р зэрэг price, and Яармаг's address is still the one it types. Applied by the founder in B3 (2026-10-08) |
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
  «ungu gargalt hed ve» → `colour_lift` (women's colour rows, then her phone line); «eregtei hun ungu gargalt» → `colour_lift_men`; «Эмэгтэй хүнд
  эмчилгээний хими хийдэг үү?», «emegtei emchilgeenii himi hed ve» → `treatment_perm_women` (not
  offered; D-177); «Эмчилгээний хими хэд вэ», «ямар өнгө гарах вэ», «Усан хими хэд вэ» → neither.
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

`--facebook-page-id` takes the Page's numeric id, the `entry.id` Meta's webhooks carry.
100067391025472 is the number in her profile link and is **not confirmed** (2026-10-05: this
environment cannot reach facebook.com or graph.facebook.com, and nothing of her Page has ever
reached Production). For Яармаг the profile-link number (100067872726164) and the Page id
(1520409424715591) differ, so hers may too. The morning runbook reads the real one with her Page
token (`GET me/accounts?fields=id,name,access_token`, step B1.4) and onboards with it.

## Open questions for the founder

1. The Page id (above). Яармаг's Page link her Дали gives
   (https://www.facebook.com/profile.php?id=100067872726164, from the website's data) was
   confirmed by the founder on 2026-10-04.
2. Wording: none waits. «Салбарууд», `yarmag_branch`, «Үсчдийн нэр» (every Cyrillic spelling as
   written), the three FAQ questions and the price-page sentence were approved on 2026-10-04
   (`prompt/drafts/tara_park_od_wording.mn.txt`); the price-page rows stay disabled (step 10).
3. ~~The shared price list's men's SPECIAL cut~~ DECIDED (founder, 2026-10-08): she never quotes
   it. `not_offered` {"service": "Эрэгтэй тайралт", "variant": "SPECIAL"} and the line removed from
   her form; two model reply cases hold her to 69,000₮.
4. Is another bot or a Meta away message running on her Page (form 11.3)? Яармаг's Page has one.
5. How Boloroo is told about a hand-off (today the alert reaches the founder's Telegram only).
6. Approve the D-177 wording (docs/approvals/tara-2026-10-04/08-colour-and-treatment-perm.mn.txt):
   women's «Эмчилгээний хими» is not offered, «өнгө гаргалт» gets the colour rows. (The price page
   is dropped: the founder decided 2026-10-04 that neither is a Tara service.)

## Go-live steps (2026-10-05): the morning runbook

**Follow [`docs/runbooks/park-od-dali-2026-10-05.md`](../runbooks/park-od-dali-2026-10-05.md).**

The runbook supersedes the list that stood here: the website booking switch first, then Meta, onboarding,
her two provision files, the signing, the token, the money, all her reply cases switched on
BEFORE the publish dry run (safe: the production build runs no case of an unpublished tenant),
the one paid run, the publish, a test from the founder's phone in shadow, then live. Every step
was rehearsed on a local replica of Production's rows (2026-10-05).

Status 2026-10-08 (founder): steps through B8 done (Page 108583528037449, which does not enter
her content_hash: still `d867eed12db06ee8…`, checked on the replica). B9 failed 5 of 115; the
cause, the fix and the rerun are D-181 and the runbook's «B9 again».

What the round of 2026-10-05 added, because Яармаг's Дали has it and her form does not give it
(`scripts/provision/tara-park-od-parity-2026-10-05.sql`, + revert): the photo and reel questions
(Яармаг's approved bytes, signed on her sheet: 20 lines), 64 service aliases, 92 Latin spellings
(word pairs only, no customer evidence), Яармаг's five never-say rules, comments as Яармаг's (the
salon template's 50 rules on, both surfaces, 20 a post, starting in shadow), and 48 reply cases
mirroring Яармаг's and her men's cut (115 in all). Her Reception entitlement and ceiling (Яармаг's figures) are a
separate money file for the founder: `tara-park-od-entitlement-2026-10-05.sql`.

Still open: hand-off and complaint alerts reach the founder's Telegram, not Boloroo (open
question 5). Settled 2026-10-08: no SPECIAL men's cut at Парк Од (open question 3).
