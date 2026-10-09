# Runbook 2026-10-09, steps 6–7: what you should see, line by line

Companion to `docs/runbooks/tara-2026-10-09.md`. Nothing in that runbook or in the SQL files was
changed. Step 8 (phone tests, Telegram alerts) cannot be reproduced without Meta and is not covered
here, except that the replies it expects carry the new address (see «After both publishes»).
Command output below is abridged: the node warning, the `order` line, blank lines and the 31
«LIVE» launch lines are left out. Everything below was produced on 2026-10-09 (04:20–04:40 UTC) on a local copy of
Production, by the overnight session, without the model and without writing to Production.

## How it was proven

- **The copy.** PostgreSQL 16 + PostgREST 12.2.3 on the session's machine, all 84 migrations
  (the same 84 Production has, last `20261004034606`). Both Tara tenants' rows in 28 tables
  were read from Production with SELECTs and loaded; every table was then compared with
  Production by row count and md5 over every row (`md5(x::text)`, UTC): **27 tenant tables
  (plus `tenants`) equal**. The 149 platform prompt blocks are equal in content (block key,
  vertical, body md5, signature and layer; only their generated ids differ).
- **Control first** (a copy that reproduces the known live value before trusting a new one):
  on the copy, before any change, the dry runs give the values of Production's live snapshots
  (both hashes of both branches read from `config_snapshots` on Production, 2026-10-09) —
  Яармаг `content_hash 651594a8…4fbd`, `canned_hash f89a2880…8f03`, 66/66;
  Парк Од `content_hash d867eed1…b60a`, `canned_hash 922f3b1a…b6e6`, 67/67. A local publish
  of that state gives snapshots equal to Production's live ones in every field the dry run
  reads (prompt, allowed numbers, launch states, gate), so the "before → after" lines below
  are the ones your Mac will print.
- **Read-only checks on Production itself (2026-10-09 ~04:30 UTC).** Every guard in
  `tara-both-tarasalon-2026-10-09.sql` holds today: booking links 2, website contact rows 2,
  booking lines with the exact read text 2, fixed replies 4 (booking + deposit_required, both
  branches), FAQs 4, Яармаг's sales line 1, reply cases 13 (ids 185–190, 232, 252–257),
  rows already naming tarasalon.org 0. The rows its read-back also checks but does not change
  (`web_body`, FAQ questions, knowledge documents, sales `web_body`) hold the old address 0
  times, and no row holds the address in any other spelling (the brand words «matrix eco» remain
  in some rows; they are not an address). A scan of every text column of every
  configuration table (both tenants and platform rows) finds the old address only in the rows
  this file changes.

## Mismatches found

**None that stops steps 6–8.** Two small things, for your information only:

1. The revert gives back every text byte for byte, but not two signatures: the booking line's
   and Яармаг's sales line's `reviewed_at` become the time of the revert (the file's header
   says so), and **Парк Од's booking line `reviewed_by` stays `founder`** (today it is
   `Bilguun`; the forward file sets `founder` on both branches and the revert keeps it). No
   hash, reply or gate reads `reviewed_by`; both hashes return exactly (below).
2. Your Mac's dry run also prints the 31 «LIVE» launch lines under `launch unchanged`; they
   are the same 31 services as today. The «Read-only checks on Production» above were queries
   run by the session, not saved as files; the copy gives the same counts.

## Step 6.1 — the SQL editor

