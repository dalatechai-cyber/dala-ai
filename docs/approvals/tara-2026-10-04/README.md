# Tara Salon — wording still waiting for the founder (2026-10-04)

Everything below is a **draft**: nothing here is loaded, applied, signed or live. These files are
**copies**, gathered in one place for review. Each one names its source file. If a copy and its
source ever differ, the source is the one that counts.

To approve, reply per file: approve as is, approve with changes, or drop. Lines you approved on
2026-10-04 are not repeated as questions. They appear only where a file shows them for context,
marked APPROVED.

| # | File | What it is for | What changed since your 2026-10-04 review | Source |
|---|---|---|---|---|
| 1 | `01-yarmag-quality-answers.mn.txt` | Дали's answers on prices and payment, Яармаг (and the same rows at Парк Од) | Your three approvals are now rows (items 1–3). Item 4: the approved photo line is now also the one question Дали asks after a photo; **your OK is needed for this new use**. **New, awaiting:** item 5, the price-page sentence for women's «Эмчилгээний хими» and «өнгө гаргалт»; item 6, the link label «Үнийн хуудас»; item 7, an optional line for reels (not wired). | dala-ai#283, `prompt/drafts/tara_quality_2026-10-03.mn.txt` |
| 2 | `02-yarmag-stylist-names.mn.txt` | Яармаг «Үсчдийн нэр», so Дали recognises Cyrillic names and always writes the Latin one | The model's roster is now purely Latin, and the level reads «1-р зэргийн үсчин». Otgonjargal is added. **Awaiting:** the line «Отгонжаргал, Отгоо гэвэл Otgonjargal.» («Отгоо» is a guess), and «Otgonjargal» in the first line. | dala-ai#284 |
| 3 | `03-park-od-wording.mn.txt` | Every Парк Од line that is not byte-identical to an approved Яармаг line | Sections 1, 2, 3b and 5 are APPROVED as you said. `assistant_identity` and `booking_line` are now Яармаг's bytes. **Awaiting:** section 4, «Салбарууд» rewritten symmetric (each branch names the other), plus a new fixed reply `yarmag_branch`. Section 4b: her «Үсчдийн нэр», where **every Cyrillic spelling is a guess**. Section 6: the same price-page sentence as file 1. | dala-ai#284 |
| 4 | `04-booking-ask-agreement.mn.txt` | In-chat booking: the summary shown before the customer agrees to pay the deposit | The approved sentence «Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдаж тооцогдоно.» is added. The non-refundable «Нөхцөл» line was removed in round 1. The block as a whole needs your OK. | dala-ai#285 |
| 5 | `05-booking-ask-variant.mn.txt` | In-chat booking: the second question for a line sold by length or level | Unchanged since round 1, never approved | dala-ai#285 |
| 6 | `06-booking-buttons.mn.txt` | In-chat booking: the group, service and children's buttons (20 characters max), plus **one decision**: whether «Гоёлын засалт /эрэгтэй/» is offered to men | Round 2 added no new labels. Typed Cyrillic names (never shown) now pick a hairdresser. | dala-ai#285, `config/booking/tara-salon.json` |
| 7 | `07-website-booking-notices.mn.txt` | Website booking, step 3: two rare notices (no hairdresser of that level; two levels picked together) | **New** after the review: the men's SPECIAL cut is hidden from online booking (no male SPECIAL), and these notices explain the rare cases | matrix_website#83, `assets/booking.js` |

Not here, because nothing in them waits for you: `intake/tara-park-od.wording.json`. It holds
Парк Од's `handoff`, `assistant_identity` and `booking_line`, all of them lines you already
approved, byte for byte. The other in-chat booking blocks in `prompt/drafts/booking/` are
approved and wait only to be signed. The website copy (`docs/COPY_DRAFT.md`) is approved apart
from file 7.

## Facts to confirm (not wording)

- Парк Од's Facebook Page id, and Яармаг's Page link, which was taken from the website's data.
- The new website's price page has no price for women's «Эмчилгээний хими» or for «өнгө
  гаргалт». Either add both prices, or accept that the price-page link shows the nearest
  services. The price-page rows stay off until you decide.
- The two deposit sentences differ on purpose, as you approved them: the website says «…үнээс
  хасагдана.» and Дали says «…үнээс хасагдаж тооцогдоно.».
