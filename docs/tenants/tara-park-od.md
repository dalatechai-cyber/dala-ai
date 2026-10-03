# Tara Salon — Парк Од (slug `tara-park-od`, prepared, not onboarded)

A branch of Tara Salon and its own tenant (D-157). **Open since 2026-10-01 (founder). Nothing
of hers is in the project's database.** Her questionnaire is filled and proven on a local
replica (2026-10-03); onboarding on the project waits for the steps at the end.

## Facts (founder, confirmed 2026-10-03)

| Fact | Value |
|---|---|
| Name customers see | «Tara Salon» (form 1.1); the label people read is «Tara Salon — Парк Од» (`--display-name`) |
| Facebook Page | https://www.facebook.com/profile.php?id=100067391025472. **Page id: CONFIRM** (below) |
| Address | Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот. Equals `config/branch-groups.json` `allow_addresses` byte for byte. No Google Maps listing yet, so no map link anywhere |
| Phone | 76001888 only (the shared main line of both branches, `allow_phones`). Яармаг's 91005498 is never hers: the branch gate refuses it in her rows |
| Hours | Monday–Saturday 10:00–20:00, Sunday 11:00–19:00 |
| Hairdressers | Boloroo (SPECIAL, the owner), Saraa, Tomoo, Bulgaa, Enhuush, Chimegee, Tuchku (all Мастер; Tuchku the only man). Shown by these Latin names everywhere |
| Prices, services | Identical to Яармаг's 2026-10-01 list (31 services, 60 prices), and the same booking link https://www.matrixecosalon.org/ |
| Deposit | 20,000₮ for every Парк Од level (SPECIAL and Мастер). Дали never says it is non-refundable |
| Children | Served: girls with a female hairdresser, boys with Tuchku; the hairdresser's level deposit |
| Manicure, pedicure | Absent: no service, price or staff of hers offers them |
| Reports and invoices | bolotuyagongor@gmail.com (billing record, `--billing-email`; not written by this round) |
| Booking account | tarasalon.parkod@gmail.com (being created); one Gmail per hairdresser, each sharing her calendar with it («make changes to events»), as booking@matrixecosalon.org does for Яармаг. No calendar ids yet |
| Reply style | At most one emoji (`reply_style {"max_emoji":1}`), polite «та», never recommends a level |
| Staff takeover | As Яармаг: 30-minute cool-down, the reviewed `handover_reclaim` and `handover_notice` lines, no media alert |

## What is prepared (round 2026-10-03, branch `claude/tara-park-od-tenant`)

| File | What |
|---|---|
| `intake/tara-park-od.answers.json` | Her questionnaire's answers, from the facts above, with Яармаг's approved wording where the form asks for words (FAQs, the level text) |
| `intake/tara-park-od.docx` | The real client form (`dali-form-v2-blank.docx`) filled from it by `scripts/onboard/fixtures/fill.ts` |
| `scripts/provision/tara-park-od-after-onboarding.sql` | What the form cannot carry: settings, hairdressers' groups, 7 canned lines, 18 fixed replies, 11 out-of-scope topics, the dye question, 7 knowledge documents. NOT applied |
| `prompt/drafts/tara_park_od_wording.mn.txt` | Every line of hers that differs from Яармаг's approved bytes, exactly |

**Proven on a local PostgreSQL 16 + PostgREST 12.2.3 replica** (never the project), with
Яармаг's gate-relevant rows loaded from a read-only read of 2026-10-03 (every KB document,
canned line, fixed reply, FAQ and price checked equal to the project by md5) plus the
stylist-names draft:

- onboarding dry run: 31 services, 7 days, 3 contacts, 7 staff, 2 FAQs, 1 deposit rule,
  12 lines to sign, 36 reply cases; branch gate «no other branch's details, and the shared
  facts agree»; nothing written.
- the same with `--apply` (replica only): written in shadow, channel `facebook_page` with no
  token, reply cases off; branch gate and facts gate clean after writing.
- `tara-park-od-after-onboarding.sql` applied on top: every identical fixed reply, its stems,
  cover words and matchers, and the 11 topics equal Яармаг's by md5.
- `scripts/facts/branches.ts --group tara-salon`: both clean; Парк Од STALE (never published).
- `scripts/publish/tenant.ts` dry run for both: branch gate clean, facts gate «every copy
  agrees», nothing written.
