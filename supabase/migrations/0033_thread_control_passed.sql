-- The reclaim sweeper's missing discriminator, and the two rows it will serve.
--
-- `docs/handover.md` names this as the one thing blocking the sweeper, in as many words:
-- the reclaim window (15 minutes) is SHORTER than `human_takeover_cooldown_minutes` (30),
-- so a sweeper that reclaims any `human` thread makes the cooldown unreachable. The design
-- scopes the reclaim to threads WE passed — and `thread_control_source` could not say so,
-- because `handover` is written both when this platform passes a thread and when a person
-- takes it through Meta's own UI. One value, two facts, and the safety of the whole feature
-- turns on telling them apart.
--
-- `passed` is that discriminator. Founder's call, 2026-09-20: reclaim only our own passes.
--
-- ## Why this is a widening and never a backfill
--
-- Not one existing row is retyped. D-063's addendum is the reason and it is recent enough
-- to still sting: `0025` added a discriminator with a DEFAULT, and that default
-- retroactively decided the semantics of the ten rows recording an eleven-day outage —
-- the exact rows the change was built for. Here the rule reads the other way round and
-- costs nothing: a thread whose source says `handover` is a thread we cannot prove we
-- passed, so it is not ours to reclaim, and leaving it alone is the conservative answer
-- rather than a gap. `passed` starts empty and fills only from the pass path.
--
-- ## The two kinds, and the order they must be deployed in
--
-- `handover_notice` goes out WITH the pass; `handover_reclaim` when the window expires and
-- nobody came. Both are served WHOLE by the platform with no model in the loop, like
-- `image_received` and `comment_public_reply`.
--
-- The kinds are registered here and NO ROW IS INSERTED. That is deliberate and it is an
-- ordering constraint, not tidiness: both kinds must be in `MODEL_INVISIBLE_KINDS` **and
-- deployed** before a tenant's row exists, or `cannedSectionBody` sweeps the sentence into
-- the cached prefix, `canned_hash` moves on one side only, and every DM reply for that
-- tenant 503s with `canned_stale` until a republish. That is D-082's outage with a
-- different sentence in it. The code half ships in this same PR; the ROWS wait for the
-- founder's reading evening, and both sentences are unsigned in
-- `prompt/drafts/handover_notice_and_reclaim.mn.txt`.

alter table conversations
  drop constraint if exists conversations_thread_control_source_known;

alter table conversations
  add constraint conversations_thread_control_source_known
  check (
    thread_control_source is null
    or thread_control_source = any (array['handover', 'echo', 'reclaim', 'passed'])
  );

insert into canned_response_kinds (kind, description) values
  ('handover_notice',  'Sent WITH a pass: tells the customer a person is taking over and that the bot will stop replying'),
  ('handover_reclaim', 'Sent when the reclaim window expires and nobody picked the thread up')
on conflict (kind) do nothing;
