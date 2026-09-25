-- Comments get their own switch (founder, 2026-09-25, D-122).
--
-- Until now a comment reply followed the channel's `delivery_mode` — the DM switch — and the
-- only way to keep comments quiet on a live DM channel was `comment_policy = 'none'`. So the
-- public surface could be off or live, never rehearsed, while DMs were live. The founder
-- wants DMs live and comments in shadow at the same time, switched independently.
--
-- 1. `tenant_channels.comment_delivery_mode`: off / shadow / live, default `off`.
--    `shadow` decides and drafts every reply and sends nothing. `live` sends, and only
--    while the channel's token is `active` (checked in code: both halts write token_status).
--    `comment_policy` still says WHAT is sent (public line, private message, or both).
--
-- 2. `outbound_messages.comment_from_id`: who a comment reply answers. "At most one reply
--    per person per post" is counted from it. Null on every other kind of row.
--
-- 3. `comment_private_reply`: the canned kind for the private message sent to a commenter.
--
-- Additive, plus one CHECK widened (never narrowed). Every existing channel reads `off`,
-- which is what `comment_policy = 'none'` already meant for every channel today, so no
-- behaviour changes until a row is edited.

alter table tenant_channels
  add column if not exists comment_delivery_mode text not null default 'off';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'tenant_channels'::regclass and conname = 'comment_delivery_mode_known'
  ) then
    alter table tenant_channels add constraint comment_delivery_mode_known
      check (comment_delivery_mode in ('off', 'shadow', 'live'));
  end if;
end $$;

comment on column tenant_channels.comment_delivery_mode is
  'D-122. off / shadow / live for the COMMENT surface, independent of delivery_mode (DMs). '
  'shadow drafts and never sends. live sends only while token_status = active.';

alter table outbound_messages
  add column if not exists comment_from_id text;

comment on column outbound_messages.comment_from_id is
  'D-122. The commenter a comment_reply or private_reply answers. One reply per person per post is counted from it.';

-- A private reply sits under a post too, and carries it so the person rule can find it.
-- WIDENS 0009's check (comment_reply only) to both comment kinds; no existing row can fail
-- the wider check, so this narrows nothing.
alter table outbound_messages drop constraint if exists comment_post_id_only_on_comment_replies;
alter table outbound_messages add constraint comment_post_id_only_on_comment_replies
  check (comment_post_id is null or kind in ('comment_reply', 'private_reply'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'outbound_messages'::regclass and conname = 'comment_from_id_only_on_comment_kinds'
  ) then
    alter table outbound_messages add constraint comment_from_id_only_on_comment_kinds
      check (comment_from_id is null or kind in ('comment_reply', 'private_reply'));
  end if;
end $$;

create index if not exists outbound_messages_comment_person
  on outbound_messages (tenant_id, comment_post_id, comment_from_id)
  where comment_from_id is not null;

insert into canned_response_kinds (kind, description) values
  ('comment_private_reply',
   'The private message sent to a person who asked something in a public comment (D-122). '
   'Served whole; never shown to the model.')
on conflict (kind) do nothing;
