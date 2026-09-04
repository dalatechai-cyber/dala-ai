-- 0006 — how old a message may be and still get an answer (§3.9's H11 check 7).
--
-- Settled by the founder 2026-09-04: 30 minutes, because "a bot answering an hour-old
-- Messenger message reads as broken, not helpful."
--
-- Per tenant, not per platform, and that is the whole reason it is a column: §3.9 names
-- 120 as a plausible value for GS Auto Center, whose customers are waiting on a car rather
-- than a haircut. CLAUDE.md's test — onboarding client #3 fills in a config rather than
-- writing code — makes anything that distinguishes one customer from another a row.
--
-- ADDITIVE ONLY. Nothing is dropped, rewritten or narrowed: one new column with a NOT NULL
-- default, so every existing row acquires the design's own default rather than a NULL that
-- some later reader has to guess about.

alter table tenants
  add column if not exists max_reply_age_minutes integer not null default 30;

-- 1 minute to one day. The upper bound is not decoration: past 24 hours Messenger's own
-- window has closed, so a larger value cannot mean what whoever typed it thought it meant,
-- and a fat-fingered 3000 would silently turn the freshness gate off.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'tenants'::regclass and conname = 'reply_age_within_messaging_window'
  ) then
    alter table tenants
      add constraint reply_age_within_messaging_window
      check (max_reply_age_minutes between 1 and 1440);
  end if;
end $$;

comment on column tenants.max_reply_age_minutes is
  'H11 check 7. A message older than this is persisted, flagged reply_too_late for the '
  'Quality layer, and never answered — no reservation, no model call, no send. Measured '
  'from Meta''s occurred_at, never our received_at: a delayed delivery must not look fresh '
  'just because we saw it late.';