- Controls: the same form with 91005498, a Яармаг hairdresser and one changed price is
  refused (2 LEAK, 1 DRIFT), nothing written.

## Page id

`--facebook-page-id` takes the Page's numeric id. 100067391025472 is the number in her
profile link; it is expected to be the Page id but cannot be checked here
(`developers.facebook.com` is blocked). Until confirmed it is a placeholder. **The founder
confirms it** in one of two ways: on the Page itself (Settings, Page transparency or About:
«Page ID»), or with her Page token, `GET https://graph.facebook.com/v21.0/me?fields=id,name`
(the `id` must be 100067391025472 and the `name` her Page's). If it differs, onboard with the
real id.

## Open questions for the founder

1. The Page id (above). Who receives her new requests (form 2.3), and who reads her hand-off
   chats (Oyunaa does Яармаг's)?
2. The shared price list has 1-р зэрэг prices («Эмэгтэй тайралт» 1-р зэрэг 66,000₮) and a
   SPECIAL men's cut (89,000₮), but Парк Од has no 1-р зэрэг hairdresser and her only man is
   Мастер. Prices must stay identical in both branches (D-157; the gate refuses otherwise), so
   Дали could quote a level she does not have. How should Дали answer there?
3. The Cyrillic spellings customers will type for her hairdressers: none was given, so none is
   written (never guessed). Without them the branch gate cannot find a Cyrillic spelling of her
   names in Яармаг's rows, and her Дали has only the Latin names to match.
4. Is another bot or a Meta away message running on her Page (form 11.3)? Яармаг's Page has one.
5. Should her Дали name Яармаг (address, 91005498, Page), as Яармаг's names her (D-170)? Today
   it does not, and the gate refuses it until `config/branch-groups.json` allows it.

## Go-live steps, in order (nothing is live until the last)

1. **Facts:** confirm the Page id; answer the open questions above.
2. **Calendars:** create tarasalon.parkod@gmail.com; each hairdresser's Gmail shares her calendar
   with it («Make changes to events»). Website booking is the lead's (`PARKOD_CALENDAR_*`).
3. **QPay:** her own merchant under the same Quick QR partner login, with her own bank account
   (`POST /v2/merchant/company`, the lead's design). Яармаг's merchant is unchanged.
4. **Page access:** a Page admin grants DalaTech access to her Page (form 11.5); the Page is
   subscribed to the app; her Page token is sealed by hand (`scripts/kek/seal.ts`).
5. **Onboard** (operator's machine, `SUPABASE_SECRET_PUBLISH`), dry run first, then `--apply`:
   `node scripts/onboard/tenant.ts --form intake/tara-park-od.docx --slug tara-park-od --facebook-page-id <confirmed id> --display-name "Tara Salon — Парк Од"`
   (billing, optional: `--billing-name … --billing-email bolotuyagongor@gmail.com`).
6. **Apply** `scripts/provision/tara-park-od-after-onboarding.sql` (one SQL editor session).
   Re-running the onboarding command afterwards leaves its rows alone (checked on the replica).
7. **Approve wording:** read `prompt/drafts/tara_park_od_wording.mn.txt`; re-run step 5's
   command with `--apply` to get the wording sheet, which then holds all 19 canned lines (12
   from the form, 7 from step 6); sign it (`--apply --sign-wording <id> --signed-by <name>`).
8. **Client confirms** the summary (`--apply --client-confirmed "<name>" --confirmed-on <date> --summary <id>`).
   Both gates passed switches her reply cases on.
9. **Check:** `node scripts/facts/branches.ts --group tara-salon` (clean), then
   `node scripts/publish/tenant.ts --slug tara-park-od` (dry run), then once `--with-model`
   (the one paid pre-publish run, D-151, with the founder's go-ahead).
10. **Publish:** `node scripts/publish/tenant.ts --slug tara-park-od --publish`.
11. **Switch on:** the Reception entitlement and budget (money: founder), read the shadow
    replies, then move the channel to `live`.

**Яармаг's Дали names her** (D-170): her address, the shared line and her Page, from
`allow_names` («Парк Од») and `allow_addresses`. Onboard her address row with exactly that
text, or Яармаг's publish refuses.
