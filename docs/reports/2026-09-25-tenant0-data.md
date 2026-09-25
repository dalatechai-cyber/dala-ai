# Tenant #0 (Dalatech): its data, for the founder's read before any republish

Read from the live project on 2026-09-25 (read only; nothing here has been written).
Tenant `919e21d4-224d-44b3-bb62-273caa6237ce`, slug `dalatech`, vertical `software`,
status `provisioning`. The `web` channel `22e3c169-2350-45de-9806-d5c96587ce9f` is
`live`, but no visitor can reach it yet, because no mint secret is sealed (§5).

## 1. The live prompt knows none of this data yet

The published snapshot is **seq 3**, compiled 2026-09-19 05:24 (`content_hash 7e070e33…`,
10,770 chars, `allowed_numbers []`). It holds the gate blocks and the canned lines only.
The knowledge documents and FAQs below were written at 05:35, eleven minutes later, and
**have never been published**. A republish therefore changes tenant #0's **Facebook Page**
answers as well as the website's: both channels read the same revision.

The one price answer tenant #0 gives today is the deterministic row in §3. It is read per
request and does not need a republish.

## 2. Rows as they stand

**contact_points**: `email dalatech.ai@gmail.com` (escalation), `website https://dalatech.online/`.
No phone, no address.

**knowledge_documents** (7, source `dalatech-chatbot buildConversationSystemInstruction`):
Дали (active), Вира (active, sold only alongside another member), Эхо / Нова / Ора
(«УДАХГҮЙ», pre-registration), «Таван AI ажилтан — нийтлэг», «Бүтээгдэхүүн: вэбсайт».
None carries a price figure. Эхо's says «Минутын үнийг хараахан зарлаагүй».

**faqs** (8, all `tenant_confirmed`):

| # | Q | A |
|---|---|---|
| 1 | Ямар бизнест тохиромжтой вэ? | …дэлгүүр, салон, эмнэлэг, ресторан, авто үйлчилгээ, сургалт. |
| 2 | Техникийн мэдлэг хэрэгтэй юу? | Хэрэггүй. Тохиргоо, нэвтрүүлэлтийг бид хийнэ. |
| 3 | Хүний ажилтныг орлох уу? | Орлохгүй. …шийдвэр шаардсан асуудлыг танай багт шилжүүлнэ. |
| 4 | …хэр хугацаанд ажиллаж эхэлдэг вэ? | AI ажилтан 3–5 хоногт ажиллаж эхэлнэ. |
| 5 | Сарын төлбөрт юу багтдаг вэ? | сервер, загварын ашиглалт, хяналт, мэдээллийн шинэчлэлт, дэмжлэг |
| 6 | Багийн хөнгөлөлт байдаг уу? | Хоёр −10%, гурав −15%, дөрөв+ −20%. Сарын төлбөрт хамаарна. |
| 7 | Төлбөрийн нөхцөл ямар вэ? | Вэбсайт 50/50. AI ажилтан: суурилуулалт нэг удаа, сар бүрийн эхэнд. |
| 8 | Тусгай үнийн санал гаргадаг уу? | …бизнесийн чиглэл, автоматжуулах ажлын хүрээнд үндэслэн гаргана. |

**canned_responses**: nine founder-reviewed lines from 2026-09-06, plus
`comment_public_reply` («Сайн байна уу! Мессеж бичээрэй, манай AI туслах шууд хариулна.»),
added 2026-09-19 with **`reviewed_by` null**. Its `reviewed_at` is set, but no reviewer is
named.

**deterministic_replies**: `price_overview` (whole-message match, served before the model):
> Сарын төлбөр: Дали 250,000₮, Вира 150,000₮, Эхо 250,000₮, Нова 150,000₮, Ора 250,000₮.
> Нэг удаагийн суурилуулалт: Дали 150,000₮, Вира 150,000₮, Эхо 200,000₮, Нова 150,000₮,
> Ора 150,000₮. Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно.

It leaves out the website (750,000₮) and the bundle (800,000₮). So «үнэ хэд вэ» gets the
staff prices and never mentions the website.

**services / service_variants**: none. **tenant_domains**: `dalatech.online`,
`www.dalatech.online`, both verified 2026-09-19.

**tenant_budgets**: daily **$0.50**, monthly $5.00 (nothing reads monthly, D-072),
fractions `reception 0.95 / analytics 0.02 / care 0`. Today's Reception ceiling is therefore
$0.475 a day, and it covers the Facebook Page and the website together.

## 3. Proposed price rows (your decision: "quoted per product, as data rows as for Tara")

The figures below are identical in three places: dalatech.online's price page
(`src/office/agents.js`, `mn.json`), the site chatbot's guard data
(`lib/facts.js PRICE_ROWS`), and the `price_overview` row. Every one is `exact` and
`confirmed_at` = when you approve. The variant labels are customer-visible, so the wording
is yours to change.

| service (`name`) | `variant_key` | price |
|---|---|---|
| Дали — Хүлээн авагч | Сарын төлбөр | 250,000 |
| Дали — Хүлээн авагч | Нэг удаагийн суурилуулалт | 150,000 |
| Вира — Бизнес аналитик | Сарын төлбөр | 150,000 |
| Вира — Бизнес аналитик | Нэг удаагийн суурилуулалт | 150,000 |
| Эхо — Утасны оператор | Сарын төлбөр | 250,000 |
| Эхо — Утасны оператор | Нэг удаагийн суурилуулалт | 200,000 |
| Нова — Харилцагчийн менежер | Сарын төлбөр | 150,000 |
| Нова — Харилцагчийн менежер | Нэг удаагийн суурилуулалт | 150,000 |
| Ора — Хувийн туслах | Сарын төлбөр | 250,000 |
| Ора — Хувийн туслах | Нэг удаагийн суурилуулалт | 150,000 |
| Ухаалаг вэбсайт | (none) | 750,000 |
| Вэбсайт + Дали багц | (none) | 800,000 |

