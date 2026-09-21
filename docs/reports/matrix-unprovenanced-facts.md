# Every Matrix fact in a table that cannot record where it came from

**Written 2026-09-21, after the address was found wrong.** That value was read off the
salon's own Facebook comment replies, recorded in `docs/STATUS-2026-09-20.md` as still
*Waiting on: the salon*, and written into `contact_points` anyway — where it became
indistinguishable from a confirmed fact and was then quoted back at the incumbent as
ground truth.

**Confirm or correct each line.** Where a row says *ancestor*, it means the value was
copied from `Matrix-Chatbot`'s own config, which the salon operates — better than a
scrape, and still a copy nobody re-checked with them.

## Why this document has to exist

D-020's provenance gate keeps an unconfirmed row out of a customer's reply. It covers
`faqs`, `out_of_scope_topics`, `deterministic_replies`, `disclosure_rules`,
`comment_rules` and `service_aliases` — each has a `provenance` column and the compiler
filters on it.

**These six tables have no such column**, so nothing can tell a guess from a fact:

`contact_points` · `business_hours` · `services` · `staff_members` · `tenant_booking` ·
`knowledge_documents`

And `scripts/provision/intake/matrix-eco-salon.json` — the file everything here was
provisioned from — carries a **`confirmedBy` field that is `null`**. The slot for "who
confirmed this" exists and was never filled, and nothing refuses an intake without it.

---

## contact_points

| fact | value | where it came from | status |
|---|---|---|---|
| `address` | Яармагийн Номин Хайпермаркетын баруун талд | **founder, 2026-09-21**, correcting a value scraped from the salon's comments | ✅ confirmed |
| `maps_url` | https://maps.app.goo.gl/ckEXBLoq4FnxJHq16 | **founder, 2026-09-21**. Neither bot had it — the ancestor's own link was also wrong | ✅ confirmed |
| `phone` | 76001888, 80905498 | **founder**, in the overnight brief's fact list | ✅ confirmed |
| `website` | https://www.matrixecosalon.org/products.html | **founder**, in the overnight brief ("product questions → …") | ✅ confirmed |

**Not stored, and deliberately:** «Гар утас: 9100 5498» appears in the salon's own
comments and is neither of the two numbers above. It never reached a row. **Is it real?**

## business_hours

| fact | value | where it came from | status |
|---|---|---|---|
| Mon–Sat | 10:00–20:00 | **ancestor** — its FAQ answer «Даваа-Бямба: 10:00-20:00, Ням: 11:00-19:00» | ❓ copied, never re-confirmed |
| Sunday | 11:00–19:00 | same | ❓ copied, never re-confirmed |

No day is marked closed. **Does the salon close on any public holiday?** Nothing here can
express one, so a holiday would be answered as an ordinary working day.

## staff_members — 9 rows, all from the ancestor's `team` block

| name | tier | group | customer-selectable |
|---|---|---|---|
| Оюунсүрэн | Мастер үсчин | Эмэгтэй үсчид | yes |
| Бадамцэцэг | Мастер үсчин | Эмэгтэй үсчид | yes |
| Батзаяа | 1-р зэрэг үсчин | Эмэгтэй үсчид | yes |
| Уянга | 1-р зэрэг үсчин | Эмэгтэй үсчид | yes |
| Отгонжаргал | 1-р зэрэг үсчин | Эмэгтэй үсчид | yes |
| Тэргэл | 1-р зэрэг үсчин | Эрэгтэй үсчид | no |
| Ананд | Мастер үсчин | Эрэгтэй үсчид | no |
| Мухлай | Мастер үсчин | Эрэгтэй үсчид | no |
| Г. Мөнхзаяа | Маникюр мэргэжилтэн | Маникюр баг | yes |

❓ **Is this roster current?** Staff change. Every row is `affects_price = false`, so a
tier never moves a price by itself — the price comes from the service variant.

## tenant_booking

| fact | value | where it came from | status |
|---|---|---|---|
| `booking_url` | https://www.matrixecosalon.org/ | **ancestor** FAQ, and the founder has quoted it since | ✅ effectively confirmed |
| `mode` | `link` | a design choice, not a salon fact | — |

## knowledge_documents — 7 rows

All seven carry `source = "Matrix Eco Salon, 2026-09-07, эзний хариулт"` — **the owner's
own answer, dated.** This is the best-attributed table in the list, and it is the one
place a free-text source was recorded.

Titles: «Салбарууд» · «CICA ба CMC — эмчилгээ, хими биш» · «Химийн үйлчилгээний төрлүүд» ·
«Химийн хориглох заалт» · «Будалтын хориглох заалт ба боломж» · «Сор, office өнгө, омбре» ·
«Урамшуулал ба баримт»

⚠️ One correction already applied on 2026-09-21: the CICA document said one session equals
~50 masks; the founder's fact list says **30–40 тэжээлийн тос**. Corrected.

❓ «Урамшуулал ба баримт» describes a promotion. **Promotions expire — is it still running?**

## services — 40 rows · service_variants — 42 confirmed prices

From the **confirmed price list** the founder supplied, via the intake file. These are the
only rows with a `confirmed_at` column, and all 42 are set.

**Four known disagreements, already recorded and still open:**

| | |
|---|---|
| «Сор» ⊂ «Оффис колор /Сор/» | 120–190k vs 380–460k, 3.2× apart. No alias can separate them — the longer name *contains* the shorter (D-075). **The repair is a rename by the salon.** |
| «Тэжээл» ⊂ «CMC тэжээл» | 44–88k vs 132,000 |
| «Афро хими» | ancestor says 430–510k, the sheet says 319–352k |
| «Усан хими» | ancestor says 132–154k |

## What I would change, if you want it

`contact_points`, `business_hours`, `services`, `staff_members` and `tenant_booking` could
each carry the same `provenance` column the other six tables already have, and
`scripts/provision/validate.ts` could refuse an intake whose `confirmedBy` is null. That is
a migration plus a guard, and it is not done — it changes the schema, so it waits for you.
