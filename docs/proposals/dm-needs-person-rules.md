# DM-only "needs a person" words (approved 2026-09-30; live via scripts/provision/dm-needs-person-rules-2026-09-30.sql)

The founder asked for a list of words that trigger the DM alert (`conversation.needs_person`)
and leave comment handling unchanged. Nothing here is applied. Matchers use the existing
`comment_rules` matcher shapes (`stem_sequence` within `windowCp` code points, `has_word`,
`contains_stem`), NFC and case-folded as today; Latin spellings sit beside Cyrillic (D-067).

## How it would stay DM-only

Recommended: a nullable `surfaces` column on `comment_rules`. Every existing row stays NULL,
which means "both", so nothing changes today. New rows carry `{direct_message}`. The comment
worker skips rows whose surfaces exclude `public_comment`, and the DM alert reads every
`escalate` row whose surfaces include `direct_message`. It is additive (one migration, no
backfill), and the tenant-rows rule holds: the words are rows, not code.

Also proposed: rows that are right on the wall but wrong in a DM get `{public_comment}`, so
the DM alert stops reading them. Candidates below; the founder decides.

## 1. Asks for a person (live, both tenants; nine rows, revised in review)

Every stem is in the «-тай» (with) form, because the bare words are DalaTech's own product
vocabulary («Утасны оператор», «Нова — Харилцагчийн менежер», «админ самбар», «AI ажилтан …
ярьдаг») and would have turned a sales question into a complaint.

| Key | Matcher | Catches |
|---|---|---|
| `person_staff_mn` | stem_sequence [«ажилтантай», «яр»] within 20 | «ажилтантай ярих», «ажилтантай ярьмаар» |
| `person_staff_connect_mn` | stem_sequence [«ажилтантай», «холбо»] within 20 | «ажилтантай холбогдох» |
| `person_human_talk_mn` | stem_sequence [«хүнтэй», «яр»] within 20 | «хүнтэй ярих», «хүнтэй ярилцмаар» |
| `person_manager_mn` | contains_stem [«менежертэй», «оператортой», «админтай»] | «менежертэй холбогдох» |
| `person_staff_lat`, `person_staff_connect_lat` | [«ajiltantai», «yar»], [«ajiltantai», «holbo»] | Latin forms |
| `person_human_talk_lat`, `_lat2` | [«huntei», «yar»], [«hvntei», «yar»] | Latin forms |
| `person_manager_lat` | contains_stem [«menejertei», «operatortoi», «admintai»] | Latin forms |

Dropped from the first proposal: «жинхэнэ хүн» (fires on «жинхэнэ хүний үс», real human hair)
and «хүн байна уу» (fires on «Одоо хүн байна уу», *is it busy now?*, a booking question).
Kept as they are (both surfaces): `complaint_human_mn` / `_lat` («хүнтэй холбог»),
`complaint_words` («ai bish», «бот биш»).

A DM row counts as a complaint everywhere a DM reads one: the needs-person alert, the apology
reminder in place of answer-first, no emoji, no sales line.

## 2. Comment-only candidates (founder's call, a language question)

`муудсан` / `muudsan` in `complaint` fires on «үс муудсан», which in a salon DM is often a
treatment request. The same may hold for `хүлээлгэ` («хүлээлгэх үү?») and `дундуур`. Proposed:
split them out of the `complaint` row into a `{public_comment}` row, so a DM with them no longer
pages you, while the wall is unchanged.

## Measured before proposing

Over the last 30 days of live inbound DMs (read-only): 2 of 303 Tara messages and 0 of 57
DalaTech messages matched today's complaint and person words; 1 Tara and 2 DalaTech messages
used «ажилтан», «оператор», «менежер» or «хүн … ярих/холбо». So the new rows add a handful of
alerts a month, not a stream. These counts come from a simple SQL pattern, not the matcher, so
they are an estimate.
