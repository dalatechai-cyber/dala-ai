-- 0029 — the disclosure corpus is the GATE, not the whole prefix (D-084).
--
-- `disclosesPrompt` refuses a reply that reproduces sixty contiguous characters of "the
-- prompt", and the prompt it was handed was the entire compiled prefix — platform gate
-- blocks AND the tenant's knowledge base. So a reply that quoted the tenant's own facts
-- back to a customer was a disclosure, which inverts what the knowledge base is for.
--
-- Measured on 2026-09-18 at 04:02: a customer asked Matrix how many branches it has, the
-- model answered «Матрикс эко салон нийт зургаан салбартай» straight from the knowledge
-- base, and the reply was discarded for the generic handoff. The offending run was sixty
-- characters of which two were punctuation — a 58-character knowledge-base sentence plus
-- the full stop and space in front of it, present in both the corpus and the reply by
-- coincidence of sentence boundaries. Every KB sentence of 58 characters or more carried
-- that trap.
--
-- NULLABLE, and null is a FORMAT MARKER rather than "unknown" — the same shape as
-- `canned_hash` in 0014. A snapshot published before this column existed has no separate
-- gate text, and the reader falls back to `prompt_stable`, which is exactly today's
-- behaviour: it over-refuses rather than under-refuses, and it self-heals on the next
-- republish. Reading null as "no corpus" would disable the check, which is the one
-- direction that must not happen by default.
--
-- Not backfilled. The gate text for a past snapshot cannot be reconstructed from the row:
-- `prompt_stable` is the concatenation, and the platform/tenant boundary is not recorded
-- in it. A backfill would have to guess, and a guessed corpus is worse than a null one
-- that says so.
alter table config_snapshots add column if not exists prompt_gate text;

comment on column config_snapshots.prompt_gate is
  'The PLATFORM sections of this snapshot, joined — the corpus disclosesPrompt matches '
  'against. NULL means the snapshot predates the column and the reader falls back to '
  'prompt_stable (over-refuses, never under-refuses). Never backfilled: the boundary is '
  'not recoverable from prompt_stable.';
