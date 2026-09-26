-- A comment rule may name its OWN pair of lines (D-144, founder 2026-09-26).
--
-- DalaTech's «comment 1» call to action: a post says «Дэлгэрэнгүй мэдээлэл авах бол 1 гэж
-- комментод бичээрэй», and a comment that is just «1» gets a public reply that says the
-- details were sent by chat, plus that private message. Those are different sentences from
-- the tenant's general comment lines, so the rule that recognises «1» names which lines it
-- answers with. Every rule that names nothing (every row today, and every rule Tara has)
-- keeps the tenant's general pair — nothing changes for it.
--
-- The two new kinds are registered here and are served ONLY by the comment worker: they are
-- in `MODEL_INVISIBLE_KINDS` (`gate/match.ts`), deployed BEFORE any row of these kinds is
-- inserted, because a row the compiled prefix does not expect moves `canned_hash` on one
-- side only and refuses every DM reply for that tenant until a republish.
--
-- Additive. Both columns are NULL on every existing row.

insert into canned_response_kinds (kind, description) values
  ('comment_cta_public_reply',
   'D-144. Public reply to a comment that answers the post''s call to action. Claims the private message was sent, so it is posted only after comment_cta_private_reply was delivered; otherwise the tenant''s comment_public_reply is posted instead.'),
  ('comment_cta_private_reply',
   'D-144. Private message to a commenter who answered the post''s call to action.')
on conflict (kind) do nothing;

alter table comment_rules
  add column if not exists public_kind text references canned_response_kinds(kind),
  add column if not exists private_kind text references canned_response_kinds(kind);

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.comment_rules'::regclass and conname = 'comment_rule_lines_paired') then
    -- A pair or nothing: a rule's own public line without its own private message is the
    -- general public line's job, and the reverse leaves a claim with nothing behind it.
    alter table comment_rules
      add constraint comment_rule_lines_paired check ((public_kind is null) = (private_kind is null));
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.comment_rules'::regclass and conname = 'comment_rule_lines_on_reply') then
    alter table comment_rules
      add constraint comment_rule_lines_on_reply check (public_kind is null or verdict = 'reply');
  end if;
end $$;

comment on column comment_rules.public_kind is
  'D-144. The canned kind this rule answers with in public, when it fires alone. Posted only after private_kind was delivered; otherwise the tenant''s comment_public_reply. NULL: the tenant''s general lines.';
comment on column comment_rules.private_kind is
  'D-144. The canned kind this rule sends privately, when it fires alone. Paired with public_kind.';
