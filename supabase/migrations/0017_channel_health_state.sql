-- 0017 — `channel_health` carries the verdict, not only a boolean.
--
-- The watchdog produces five distinguishable states (`healthy`, `no_webhooks`,
-- `no_messages`, `not_provisioned`, `unknown`) and this table stored one bit of them plus
-- a sentence of prose. D-032 removed the conflation from the ALERT — a provisioning gap no
-- longer pages — but the row still said `healthy = false` with no way for a reader to tell
-- a Page whose token died from a tenant whose opening hours have not been typed in yet.
--
-- That is the same failure one layer down, waiting for the first thing that queries this
-- table. "How many channels are unhealthy?" is the obvious first dashboard question, and
-- with a boolean the only available answer counts an unfinished form as an outage. Prose
-- is not a substitute: `reason` is written for a human reading one row, and parsing it is
-- how a dashboard comes to depend on the exact wording of an alert sentence.
--
-- ## No CHECK on the vocabulary, and that is deliberate
--
-- The obvious `check (state in (...))` would put the list of verdicts in two places. The
-- states are a code-level union that will grow — this migration exists because it grew
-- once already — and a constraint that must be migrated in lockstep with a TypeScript type
-- fails in the worst possible way: `record()` logs a failed write to the console and
-- carries on, so a state the CHECK had not heard of would silently stop health being
-- recorded at all, on exactly the release that added it. The column is descriptive. The
-- vocabulary lives in `src/lib/health/channel.ts`.
--
-- ## One CHECK that is NOT a vocabulary
--
-- `healthy` and `state` are two spellings of one fact, and two spellings drift. The
-- constraint ties them together without naming a single state:
--
--     healthy = (state = 'healthy')
--
-- It holds for any state that will ever be added, and it makes the drift this migration
-- exists to prevent unrepresentable rather than merely unlikely.
--
-- ## Nullable, with no default and no backfill
--
-- A row written before this column existed has no state, and inventing one would be the
-- D-020 failure in miniature: a guess that becomes indistinguishable from a fact the
-- moment it is written. `null` means "written by a version that predated the column", the
-- CHECK permits it, and the watchdog overwrites every row on its next hourly run — so the
-- gap closes by itself within the hour rather than by a backfill that asserts something
-- nobody measured.
--
-- ADDITIVE ONLY: one nullable column and one CHECK that every existing row satisfies. No
-- data is rewritten, nothing is dropped, and the table has exactly one writer.

alter table channel_health add column if not exists state text;

comment on column channel_health.state is
  'The watchdog''s verdict: healthy | no_webhooks | no_messages | not_provisioned | '
  'unknown. Null only on rows written before 0017. `healthy` is the same fact as '
  'state = ''healthy'' and the CHECK holds them together; read THIS column to tell a '
  'provisioning gap from an outage, never the boolean and never the prose in `reason`.';

alter table channel_health drop constraint if exists channel_health_state_matches_healthy;
alter table channel_health add constraint channel_health_state_matches_healthy
  check (state is null or healthy = (state = 'healthy'));
