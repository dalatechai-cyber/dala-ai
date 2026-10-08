# Morning runbook: Парк Од's Дали goes live (written 2026-10-05, overnight)

Everything Claude could do is done and rehearsed (see «What was proven» at the end). What is
left needs your hands: your Meta login, your Supabase secret key, your KEK, your money call and
your phone. Do the steps **in order**. Each step says what you should see and how to undo it.
Nothing here touches Яармаг's rows; the steps that could disturb Яармаг are marked **⚠ Яармаг**.

Rough time: 60–90 minutes. One paid step (B9, about $0.20–0.40 of model calls, printed).

**Before step A, merge** the dala-ai pull request this runbook came in (it fixes the onboarding
command, step B3 needs it). Its code is used only by the commands on your Mac; nothing that
answers customers changes.

Names used below:

- **SQL editor** = Supabase → project `tlggenaatnopnxzbkbuf` → SQL editor. Paste the whole file,
  press Run. Every file refuses a second run and checks itself at the end.
- **Mac** = your terminal in `~/dalatech/dala-ai`, set up as in matrix_website
  `docs/LAUNCH_DAY_TARA.md` «Your Mac». Define these once per terminal:

  ```
  cd ~/dalatech/dala-ai && git checkout main && git pull && npm ci
  export NEXT_PUBLIC_SUPABASE_URL=https://tlggenaatnopnxzbkbuf.supabase.co
  export SUPABASE_SECRET_PUBLISH="$(security find-generic-password -s dala-supabase-publish-mac -w)"
  onboard() { node scripts/onboard/tenant.ts --form intake/tara-park-od.docx --slug tara-park-od \
    --wording intake/tara-park-od.wording.json --facebook-page-id "$PAGE_ID" \
    --display-name "Tara Salon — Парк Од" "$@"; }
  ```

---

## A. Website booking ON first (matrix_website, Vercel) — before anything is published

Her Дали sends people to book online. It must not be published while her booking is closed.

1. Vercel → **matrix-website** → Settings → Environment Variables → Production → add
   `PARKOD_BOOKING` = `on` → Save → Deployments → the latest Production deployment → ⋯ →
   **Redeploy**. Wait for **Ready**.
2. *You should see:* https://www.matrixecosalon.org/api/branches shows `"id":"parkod"` with
   `"ready":true` and 7 stylists (checked at 05:00 UTC today: `"ready":false`, 0). The booking
   page offers Парк Од's hairdressers and free times. Make no payment.
3. *Undo:* delete `PARKOD_BOOKING` (or set it to anything but `on`) → Redeploy. Her branch shows
   «Онлайн захиалга удахгүй нээгдэнэ.» again. If A is undone after B10, also do the undo of B10.

---

## B. Дали for Парк Од (dala-ai)

### B1. Meta: give the DALA_AI app her Page and read her Page token — ⚠ Яармаг

You are admin of her Page now, so this is the same path as Яармаг's token (your login), no
partner assignment, no App Review (see «Meta» at the end).

1. Open https://developers.facebook.com/tools/explorer/ → top right **Meta App: DALA_AI**
   (id 1562862634970492) → **User or Page: User Token** → Permissions: `pages_show_list`,
   `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`,
   `pages_read_user_content`, `pages_manage_engagement` → **Generate Access Token**.
2. Facebook asks which Pages DALA_AI may use. **⚠ Яармаг: keep Tara (Яармаг) and DalaTech
   ticked and ADD Парк Од.** If you untick Яармаг's Page here, Meta withdraws the app's access to
   it for your login, her sealed token stops working and Яармаг goes quiet. (Never use the App
   Dashboard's «Add Page» picker either: it replaces the app's whole Page list; D-043.)
3. Copy the token → https://developers.facebook.com/tools/debug/accesstoken/ → paste → Debug →
   **Extend Access Token** → copy the long-lived user token.
4. Explorer, with that long-lived token in the token box: `GET me/accounts?fields=id,name,access_token`
   → Submit. Find Парк Од's entry.
   - Its **`id` is her Page ID**. Expected `100067391025472`; it may differ (Яармаг's profile link
     says 100067872726164, her Page ID is 1520409424715591). Use what this says, everywhere below.
   - Its **`access_token` is her Page token**. Keep it only in your terminal: never paste it into
     chat, a file or this repository.
