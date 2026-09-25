-- Matrix / Tara Salon: comments into SHADOW (D-122). Run 2026-09-25 by the overnight session.
--
-- ORDER MATTERS, and the order is the reason this file exists:
--   1. 0045 applied (the columns and the `comment_private_reply` kind).
--   2. The code that lists `comment_private_reply` in MODEL_INVISIBLE_KINDS DEPLOYED.
--      Inserting the row before that moves the request-side canned_hash on the old code and
--      503s every DM reply with `canned_stale` until a republish.
--   3. This file.
--
-- Nothing here sends anything: `comment_delivery_mode = 'shadow'` drafts and never posts.
-- Going live is `update tenant_channels set comment_delivery_mode = 'live' where id = …`,
-- and it is the founder's switch.

begin;

-- The founder's approved wording (overnight brief, 2026-09-25). Model-invisible kinds: no
-- canned_hash moves, no republish needed.
update canned_responses
   set body = 'Сайн байна уу! Манай хуудас руу мессеж бичвэл дэлгэрэнгүй хариулъя 😊',
       reviewed_at = now()
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
   and kind = 'comment_public_reply';

insert into canned_responses (tenant_id, kind, locale, body, reviewed_at)
select id, 'comment_private_reply', default_locale,
       'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.', now()
  from tenants where slug = 'matrix-eco-salon'
on conflict do nothing;

-- Public line AND private message; shadow; one reply per person per post is the rule, and
-- the per-post cap becomes a flood ceiling rather than "one person per post per day".
update tenant_channels
   set comment_policy = 'both',
       comment_delivery_mode = 'shadow',
       comment_replies_per_post_per_day = 20
 where id = '1fb6d543-3e14-4f42-ab9e-fd39cbc09cd5';

commit;

-- Then the rules: node scripts/provision/comment-rules.ts matrix-eco-salon
