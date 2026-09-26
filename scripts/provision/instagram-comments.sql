-- Instagram comments for a tenant's Instagram channel (D-145). Answers only the rules named
-- in :rule_keys (DalaTech: cta_one — «comment 1»). Run AFTER the Meta steps in D-145.
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v tenant_slug=dalatech -v rule_keys='{cta_one}' \
--       -f scripts/provision/instagram-comments.sql
--
-- Puts comments in SHADOW: every «1» is drafted and nothing is posted or sent, except for
-- the accounts in test_sender_ids (see the end). Idempotent.

update tenant_channels c
   set comment_policy = 'both',
       comment_delivery_mode = 'shadow',
       comment_rule_keys = :'rule_keys'::text[],
       -- The Page's own limits, not the column defaults (30 days, 1 reply per post per day):
       -- a call to action lives on a post for months and is answered by many people.
       comment_max_post_age_days = 365,
       comment_replies_per_post_per_day = 20
  from tenants t
 where t.id = c.tenant_id and t.slug = :'tenant_slug' and c.provider = 'instagram';

select c.id, c.comment_policy, c.comment_delivery_mode, c.comment_rule_keys, c.test_sender_ids
  from tenant_channels c join tenants t on t.id = c.tenant_id
 where t.slug = :'tenant_slug' and c.provider = 'instagram';

-- ---------------------------------------------------------------------------
-- Test from your own Instagram account: comment «1» under one of your posts once. It is
-- drafted, not sent (shadow). Then make that account the tester:
--   update tenant_channels c set test_sender_ids = array_remove(array[(
--     select v->'value'->'from'->>'id'
--       from webhook_events w, jsonb_array_elements(w.raw_payload->'changes') v
--      where w.channel_id = c.id and v->>'field' = 'comments'
--      order by w.id desc limit 1)], null)
--    where c.provider = 'instagram'
--      and c.tenant_id = (select id from tenants where slug = '<slug>');
-- Then comment «1» under a DIFFERENT post (the first post already holds your drafted
-- reply, and one person gets one reply per post): it is answered for real, chat first.
--
-- Everybody:   update tenant_channels set comment_delivery_mode = 'live' where provider = 'instagram' and …;
-- Stop:        update tenant_channels set comment_delivery_mode = 'off'  where provider = 'instagram' and …;
