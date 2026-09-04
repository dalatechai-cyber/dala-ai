-- 0007 — public replies to comments on a tenant's own Page posts (§3.8).
--
-- The safe version Matrix agreed to: one short fixed line pointing to DM, never an answer
-- to the substance. Everything below is per-channel configuration, because whether a
-- salon wants a bot on its public wall at all is theirs to decide, not ours.
--
-- ADDITIVE ONLY. Three nullable-or-defaulted columns and one reference-table insert.
-- Nothing is dropped, rewritten or narrowed.
--
-- ## There is deliberately no `comment_replies` table
--
-- §3.8.4 designs one for the PRIVATE reply's single-use rule, which V1 does not build.
-- The public reply's rule — one per thread, ever — is already expressed by machinery that
-- exists and is tested: an `outbound_messages` row with `kind = 'comment_reply'` and
-- `dedup_key = <thread id>`, under the unique index
-- `outbound_messages_dedup (tenant_id, kind, dedup_key)`. A redelivery then loses the
-- insert race and re-reads the winner's row, which is the same property that stops a
-- redelivered DM being answered twice.
--
-- A second table would have been a second source of truth for "did we already reply",
-- and the two would disagree the first time a worker died between them.

-- The tenant's own public sentence. A kind is the primary key of a sentence, not a
-- category (see 0003): this is NOT `refusal_public_channel`, which is Ш0's line for the
-- model when it detects a public context mid-reply. This one is the entire reply, posted
-- unconditionally, and it has to read as a welcome under a post rather than as a refusal.
insert into canned_response_kinds (kind, description) values
  ('comment_public_reply',
   'The whole public reply to a comment: acknowledge and point to DM. Never a price, a time, a name or a number.')
on conflict (kind) do nothing;

alter table tenant_channels
  -- 'none' is the default, and that is the point: a channel answers comments only when
  -- somebody deliberately turned it on. The enum carries all four of §3.8.3's values so a
  -- later migration adding the private reply does not have to rewrite the constraint;
  -- the application refuses the two it cannot honour.
  add column if not exists comment_policy text not null default 'none',
  -- §3.8.2 rule 5. Old posts attract spam and the tenant gets no value from the bot
  -- arguing with it in 2027.
  add column if not exists comment_max_post_age_days integer not null default 30,
  -- §3.8.2 rule 3. A stylist commenting from her personal account is indistinguishable
  -- from a customer by id shape, and the bot must not talk over the salon's own staff.
  add column if not exists ignore_commenter_ids text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'tenant_channels'::regclass and conname = 'comment_policy_known'
  ) then
    alter table tenant_channels add constraint comment_policy_known
      check (comment_policy in ('none', 'public_only', 'private_only', 'both'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'tenant_channels'::regclass and conname = 'comment_post_age_sane'
  ) then
    alter table tenant_channels add constraint comment_post_age_sane
      check (comment_max_post_age_days between 1 and 365);
  end if;
end $$;

comment on column tenant_channels.comment_policy is
  'none | public_only | private_only | both (§3.8.3). V1 implements none and public_only; '
  'the application refuses the other two rather than approximating them with a public reply.';

comment on column tenant_channels.ignore_commenter_ids is
  'Commenter ids never replied to — staff personal accounts. Config, not a code branch.';
