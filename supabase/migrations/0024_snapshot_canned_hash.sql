-- 0024 — the canned lines' identity, recorded on the snapshot that carries them.
--
-- D-058 moves the tenant's canned responses out of the per-request volatile tail and into
-- the compiled prefix. That is worth ~1,000 tokens a reply — text that changes only when an
-- operator edits a row, billed at full input rate on every message because it was appended
-- after the cache boundary.
--
-- ## The cost of moving it, and why this column is in the same migration
--
-- Once the sentence is in the published prefix, it has TWO sources: the snapshot, which is
-- what the model reads, and `canned_responses`, which is what the deterministic
-- short-circuit answers from. Edit a row without republishing and one customer gets the new
-- line from the gate while the next gets the old one from the model — with nothing in the
-- data saying which happened. That is D-039's shape exactly, and D-029's, and D-053's:
-- two sources of one fact, disagreeing quietly.
--
-- So the identity of the rows travels WITH the snapshot. `handleReception` recomputes it
-- from the live rows and refuses with 503 `canned_stale` when they disagree, which holds
-- the customer's message in QStash until an operator republishes. Shipping the mitigation
-- after the move would leave a window in which the divergence is possible and undetectable,
-- and that window is where every incident in this list happened.
--
-- ## NULLABLE, and never backfilled — the null is a FORMAT marker
--
-- A snapshot published before this change has a prefix that does not contain the canned
-- section. Null therefore means "this prefix predates D-058", and the reply path answers it
-- by appending the section to the volatile tail exactly as it always did. It does NOT mean
-- "unknown, so skip the check" — a skip nobody can see is the failure this repository keeps
-- finding, and there is no state here in which the check is skipped.
--
-- That is what makes the rollout safe with no coordination: deploy, and every existing
-- snapshot keeps working unchanged; republish a tenant, and that tenant moves to the cached
-- form and gains the staleness guard. No window, no backfill, no flag day.
--
-- A backfill is not merely unnecessary, it is IMPOSSIBLE and should stay that way:
-- `config_snapshots` is append-only by an ENABLE ALWAYS trigger that binds `service_role`
-- too, so a published snapshot can only be superseded by appending another. Writing a hash
-- onto an old row would be claiming its prefix contains text that it does not.
--
-- ADDITIVE ONLY: one nullable column and a comment. Nothing is dropped, narrowed or
-- rewritten, and no existing row changes.

alter table config_snapshots add column if not exists canned_hash text;

comment on column config_snapshots.canned_hash is
  'sha256 of the canned-response section body as compiled into prompt_stable (D-058). '
  'NULL means this snapshot predates the section moving into the prefix, and the reply '
  'path must still append it to the volatile tail — a format marker, never "unknown". '
  'Non-null is compared against the live canned_responses rows on every request; a '
  'mismatch means an operator edited a row without republishing, and the reply refuses '
  'with 503 canned_stale rather than answering from either copy.';
