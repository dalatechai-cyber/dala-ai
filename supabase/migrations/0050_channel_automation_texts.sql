-- The texts of a Page's own Meta automations, so an automated message never counts as a
-- person (founder, 2026-09-26, D-126 addendum).
--
-- Measured the same evening on DalaTech's Page: a test comment «message» produced, from Meta
-- Business Suite's comment automations, a public reply «chat bicnuu» created in the same
-- second, and a DM «sn bnuu» 8.6 seconds later whose echo carried app id 263902037430900 —
-- the SAME id a staff member's reply typed in the Page inbox carries, with no other field to
-- tell them apart. The echo marked the conversation `human` and Dali went quiet for thirty
-- minutes; the public reply read as staff having answered the comment.
--
-- The payload cannot separate them, so the tenant says which texts are its automations: an
-- echo or a Page comment whose text is one of these (NFC, whitespace collapsed, case folded)
-- is treated like our own send — no conclusion about a person. Additive; every existing
-- channel reads '{}', which is today's behaviour.

alter table tenant_channels
  add column if not exists automation_texts text[] not null default '{}';

comment on column tenant_channels.automation_texts is
  'D-126 addendum. Exact texts of this Page''s Meta automations (instant reply, comment-to-message, auto comment reply). An echo or Page comment with one of these texts is not a person.';
