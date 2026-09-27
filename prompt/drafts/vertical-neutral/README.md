# Gate blocks for any business type — UNSIGNED DRAFTS, loaded by nothing

**For the founder to read and sign (2026-09-27).** Nothing here ships until it is moved into
`prompt/platform/` and signed in `prompt/platform-mn-review.json`; the guard scans
`prompt/platform/` only.

## Why

Eight signed platform blocks carry salon examples. A client in any other vertical gets a
gate that talks about hair dye, fringes and manicures (D-033: the first reply this platform
ever sent invented a beauty salon for a software tenant). CLAUDE.md and D-078 count four
such blocks; reading the files today finds eight — the four (Ш3, Ш5, Ш6, Ш8) plus Ш1, Ш2,
Ш11 and `02_style`, whose salon wording is in their worked examples.

## The design: the live tenants do not change by one byte

For each of the eight blocks there are three files here:

| File | What it is | Who reads it after promotion |
|---|---|---|
| `<block>.salon.mn.txt` | **Byte-identical copy** of today's signed block | Tenants with `vertical = 'salon'` (Tara) |
| `<block>.software.mn.txt` | **Byte-identical copy** of today's signed block | Tenants with `vertical = 'software'` (DalaTech) |
| `<block>.mn.txt` | **The neutral draft** — the only new Mongolian | Every other vertical, including new ones |

`prompt/sections.ts` picks the most specific row per block (`0018`), so salon and software
tenants keep exactly today's text, and a new vertical gets the neutral one.

**Measured on the local replica**, by installing these files as rows and compiling the same
tenant as each vertical before and after (whole rendered prefix, `content_hash` included):

    salon         before 67c95fda50c82655  after 67c95fda50c82655  IDENTICAL
    software      before 67c95fda50c82655  after 67c95fda50c82655  IDENTICAL
    auto_service  before 67c95fda50c82655  after 675329ab6ebfb7b0  CHANGED, no salon words left

So promotion needs **no republish** of the live tenants: their prefix does not move. The
frozen copies' sha256 equals the signed block's, which the sign-off entry can state.

## What changed in each neutral draft — the only lines to read

Placeholders «А», «Б» follow the convention Ш11 already uses («А үйлчилгээ байгаа юу?»).

| Block | Today (salon) | Neutral draft |
|---|---|---|
| Ш1 `sh1_refusal_topics` | «Хүүхдийн чёлк тайралт хэд вэ?» / «Чёлк тайралт 33,000₮ байна.» | «Хүүхдэд А хэд вэ?» / «А 30,000₮ байна.», with the setting stated: «ХОРИОТОЙ СЭДВҮҮД»-д «хүүхдийн үнэ» бичигдсэн, жагсаалтад «А: 30,000₮» |
| Ш1 | «(эмэгтэй/эрэгтэй, үсчний зэрэглэл)» | «(жагсаалтад бичсэн төрөл, зэрэглэл)» |
| Ш2 `sh2_price` | «Хөмсөг засах хэд вэ?» / «Хөмсөг засалт ойролцоогоор 20,000₮ орчим байх аа.» | «Б хэд вэ?» (Б нь жагсаалтад байхгүй) / «Б ойролцоогоор 20,000₮ орчим байх аа.» |
| Ш3 `sh3_booking` | «…салонд шууд хохирол учруулна.» | «…байгууллагад шууд хохирол учруулна.» (D-071's word) |
| Ш5 `sh5_health` | «Жирэмсэн үедээ үс будуулж болох уу?» / «…манай будаг байгальд ээлтэй бүтээгдэхүүн учраас…» | «Жирэмсэн үедээ энэ үйлчилгээг авч болох уу?» / «…манай бүтээгдэхүүн байгальд ээлтэй учраас…» — the measured failure (reassurance, «байгальд ээлтэй» ≠ «аюулгүй») is kept |
| Ш6 `sh6_concessions` | «…амлах нь салоны мөнгө.» | «…амлах нь байгууллагын мөнгө.» |
| Ш8 `sh8_not_in_kb` | «ийм салонуудад», «ийм салонууд ихэвчлэн бэлгийн карт зардаг…» | «ийм байгууллагуудад», «ийм байгууллагууд ихэвчлэн бэлгийн карт зардаг…» |
| Ш11 `sh11_completeness` | «Өмнөх мессежүүд будалтын тухай байсан бол тайралтын үнэ рүү бүү шилж.» | «Өмнөх мессежүүд А-гийн тухай байсан бол Б-гийн үнэ рүү бүү шилж.» |
| Ш11 | «Үс маань хуурай, хугараад байна, юу хийх вэ?» / «Мастер үсчинтэй зөвлөгөө авахыг зөвлөж байна.» / «…тохирох эмчилгээнүүд…» | «Надад ийм асуудал байна, юу хийх вэ?» (асуудлаа тайлбарласан) / «Манай мэргэжилтэнтэй зөвлөгөө авахыг зөвлөж байна.» / «…тохирох үйлчилгээнүүд…» |
| `02_style` | «Үнэ нь уртаас хамаарна: …» / «Маникюр хэд вэ?» (жагсаалтад таван төрөл байна) | «Үнэ нь төрлөөс хамаарна: …» / «А хэд вэ?» (жагсаалтад А-гийн таван төрөл байна) |

Left as it is, for you to decide: Ш5's topic list names «арьс, хуйхны өвчин» (skin and
scalp conditions). Scalp is salon-flavoured, but it is a real health topic for any
business that touches the body; it is not an example, so the draft keeps it.

The language is yours to judge; the grammar of «А-гийн», «Б-гийн» in particular.

## Promotion, when signed (in this order)

1. Move the 24 files into `prompt/platform/` (the file name carries the vertical:
   `sh3_booking.salon.mn.txt` → block `sh3_booking`, vertical `salon`).
2. Add a sign-off entry per file to `prompt/platform-mn-review.json` (the 16 frozen copies
   have the same sha256 as today's signed blocks).
3. `node scripts/prompt/generate-seed.ts` → the next `prompt_blocks` seed migration.
4. Apply the migration to the project, **then** merge (D-058). No republish is needed for
   DalaTech or Tara (measured above); the next onboarded tenant compiles with the neutral text.

`scripts/verify/catalog.sql` V29 was widened on 2026-09-27 so a block that has BOTH a generic
row and per-vertical rows counts as covered for every vertical (the generic is the
fallback). Without that change V29 would go red for the first client outside salon and
software even though nothing is missing.