5. In your Mac terminal (`read -s` keeps the token out of the screen and the shell history; it
   lives only in this terminal):

   ```
   export PAGE_ID=<the id from 4>
   read -rs PAGE_TOKEN   # paste the access_token, press Enter (nothing is shown)
   export PAGE_TOKEN
   ```

6. Debug the **Page** token in the Access Token Debugger. *You should see:* Type **Page**, App ID
   **1562862634970492**, Page ID = `$PAGE_ID`, Expires **Never**, the six scopes. Write down
   «Data Access Expires» (a date, or Never).
7. **⚠ Яармаг check:** from your phone, send Яармаг's Page «Сайн байна уу». *You should see:*
   «Сайн байна уу! Tara Salon-д тавтай морил. Танд юугаар туслах вэ?». If not, redo 1–2 with
   Яармаг's Page ticked; nothing else is needed.
8. *Undo:* Facebook → Settings → Business integrations → DALA_AI → View and edit → untick only
   Парк Од. Never remove the app.

### B2. Onboard her (Mac): dry run, then write

1. `onboard` → *You should see:* `Channels   facebook_page <PAGE_ID> — shadow`,
   `branches: tara-park-od (tara-salon): no other branch's details, and the shared facts agree.`,
   ten «staff_aliases … is in none of tara-park-od's rows» notes (expected now: the form does not
   carry her «Үсчдийн нэр» document; B3 adds it), and `DRY RUN — nothing written. The tenant
   would be CREATED.`
2. `onboard --apply` → *You should see:* `created tenant tara-park-od (<uuid>)`,
   `facebook_page <PAGE_ID>: created, delivery_mode=shadow, no token`,
   `36 reply_cases, inactive (36 added, 0 changed, 0 retired)`, `Wording    11 lines await the
   founder — sheet …`.
3. *Undo:* a tenant cannot be deleted on the project (append-only tables refuse, by design). It
   stays unpublished, in shadow, with no token: no customer is affected. Tell Claude.

### B3. Her rows (SQL editor), then the wording sheet (Mac)

1. SQL editor: `scripts/provision/tara-park-od-after-onboarding.sql` → *You should see:* «Success.
   No rows returned».
