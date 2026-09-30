# DM-only "needs a person" words: proposal, not live (2026-09-30)

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

## 1. Asks for a person (new, both tenants)

| Key | Matcher | Catches |
|---|---|---|
| `person_staff_mn` | stem_sequence [«ажилтан», «ярь»] within 20 | «ажилтантай ярих», «ажилтантай ярьмаар» |
| `person_staff_connect_mn` | stem_sequence [«ажилтан», «холбо»] within 20 | «ажилтантай холбогдох», «ажилтантай холбоно уу» |
| `person_human_talk_mn` | stem_sequence [«хүнтэй», «ярь»] within 20 | «хүнтэй ярих», «жинхэнэ хүнтэй ярьмаар» |
| `person_real_mn` | stem_sequence [«жинхэнэ», «хүн»] within 15 | «жинхэнэ хүн байна уу» |
| `person_is_there_mn` | stem_sequence [«хүн», «байна уу»] within 10 | «хүн байна уу» |
| `person_manager_mn` | contains_stem [«менежер», «оператор», «админ»] | «менежертэй холбогдох», «оператор» |
| `person_staff_lat` | stem_sequence [«ajiltan», «yari»] / [«ajiltan», «holbo»] | Latin forms of the two above |
| `person_human_lat` | stem_sequence [«huntei», «yari»], [«hvntei», «yari»], [«jinhene», «hun»] | Latin forms |
| `person_manager_lat` | contains_stem [«menejer», «operator», «admin»] | Latin forms |

Kept as they are (already both surfaces): `complaint_human_mn` / `_lat` («хүнтэй холбог»),
`complaint_words` («ai bish», «бот биш»).

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
