-- A superseded revision keeps the time it went live.
--
-- ## The bug this fixes, and how it was found
--
-- `publishRevision`'s step 3 supersedes the outgoing revision:
--
--     .update({ status: 'superseded' })
--
-- It does not touch `published_at`, and `published_has_a_time` was written as
--
--     check ((status = 'published') = (published_at is not null))
--
-- so that UPDATE is REFUSED for every revision that has ever been live. Measured against a
-- real PostgreSQL 2026-09-07 by running the exact statement:
--
--     ERROR: new row for relation "config_revisions" violates check constraint
--            "published_has_a_time"
--
-- **Every tenant's SECOND publish fails, and fails halfway.** Steps 1 and 2 have already
-- committed by then — the new snapshot is inserted and the new revision is marked
-- published — so the failure leaves TWO rows claiming `published` and the pointer still on
-- the old one. `publish.ts`'s own comment on that step says two published rows are "a state
-- nothing else in the schema can disambiguate", and the constraint was making that state
-- the guaranteed outcome rather than the avoided one.
--
-- Nothing caught it because `publish.test.ts` runs against a stubbed client that accepts
-- any update, and no tenant had ever published twice. It is the D-029 lesson exactly: a
-- passing suite said nothing about this and could not have.
--
-- ## Why the constraint is widened rather than the code changed
--
-- The alternative fix is for step 3 to null `published_at`. That satisfies the old rule and
-- destroys real history: a superseded revision WAS live, and the moment it went live is the
-- only record of when. `rollbackTo` moves the pointer without re-publishing, so nothing
-- would ever write that timestamp back. The audit question "what configuration was live at
-- 19:12 on the 6th" becomes unanswerable to save a CHECK.
--
-- The truthful rule is that a DRAFT has no publication time and everything else does:
--
--     (status = 'draft') = (published_at is null)
--
-- which still refuses a published row with no time — the thing the original constraint was
-- written to prevent — and additionally refuses a draft that claims one, which the original
-- allowed.
--
-- ADDITIVE: this only ever permits more rows than before, so no existing row can fail it.
-- Verified against the project first — one revision, `dalatech` seq 1, published, and it
-- satisfies the new rule.

alter table config_revisions drop constraint if exists published_has_a_time;

alter table config_revisions
  add constraint published_has_a_time
  check ((status = 'draft') = (published_at is null));

comment on constraint published_has_a_time on config_revisions is
  'A draft has no publication time; a published or superseded revision has one. Superseded '
  'rows keep theirs because rollbackTo moves the pointer without re-publishing, so it is '
  'the only record of when that configuration was live.';
