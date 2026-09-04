-- 0009 — one public reply per POST per day (§3.8.2 rule 4).
--
-- The founder's call, 2026-09-04: *"Five identical Dalatech-shaped replies under one
-- salon post reads as spam, and the reply's whole job is 'come to DM' — saying it once is
-- enough for everyone reading. Keep the per-thread rule as the inner guard."*
--
-- This SUPERSEDES §3.8.2's drafted `comment_replies_per_post_per_hour` (default 10). Ten
-- an hour is a rate limit; the problem is not rate, it is repetition — the same sentence
-- appearing five times under one post is spam at any speed.
--
-- ADDITIVE ONLY. Two columns and one index. Nothing is dropped, rewritten or narrowed.
--
-- ## Why the counter is a column on `outbound_messages` and not a new table
--
-- 0007 argued against a `comment_replies` table because it would be a second source of
-- truth for "did we already reply", and the two would disagree the first time a worker
-- died between them. That argument applies here with more force, not less: a separate
-- counter incremented next to the row it counts is exactly the pair that drifts.
--
-- So the post id goes on the row that already exists. One table answers both questions —
-- "has this thread been answered" (`dedup_key`) and "how many replies has this post had"
-- (`comment_post_id` + `created_at`) — and there is nothing to reconcile. The draft row is
-- written BEFORE the send, so a worker that dies mid-send leaves the count high and we
-- under-reply. On a public wall that is the direction to fail in.
--
-- ## "Per day" is a rolling 24 hours, deliberately
--
-- A calendar day needs a timezone we would have to look up per tenant, and it has a hole:
-- a comment at 23:59 and another at 00:01 are two different days and would both be
-- answered, two minutes apart, under the same post. A rolling window has neither problem
-- and is what "once a day" means when the point is not to look like spam.

alter table outbound_messages
  -- The post the replied-to comment sits under. NULL for every other kind, and the CHECK
  -- below makes that structural rather than conventional.
  add column if not exists comment_post_id text;

alter table tenant_channels
  -- 1 is the founder's number. It is a column rather than a constant because a busy Page
  -- may want more later, and because everything that distinguishes one tenant from
  -- another is a row.
  add column if not exists comment_replies_per_post_per_day integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'outbound_messages'::regclass and conname = 'comment_post_id_only_on_comment_replies') then
    -- A post id on an SMS reminder is nonsense, and nonsense in this column would be
    -- counted against some post's daily cap.
    alter table outbound_messages add constraint comment_post_id_only_on_comment_replies
      check (comment_post_id is null or kind = 'comment_reply');
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'tenant_channels'::regclass and conname = 'comment_post_cap_sane') then
    -- The lower bound is 1, not 0: switching comments OFF is `comment_policy = 'none'`,
    -- which is a different decision from "on, but never reply", and a cap of 0 would be a
    -- second, silent way to express it.
    alter table tenant_channels add constraint comment_post_cap_sane
      check (comment_replies_per_post_per_day between 1 and 50);
  end if;
end $$;

-- The cap's only query: replies on these posts, recently. `created_at` is in the index
-- because the window is the whole point — without it this degrades to a scan of every
-- reply the tenant has ever posted.
create index if not exists outbound_messages_comment_post
  on outbound_messages (tenant_id, comment_post_id, created_at)
  where kind = 'comment_reply' and comment_post_id is not null;

comment on column outbound_messages.comment_post_id is
  'The Facebook post a comment_reply was posted under. NULL for every other kind. Counted '
  'against tenant_channels.comment_replies_per_post_per_day over a rolling 24 hours.';

comment on column tenant_channels.comment_replies_per_post_per_day is
  'Public replies allowed under ONE post in any rolling 24 hours. Default 1: the reply is '
  'the same sentence every time, so saying it twice under one post reads as spam. The '
  'per-thread rule (one reply per thread, ever) still applies inside this.';