2. SQL editor: `scripts/provision/tara-park-od-parity-2026-10-05.sql` (what Яармаг has that the
   form does not give her: the photo and reel questions, 64 service aliases, 92 Latin spellings,
   the five never-say rules, comments as Яармаг's in shadow, 48 more reply cases) → «Success».
   *Undo (before B10 only):* `scripts/provision/tara-park-od-parity-2026-10-05-revert.sql`, then
   `onboard --apply` once (it puts the generated video-link case back to the media line).
3. `onboard --apply` → *You should see:* `50 comment_rules (50 left enabled, the rest disabled)`,
   `36 reply_cases, inactive (0 added, 1 changed, 0 retired)` (the video-link case now expects her
   reel question), `Wording    20 lines await the founder — sheet <SHEET>`,
   `Facts      64 rows await the client — summary <SUMMARY>`. (Rehearsal ids: sheet
   `2ed4c7041aca`, summary `d81c5ab405ac`; yours may differ if the Page ID differs.)
4. Read `onboarding/tara-park-od/wording-sheet.md`: 20 lines, every one approved by you on
   2026-10-04, or Яармаг's approved bytes (the photo and reel questions, items 4 and 7).
5. `onboard --apply --sign-wording <SHEET> --signed-by Bilguun` → `signed 20 Mongolian lines`,
   `Wording    SIGNED`.
6. `onboard --apply --client-confirmed "Болор" --confirmed-on 2026-10-05 --summary <SUMMARY>` →
   `client confirmation recorded on 64 rows`, `both gates passed: 36 reply cases switched on`,
   `Facts      CONFIRMED by the client`.

### B4. Seal her Page token (Mac) and connect the channel (SQL editor)

1. SQL editor (read only):

   ```sql
   select t.id as tenant, c.id as channel, c.external_id
     from tenants t join tenant_channels c on c.tenant_id = t.id
    where t.slug = 'tara-park-od' and c.provider = 'facebook_page';
   ```

   `external_id` must equal `$PAGE_ID`.
2. Mac. The KEK is the **same `TENANT_KEK_V2` you sealed Яармаг's token with on 2026-09-21**
   (Vercel cannot show it back, D-107). If you do not have it, stop here and tell Claude: a token
   sealed under another key cannot be opened by Production and her Дали would be silent. Never
   generate a new KEK.

   ```
   read -rs TENANT_KEK_V2; export TENANT_KEK_V2 TENANT_KEK_ACTIVE_VERSION=v2
   printf %s "$PAGE_TOKEN" | node scripts/kek/seal.ts --tenant <tenant> --channel <channel> \
     --kind page_token --expires-at never --data-access-expires-at <date from B1.6, or never> > /tmp/parkod-seal.sql
   ```

   *You should see:* `seal: the ciphertext above decrypts back to the input under the active KEK.`
3. SQL editor: paste `/tmp/parkod-seal.sql` → Run → «1 row». Then delete the file
   (`rm /tmp/parkod-seal.sql`).
4. SQL editor:

   ```sql
   update tenant_channels
      set token_status = 'active', name_confirmed_at = now(), status = 'active',
          verified_name = '<her Page name from B1.4>'
    where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page'
   returning delivery_mode, token_status, comment_policy, comment_delivery_mode;
   ```

   *You should see:* `shadow | active | both | shadow`.
5. Mac: `node scripts/kek/verify.ts --tenant tara-park-od --channel "$PAGE_ID"` → it opens the
   row with your key (it cannot prove Production holds the same key; B11 does).
6. Subscribe **her** Page to the app (**her** id, **her** token only; never Яармаг's):

   ```
   printf 'subscribed_fields=messages,feed,message_echoes&access_token=%s' "$PAGE_TOKEN" \
     | curl -sS -X POST "https://graph.facebook.com/v21.0/$PAGE_ID/subscribed_apps" --data @-
   printf 'access_token=%s' "$PAGE_TOKEN" | curl -sS -G "https://graph.facebook.com/v21.0/$PAGE_ID/subscribed_apps" --data @-
   ```

   (`printf` is a shell built-in, so the token never appears in a command line `ps` can see.)

   *You should see:* `{"success":true}`, then DALA_AI with `messages`, `feed`, `message_echoes`.
   (The list is a replacement: always send all three.) The app-level webhook fields already exist
   (Яармаг's traffic uses them); nothing else changes at Meta.
7. SQL editor: `update tenant_channels set subscribed_fields = '{messages,feed,message_echoes}'
   where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page';`
8. *Undo:* `printf 'access_token=%s' "$PAGE_TOKEN" | curl -sS -X DELETE "https://graph.facebook.com/v21.0/$PAGE_ID/subscribed_apps" --data @-`;
   SQL: `update tenant_channels set delivery_mode = 'shadow', token_status = 'unprovisioned' where
   tenant_id = (select id from tenants where slug = 'tara-park-od');` and
   `delete from tenant_secrets where tenant_id = (select id from tenants where slug = 'tara-park-od');`

### B5. Money (SQL editor) — your call

`scripts/provision/tara-park-od-entitlement-2026-10-05.sql`: the Reception entitlement and
Яармаг's ceiling copied (daily $2.00 × 0.95 = $1.90; monthly $28.57 as an alert). Change a figure
in the file first if hers should differ. → «Success». *Undo:* in the file's header.

### B6. Switch on all her reply cases (SQL editor)

Safe before the publish: the production build runs no case of a tenant that has never been
published, and the publish dry run (B8) runs them against what it is about to publish.

```sql
update reply_cases set active = true
 where tenant_id = (select id from tenants where slug = 'tara-park-od') and not active;
```

*You should see:* `UPDATE 79` (115 cases in all; 36 were switched on in B3.6).

### B7. Branch gate (Mac)

`node scripts/facts/branches.ts --group tara-salon` → *You should see:* both
`branches: matrix-eco-salon (tara-salon): no other branch's details, and the shared facts agree.`
and the same for tara-park-od; Яармаг `live snapshot: current on facebook_page.`; one finding for
Парк Од (`live snapshot: STALE … publish it`): she has never been published. Anything else: stop.

### B8. Publish dry run (Mac)

`node scripts/publish/tenant.ts --slug tara-park-od` → *You should see:*
`content_hash    d867eed12db06ee8…` (if her Page ID is 100067391025472; another id gives another
hash), `tara-park-od: 63/63 reply cases pass · 52 need the model and were not run`,
`facts: tara-park-od: every copy agrees with the rows.`, `Dry run. Nothing was written.`

### B9. The one paid run (Mac) — her 52 model cases

```
ANTHROPIC_API_KEY="$(security find-generic-password -s dala-anthropic-publish-mac -w)" \
  node scripts/publish/tenant.ts --slug tara-park-od --with-model
```

*You should see:* every case pass, `MODEL RUN COST … $0.xx` (expected about $0.20–0.40), `Dry run.`
If a case fails, stop and send Claude the output; do not publish.

### B9 again (added 2026-10-08, after the first B9 failed 5 of 115)

What failed and why: D-181 in `docs/DECISIONS.md`. In short: four price questions got a reply with
no price for the service they named, which Яармаг's Дали can do too (same price rows, same model
input); the fix is in the code and covers both branches. The deposit case judged the wrong thing;
one SQL file corrects it. In this order:

1. **Merge** the dala-ai pull request «Парк Од B9: a named service's price is always given» (your
   go). ⚠ Яармаг: this changes Яармаг's replies too, in two ways only: after a model reply with no
   price, a price question that named a service gets that service's price rows first; and a price
   question about the deposit whose reply states no deposit amount gets the deposit rows first. Wait
   until Vercel shows the Production deployment of the merge commit **Ready**.
2. **Mac:** `git checkout main && git pull && npm ci` (the publish script runs your checkout).
3. **SQL editor:** paste `scripts/provision/tara-park-od-deposit-case-2026-10-08.sql`, Run →
   «Success». It changes one reply case of hers and nothing she says.
   *Undo:* `scripts/provision/tara-park-od-deposit-case-2026-10-08-revert.sql`.
4. **B8 again** (Mac): `node scripts/publish/tenant.ts --slug tara-park-od` → exactly as in B8:
   `content_hash    d867eed12db06ee8…`, `tara-park-od: 63/63 reply cases pass · 52 need the model
   and were not run`, `facts: tara-park-od: every copy agrees with the rows.`, `Dry run.`
5. **B9 again** (Mac), the only paid step, about $0.33 (at most $0.40):

   ```
   REPLY_GATE_PRINT=1 ANTHROPIC_API_KEY="$(security find-generic-password -s dala-anthropic-publish-mac -w)" \
     node scripts/publish/tenant.ts --slug tara-park-od --with-model
   ```

   *You should see:* `tara-park-od: 115/115 reply cases pass`, `MODEL RUN COST … $0.3x`, `Dry run.`
   `REPLY_GATE_PRINT=1` costs nothing extra: it prints every case's reply under `EVERY REPLY`, so
   the five that failed can be read (search for `case 201`, `206`, `207`, `208`, `247`). A
   `named_service_unpriced` or `deposit_unpriced` flag beside a reply means the model again gave no
   price and the platform put the rows first. Without it, only failing cases' replies print.
   If any case fails: stop, do not publish, and send Claude the `THE REPLIES THAT DID NOT PASS` block.

Яармаг's side, only on your go and in no hurry: `scripts/provision/tara-yarmag-price-twins-2026-10-08.sql`
gives Яармаг the same four price cases and the same deposit-case correction (undo: its
`-revert.sql`). Reply cases only: no republish, nothing she says changes.

### B10. Publish (Mac) — only after A shows `"ready":true`

`node scripts/publish/tenant.ts --slug tara-park-od --publish` → `PUBLISHED  seq 1  …`.
Her channel is still in shadow: customers get nothing yet.
*Undo:* a revision cannot be unpublished; keep (or put) her channel in shadow
(`update tenant_channels set delivery_mode = 'shadow', comment_delivery_mode = 'off' where tenant_id
= (select id from tenants where slug = 'tara-park-od');`) and tell Claude.

### B11. Test from your own phone while customers still get nothing (shadow + you)

1. From your **personal** Messenger, message **her** Page one unusual word, e.g. «туршилт4821».
   No reply (shadow). Then SQL editor (a real customer may have written in the meantime, so
   find yours by that word, not by time):

   ```sql
   select c.external_id, m.at from messages m join conversations v on v.id = m.conversation_id
     join contacts c on c.id = v.contact_id
    where m.tenant_id = (select id from tenants where slug = 'tara-park-od') and m.body = 'туршилт4821';
   ```

   That `external_id` is your PSID on her Page. Then:

   ```sql
   update tenant_channels set test_sender_ids = array['<your PSID>']
    where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page';
   ```

   From now on Дали answers **you** on her Page; every other person still gets nothing.
2. Send the messages in «Messages to send» below, in order. Each reply must match.
   `select last_ok_at from tenant_secrets where tenant_id = (select id from tenants where slug = 'tara-park-od');`
   advancing proves Production opened her token.
3. Comments, from your **personal profile** (not as the Page: a comment by the Page is the
   Page's own and is never answered): comment «Үнэ хэд вэ?» on one of her posts. Nothing happens
   yet. Then:

   ```sql
   select comment_from_id from outbound_messages
    where tenant_id = (select id from tenants where slug = 'tara-park-od') and comment_from_id is not null
    order by created_at desc limit 1;
   update tenant_channels set test_sender_ids = test_sender_ids || '<that id>'
    where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page';
   ```

   Then the comments in «Comments to post» below, **each on a different post, and none on the
   post you just used** (Дали answers one person once per post, and the shadow draft there may
   already count).

### B12. Live

```sql
update tenant_channels set delivery_mode = 'live', comment_delivery_mode = 'live', went_live_at = now()
 where tenant_id = (select id from tenants where slug = 'tara-park-od') and provider = 'facebook_page';
```

*You should see:* customers' messages to her Page answered; `last_ok_at` keeps moving. Hand-off
chats and complaint comments alert **your** Telegram (Boloroo is not wired yet: tell her, or
forward). *Undo:* `delivery_mode = 'shadow'`, `comment_delivery_mode = 'shadow'` (or `off`).

---

## Messages to send (B11, from your phone to her Page, in this order)

Each reply is her own row, byte for byte (rehearsed through the real worker on a replica).

| You send | Дали answers |
|---|---|
| «Ok» | «Өөр асуух зүйл байвал бичээрэй.» |
| «Хаяг хаана вэ» | «Хаяг: Баянзүрх дүүрэг, 26-р хороо, Парк-Од молл, 4 давхар, 405 тоот» (no map link) |
| «Утас хэд вэ» | «Та 99076874 дугаараар холбогдоно уу.» |
| «Танай хэдэн салбартай вэ?» | «Tara Salon хоёр салбартай: Яармаг салбар, Парк Од салбар.» |
| «Яармаг салбар хаана байдаг вэ?» | «Яармаг салбарын хаяг: Яармагийн Номин Хайпермаркетын баруун талд / Утас: 76001888, 91005498 / Фэйсбүүк хуудас: https://www.facebook.com/profile.php?id=100067872726164» (the only reply that names Яармаг's numbers) |
| «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу» | «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.» |
| «Заавал эхлээд урьдчилгаа хийх үү?» | «Онлайнаар цаг захиалахад урьдчилгаа төлбөр төлж, цагаа баталгаажуулна. Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно. Цагаа эндээс захиална уу: https://www.matrixecosalon.org/» |
| «Зээлийн апп-аар төлж болох уу» | «Одоогоор зээлийн аппаар төлбөр авдаггүй.» |
| «SPECIAL үсчин» | «SPECIAL болон Мастер үсчний ялгаа нь зэрэглэл болон үнэд байдаг. Аль зэрэглэлийн үсчинд үйлчлүүлэхээ та өөрөө сонгоно. Ямар үйлчилгээ авахаа хэлбэл үнийг нь хэлье.» (no 1-р зэрэг) |
| «SPECIAL үсчинд урьдчилгаа хэд вэ?» | an answer with 20,000₮, never 10,000₮ (model) |
| «Ямар брэндийн будаг хэрэглэдэг вэ» | «Энэ талаар манай ажилтан танд хариулна. Та 99076874 дугаараар холбогдоно уу.» |
| «Ажилтантай холбогдмоор байна» | the same hand-off line, and a needs-person alert on your Telegram |
| «ungu gargalt hed ve» | «Манай өнгөний үйлчилгээний үнэ: / Хэсэгчилсэн сор (эмэгтэй): 150,000₮ / Бүтэн сор: 210,000₮ / / Та 99076874 дугаараар холбогдоно уу.» |
| «Эмэгтэй эмчилгээний хими хийдэг үү» | «Манай салон одоогоор эмэгтэй эмчилгээний химийн үйлчилгээ үзүүлэхгүй байна.» |
| «Маникюр хийдэг үү?» | «Манай салон одоогоор хумсны үйлчилгээ үзүүлэхгүй байна.» |
| a 👍 like | «Өөр асуух зүйл байвал бичээрэй.» (the welcome line only as a chat's very first message) |
| a hair photo, no text | «Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.» |
| then «Tara perm урт» | a model answer with 290,000₮ (Tara perm, урт), not the hand-off line (D-179) |
| another hair photo, then after 31 s «hed ve» | «Баярлалаа! Таны илгээсэн зураг, бичлэг, холбоосыг манай ажилтан үзээд удахгүй хариулна 😊» (a person is told) |
| a reel link, e.g. any https://www.facebook.com/share/r/… | «Уучлаарай, би бичлэг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.» |
| a voice message | «Уучлаарай, би дуут зурвас сонсох боломжгүй. Та асуултаа бичиж илгээвэл баяртайгаар хариулна.» |
| «ci henbe» | «Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.» |
| «баярлалаа» | «Зүгээр ээ 😊 Өөр асуух зүйл байвал бичээрэй.» |

No reply may contain 76001888, 91005498, Яармаг's address or a Яармаг hairdresser except the
«Яармаг салбар» row. Then, on **Яармаг's** Page, «Парк Од салбарын утас?» must give Парк Од's
address and «Утас: 99076874» (unchanged since 2026-10-04).

## Comments to post (B11.3; each on a different post of hers)

| You comment | What happens |
|---|---|
| «Үнэ хэд вэ?» | public reply «Сайн байна уу! Манай хуудас руу мессеж бичвэл дэлгэрэнгүй хариулъя 😊» and a private message «Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.» |
| «Хаана байрладаг вэ?» | the same public reply and private message |
| «Маш муу үйлчилгээ, их удаан хүлээлгэсэн» | nothing public; a complaint alert on your Telegram |
| «Гоё байна 😍» | nothing |
| «Хямдралтай цүнх зарна, 99112233 утсаар залгаарай, ердөө 50,000₮» (an advert) | nothing (not answered, not hidden) |

---

## Meta, read only (2026-10-05)

- **Her Page ID is not confirmed.** This environment cannot reach facebook.com or
  graph.facebook.com (403 at the proxy), and nothing of her Page has ever reached Production
  (no unrouted webhook from it). 100067391025472 is the number in her profile link; for Яармаг the
  profile-link number (100067872726164) and the Page ID (1520409424715591) differ, so hers may
  too. B1.4 reads the real one; B2 uses it.
- **What her Page needs:** DALA_AI granted her Page through your login (B1.1–2); her Page token
  (B1.4); the Page-level subscription `messages,feed,message_echoes` (B4.6). The app-level webhook
  (object `page`, fields `messages` and `feed`) and `META_APP_SECRETS` / `META_VERIFY_TOKENS`
  already serve Яармаг through DALA_AI (her channel's `meta_app_id` reads 1562862634970492 in
  Production today; CLAUDE.md's older line about the `dalatech` app predates the 2026-09-24
  cutover, D-118) and need nothing for a second Page. Her channel uses
  Яармаг's callback slug (`dalatech`) and DALA_AI's app id, set by the parity file.
- **Meta's approval:** none expected. `pages_messaging` is at Advanced Access on DALA_AI; the
  comment permissions were granted «no review required» on DALA_AI (D-106). Both readings are
  yours from the App Dashboard, not checkable here. Through your own admin login her Page is in
  the same position as Яармаг's. If token generation or a comment reply refuses on a permission,
  send Claude the exact error before changing anything.
- **Check on her Page:** another bot or app set as the Page's primary receiver would put
  Дали's messages in «standby» (Settings → Advanced messaging); Дали then raises a critical
  alert and answers nobody. Meta's default away message is recognised as not a person (both
  apostrophe forms are on her channel); a custom away message or instant reply would also be
  sent beside Дали's answers.

## What was proven overnight (local replica, never Production)

- Production read only. Яармаг's rows copied into a scratch PostgreSQL 16 + PostgREST 12.2.3 and
  checked equal to Production table by table (count and md5); Яармаг's publish dry run there
  gives Production's live `content_hash` 6515…4fbd, 62/62.
- The whole of section B in this order (B1 and the real Page token simulated with a throwaway
  token and KEK), on a fresh copy: every step's output as written above. Re-runs refused; the
  parity revert works and then refuses a second time.
- Her publish dry run: 63/63 reply cases pass, facts and branch gates clean. 52 model cases were
  NOT run (no model key in this environment; B9 runs them).
- `scripts/verify/branch-parity.ts`: 40 kinds of message and comment sent to BOTH Pages through
  the production webhook and worker path (model and Meta stubbed): every reply is that branch's
  own row, both branches behave the same, no reply carries the other branch's details. Passed with
  her channel in shadow plus a tester (B11) and live (B12). A planted leak (Яармаг's number in her
  phone reply) was caught.
- Яармаг's configuration rows were byte-identical before and after all of it.
