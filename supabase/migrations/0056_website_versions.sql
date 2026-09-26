-- A website version of an approved line, and reply cases per channel (founder, 2026-09-26, D-140).
--
-- *"On the website channel, Дали never links or refers visitors to dalatech.online itself.
-- On Messenger it still may. Approved lines can have a website version where needed."* The
-- visitor on a tenant's website is already on that site; the Page customer is not. So an
-- approved line may carry a second, approved wording for the website channel, served there in
-- place of `body`. NULL means the line reads the same on both channels.
--
-- Only the two tables read per request carry it. `canned_responses` is compiled into the
-- cached prefix and hashed (`canned_hash`), so a second body there would be a second source of
-- one fact; a canned line that points at the tenant's own site is handled by the website rule
-- in `src/lib/website/ownSite.ts` instead (that sentence is not sent on the website).
--
-- `reply_cases.channel`: a case answered as the website answers it (`web`) or as the Page does
-- (`facebook_page`, every case before this). The gate runs each on its own channel's terms.
--
-- Additive: two nullable columns and one with a default equal to what every existing row
-- already meant. Nothing existing changes.
alter table sales_next_steps add column web_body text;
comment on column sales_next_steps.web_body is
  'The approved wording of this step for the website channel; NULL = same as body. D-140.';

alter table deterministic_replies add column web_body text;
comment on column deterministic_replies.web_body is
  'The approved wording of this row for the website channel; NULL = same as body. D-140.';

alter table reply_cases add column channel text not null default 'facebook_page'
  check (channel in ('facebook_page', 'web'));
comment on column reply_cases.channel is
  'Which channel answers this case: facebook_page (the Page, and every case before 0056) or web. D-140.';