They render as `- Дали — Хүлээн авагч (Сарын төлбөр): 250,000₮`.

Aliases (`service_aliases`, the old names the site chatbot already accepts): `ара`/`ara` →
Дали, `веда`/`veda` → Вира, `dali`, `vira`, `echo`/`eho`, `nova`, `ora`, `вэбсайт`/`website`/`сайт`
→ Ухаалаг вэбсайт, `багц`/`bundle` → the bundle.

Three things for you to decide:
- **Эхо's per-minute charge.** The site says «+ дуудлагын минут тутамд нэмэлт төлбөр» and
  the knowledge base says the rate is not announced. I propose no row for it; the knowledge
  document already says it.
- **The bundle's "900,000₮ separately" comparison.** This is arithmetic, not a price, so I
  propose no row. The model may still say it, because both 750,000 and 150,000 will be rows.
- **`price_overview`.** Add the website and bundle line, or leave it as the staff list only.

## 4. Other proposed rows

- `contact_points`: `address` = «Улаанбаатар, Монгол». This is what the site says; there is
  no street address. D-071's label binding shows it as «Хаяг».
- `tenant_domains`: `dalatech-chatbot.vercel.app`. The widget is an iframe served from that
  host, so the browser's calls to `/api/web/*` come from that origin, not from
  dalatech.online.
- `tenant_budgets`, your **$2 a day**, as a new row (the latest `effective_from` wins):
  - `daily_ceiling_nanousd = 2000000000` gives Reception 0.95 × $2.00 = **$1.90 a day**.
  - For Reception to reach the full **$2.00**, the daily ceiling must be at least $2.1053.
    Use `2110000000`; the platform's compiled cap `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY
    = 2.0` clips it to $2.00 exactly.
  - Either way the cap is shared by the Facebook Page and the website. A visitor flood can
    therefore silence the Page for the rest of that day.

## 5. What you create, and where

**Nothing below has been created.** The values are secrets, so do not paste them into chat.

**A. Turnstile for app.dalatech.online** (the demo form; this switches its bot check on)
1. Cloudflare dashboard → Turnstile → Add widget. Name `dalatech-app form`, hostname
   `app.dalatech.online`, mode **Managed**.
2. Vercel → project `dalatech-app` → Settings → Environment Variables → **Production**:
   `TURNSTILE_SITE_KEY` = the site key, `TURNSTILE_SECRET_KEY` = the secret key. Set both.
   With only the secret set, the check stays off by design; that stops a missing site key
   from blocking every lead.
3. Redeploy production. Environment changes apply on the next deploy.

**B. Turnstile for the chatbot** (used by Dala AI's web mint)
1. Add a second widget: name `dala web chat`, hostnames `dalatech-chatbot.vercel.app` and
   `dalatech.online`, mode **Managed**.
2. Vercel → project `dala-ai` → Production: `TURNSTILE_SECRET_KEY` = its secret. Only
   `/api/web/session` reads it, and the Facebook path does not, so nothing live changes.
3. Keep the site key for the relay in dalatech-chatbot. The relay is not built yet, per your
   hold.

**C. The mint secret** (proves a request came from our chatbot server)
1. On your machine: `openssl rand -base64 32`. That value is the secret.
2. In a dala-ai checkout, run `npm install`. Export `TENANT_KEK_ACTIVE_VERSION` and
   `TENANT_KEK_V1` from your own copy; Vercel cannot show them back (D-107). Then:
   `printf %s "$MINT" | node scripts/kek/seal.ts --tenant 919e21d4-224d-44b3-bb62-273caa6237ce --channel 22e3c169-2350-45de-9806-d5c96587ce9f --kind web_mint_secret`
3. The script **prints SQL and writes nothing**. Run the SQL in the Supabase SQL editor,
   then check that the row exists:
   `select kind, kek_version, status, created_at from tenant_secrets where channel_id = '22e3c169-2350-45de-9806-d5c96587ce9f';`
4. Store the same value in Vercel → `dalatech-chatbot` → Production as
   `DALA_WEB_MINT_SECRET`. Nothing reads it until the relay is built.

My earlier plan said "I seal the secret". That was wrong: sealing needs the KEK, which this
environment does not have. You run step 2.

## 6. Applied 2026-09-25, on the founder's approval

Written in one transaction (`scripts/provision/tenant0-approved-2026-09-25.sql`) and read back:

- The 12 price rows of §3, exact and confirmed, with their 15 aliases. There is no row for
  Эхо's per-minute charge and none for the 900,000₮ comparison.
- `price_overview` gains one line, live on write: «Вэбсайт: Ухаалаг вэбсайт 750,000₮, Вэбсайт + Дали багц 800,000₮.»
- `address` «Улаанбаатар, Монгол»; `tenant_domains` `dalatech-chatbot.vercel.app` (verified).
- `tenant_budgets`: daily `2110000000`, so Reception gets $2.00 a day. Monthly carries over
  at $5; nothing reads it.
- `comment_public_reply`: `reviewed_by = founder`.
- Unchanged: FAQ 4 («3–5 хоногт») and FAQ 6 (the discounts). Their choice was left blank.
- `reply_cases` #9: «үнэ хэд вэ» → the new `price_overview` body.

Everything except `price_overview` reaches a customer only when tenant #0 is republished.
