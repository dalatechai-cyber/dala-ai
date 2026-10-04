All files approved by the founder on 2026-10-04 (file 8, D-177, with two changes the same day).

> **2026-10-04, phones (D-178, founder, final):** the copies below are kept as the founder read them. Since then Парк Од's number is 99076874 everywhere in her lines (not 76001888), and both «Салбарууд» and the other-branch replies give each branch's own numbers (Яармаг 76001888, 91005498; Парк Од 99076874). The source files carry the corrected lines.

# Tara Salon — wording for the founder (2026-10-04)

The founder approved files 1–7 **as written** on 2026-10-04; file 8 was added after and approved the same day. Approved is not live:
nothing here is loaded, applied, signed or published. These files are **copies**, kept exactly
as the founder read them, so they still say «awaiting» where they did then; the sources now mark
the same lines APPROVED. Each copy names its source file. If a copy and its source ever differ,
the source is the one that counts.

## Still open

- **Dropped 2026-10-04 (founder, D-177):** the price-page replies (file 1 items 5–6, file 3
  section 6) and the «Үнийн хуудас» contact. Neither price is a Tara service. The copies below
  still show them, as you read them.
- **File 8:** the replies that take their place (both tenants), APPROVED 2026-10-04.
- Signing the approved drafts is the founder's own step (`scripts/prompt/sign-drafts.ts` for the
  in-chat booking blocks; each tenant's wording sheet for its lines).

## The files

| # | File | What it is for | Status / what was asked in the 2026-10-04 review | Source |
|---|---|---|---|---|
| 1 | `01-yarmag-quality-answers.mn.txt` | Дали's answers on prices and payment, Яармаг (and the same rows at Парк Од) | **APPROVED 2026-10-04, as written** (the price-page rows stay off; see Still open). Asked: your three approvals are now rows (items 1–3). Item 4: the approved photo line is now also the one question Дали asks after a photo; **your OK is needed for this new use**. **New, awaiting:** item 5, the price-page sentence for women's «Эмчилгээний хими» and «өнгө гаргалт»; item 6, the link label «Үнийн хуудас»; item 7, an optional line for reels (not wired). | dala-ai#283, `prompt/drafts/tara_quality_2026-10-03.mn.txt` |
| 2 | `02-yarmag-stylist-names.mn.txt` | Яармаг «Үсчдийн нэр», so Дали recognises Cyrillic names and always writes the Latin one | **APPROVED 2026-10-04, as written**, «Отгоо» included. Asked: the model's roster is now purely Latin, and the level reads «1-р зэргийн үсчин». Otgonjargal is added. **Awaiting:** the line «Отгонжаргал, Отгоо гэвэл Otgonjargal.» («Отгоо» is a guess), and «Otgonjargal» in the first line. | dala-ai#284 |
| 3 | `03-park-od-wording.mn.txt` | Every Парк Од line that is not byte-identical to an approved Яармаг line | **APPROVED 2026-10-04, as written**: sections 4 and 4b (every Cyrillic spelling), 6 and `yarmag_branch`; Яармаг's Page link in it is correct. Asked: sections 1, 2, 3b and 5 are APPROVED as you said. `assistant_identity` and `booking_line` are now Яармаг's bytes. **Awaiting:** section 4, «Салбарууд» rewritten symmetric (each branch names the other), plus a new fixed reply `yarmag_branch`. Section 4b: her «Үсчдийн нэр», where **every Cyrillic spelling is a guess**. Section 6: the same price-page sentence as file 1. | dala-ai#284 |
| 4 | `04-booking-ask-agreement.mn.txt` | In-chat booking: the summary shown before the customer agrees to pay the deposit | **APPROVED 2026-10-04, as written.** Asked: the approved sentence «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.» is added. The non-refundable «Нөхцөл» line was removed in round 1. The block as a whole needs your OK. | dala-ai#285 |
| 5 | `05-booking-ask-variant.mn.txt` | In-chat booking: the second question for a line sold by length or level | **APPROVED 2026-10-04, as written.** Asked: unchanged since round 1, never approved | dala-ai#285 |
| 6 | `06-booking-buttons.mn.txt` | In-chat booking: the group, service and children's buttons (20 characters max). «Гоёлын засалт /эрэгтэй/» is offered to men, as you decided on 2026-10-04 | **APPROVED 2026-10-04, as written**, the children's buttons included. Asked: round 2 added no new labels. Typed Cyrillic names (never shown) now pick a hairdresser. | dala-ai#285, `config/booking/tara-salon.json` |
| 7 | `07-website-booking-notices.mn.txt` | Website booking, step 3: two rare notices (no hairdresser of that level; two levels picked together) | **APPROVED 2026-10-04, as written** (the website side is handled separately). Asked: **new** after the review. Hiding the men's SPECIAL cut from online booking was approved on 2026-10-04; only the wording of these two notices waits | matrix_website#83, `assets/booking.js` |
| 8 | `08-colour-and-treatment-perm.mn.txt` | Both tenants: women's «Эмчилгээний хими» (not offered) and «өнгө гаргалт» (colour rows by gender) | **APPROVED 2026-10-04** (part 2 with a header line and Яармаг's 91005498). Rows written, on. | dala-ai#283 and #284 |

Not here, because nothing in them waited for you: `intake/tara-park-od.wording.json`. It holds
Парк Од's `handoff`, `assistant_identity` and `booking_line`, all of them lines you already
approved, byte for byte. The other in-chat booking blocks in `prompt/drafts/booking/` were
already approved. The website copy (`docs/COPY_DRAFT.md`) is approved, file 7 included.

## Facts settled on 2026-10-04 (not wording)

- Яармаг's Page link in `yarmag_branch` (taken from the website's data) is correct.
- The two deposit sentences differ on purpose, as you approved them: the website says «…үнээс
  хасагдана.» and Дали says «…үнээс хасагдаж тооцогдоно.».