`scripts/provision/tara-both-tarasalon-2026-10-09.sql` → expected: **Success. No rows returned.**
(the SQL editor itself was not run here; psql was)
Over psql the same file prints, in order: `BEGIN`, `SET`, `DO`, `UPDATE 2` (booking links),
`UPDATE 2` (website contacts), `UPDATE 2` (booking lines), `UPDATE 4` (fixed replies),
`UPDATE 4` (FAQs), `UPDATE 1` (Яармаг's sales line), `UPDATE 13` (reply cases), `DO`, `COMMIT`.
Run a second time it refuses: `tenant_booking: expected 2 rows on the old address, found 0
(already applied?)`.

## Step 6.2 — Яармаг dry run

`node scripts/publish/tenant.ts --slug matrix-eco-salon`

```
platform blocks: 149 live, matching the signed set.
launch          unchanged
tenant          matrix-eco-salon (8f2826f5-bd33-4d6c-ab70-b6c5ba7f3f06)
channels        facebook_page
sections        25
prompt chars    23658 → 23633
content_hash    651594a89b6b560cf62608d5e7e4f6254fc457969008fa29cf0ba539a5264fbd → ecaf14d119b2cfe60a28a7b1d2381baf252d280a5223807c7d68d2bfce71e3b1
canned_hash     f89a288003adcba63605b0ca94d4b4a7b37a82639607a14ae6292ea2d52a8f03 → 5d8990d86877f5d20ede4e709ce2bb7e91ccf092f23ad2e43a73d55d73230ce7
data marker     true
allowed_numbers 50 token(s) (unchanged)
changed on facebook_page
branches: matrix-eco-salon (tara-salon): no other branch's details, and the shared facts agree.
branch group tara-salon: if this change touches prices or the booking link, publish tara-park-od in this same session.
matrix-eco-salon: 66/66 reply cases pass · 16 need the model and were not run (no spend; run by hand before a big change)
facts: matrix-eco-salon: every copy agrees with the rows.
Dry run. Nothing was written. Re-run with --publish to apply.
```

## Step 6.3 — Яармаг paid check (not run here: no model)

Expect `82/82 reply cases pass` (66 above + 16 model cases) and `MODEL RUN COST`. Unverified.

## Step 6.4 — Яармаг publish

`PUBLISHED  seq 22  revision <new id>  content_hash ecaf14d119b2cfe60a28a7b1d2381baf252d280a5223807c7d68d2bfce71e3b1`
then `Read back through loadLiveSnapshot on facebook_page: the reply path sees it.`
(The revision id is new each time; seq 22 and the hash are fixed.)

## Step 7 — Парк Од

Dry run:

```
prompt chars    23382 → 23357
content_hash    d867eed12db06ee8c3607a3dbddabff22daccf041c3d754ae83981e8b3e4b60a → 49fd77f4cdb22ed9d29874c26d3226ba0b05de2eb1cf5f624e4252a4314f2ceb
canned_hash     922f3b1ab4c35a89da9abb684f20838c5ede8a991b771fb608526101e577b6e6 → 73828128ce20950ebb98efb264224e15da162e1c0926e5c2f11b9d4c8f9e2dfc
allowed_numbers 48 token(s) (unchanged)
branches: tara-park-od (tara-salon): no other branch's details, and the shared facts agree.
tara-park-od: 67/67 reply cases pass · 52 need the model and were not run (no spend; run by hand before a big change)
facts: tara-park-od: every copy agrees with the rows.
```

Paid check: `119/119` (67 + 52), unverified here. Publish: `PUBLISHED  seq 2  revision <new id>
content_hash 49fd77f4cdb22ed9d29874c26d3226ba0b05de2eb1cf5f624e4252a4314f2ceb` and the read-back
line.

## After both publishes (proven on the copy)

Evidence lines saved by the session: `evidence-scan-after-sql.txt` (in the session's replica folder,
not in the repository).

- Neither published prompt contains `matrixecosalon`; both contain `https://www.tarasalon.org/`.
- No row contains `matrixecosalon` after the SQL (scan of every text, array and json column of
  every table on a fresh Production-equal copy) except the two live snapshots of today, which the
  publishes replace.
- `scripts/verify/branch-parity.ts --shadow-testers` (44 kinds of message and comment through the
  production webhook and worker path, model stubbed): **44 scenarios × 2 tenants: ALL PASS**;
  98 replies sent (full bodies read from `outbound_messages`), 0 contain `matrixecosalon`.

## The revert (proven on a fresh copy)

`scripts/provision/tara-both-tarasalon-2026-10-09-revert.sql` after the forward file prints the same
`UPDATE` counts (2, 2, 2, 4, 4, 1, 13) and `COMMIT`; a second run refuses
(`… is not applied (found 0 booking links on tarasalon.org)`). Every table of the database is
then identical to before, row for row, except `canned_responses` (the two booking lines'
`reviewed_at`, and Парк Од's `reviewed_by`, see «Mismatches») and `sales_next_steps` (its
`reviewed_at`). The dry runs after the revert print `content_hash … → 651594a8…4fbd` and
`canned_hash … → f89a2880…8f03` (Яармаг), `→ d867eed1…b60a` and `→ 922f3b1a…b6e6` (Парк Од):
exactly today's live values. Checked also without a publish (forward, then revert, on a fresh
Production-equal copy whose live snapshots are today's): both dry runs print today's hashes with no
arrow and «The compiled prefix is byte-identical to the live one on every channel (facebook_page).
Nothing to publish.», so after a revert both branches are current again on their published
revisions (no `canned_stale`).
