-- An Instagram account as a channel of an existing tenant, messaged through its Page (D-141).
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -v tenant_slug=dalatech -v ig_id=<INSTAGRAM ACCOUNT ID> -v ig_name=@dalatech_ \
--       -f scripts/provision/instagram-channel.sql
--
-- The account id is the `id` Meta puts in `entry.id` of an Instagram webhook: the
-- `instagram_business_account.id` of the Page (GET /{page-id}?fields=instagram_business_account),
-- or the `entry_id` of the first `unrouted` instagram row in `webhook_events` once the
-- subscription is on. It is NOT the @handle and NOT the Page id.
--
-- Idempotent. Creates the channel OFF. Nothing is answered until you move it:
--   off -> shadow (+ your own sender id in test_sender_ids) -> live.  See the end of this file.
--
-- Reads from the tenant's Page channel: the app it arrives through, Meta's app id, and the
-- Page it sends through. No credential is written: the Instagram channel uses the Page's
-- sealed page_token (via_channel_id), so the system-user token must carry the Instagram
-- permissions — see D-141 for the Meta steps.

begin;

with page as (
  select c.id, c.tenant_id, c.app_slug, c.meta_app_id, c.token_status
    from tenant_channels c join tenants t on t.id = c.tenant_id
   where t.slug = :'tenant_slug' and c.provider = 'facebook_page'
)
insert into tenant_channels (
  tenant_id, provider, external_id, auth_flavour, app_slug, meta_app_id, verified_name,
  status, delivery_mode, token_status, via_channel_id, comment_policy, comment_delivery_mode
)
select page.tenant_id, 'instagram', :'ig_id', 'facebook_login', page.app_slug, page.meta_app_id, :'ig_name',
       'active', 'off', page.token_status, page.id, 'none', 'off'
  from page
 where (select count(*) from page) = 1
   and not exists (select 1 from tenant_channels x
                    where x.tenant_id = page.tenant_id and x.provider = 'instagram' and x.external_id = :'ig_id');

insert into channel_identity (tenant_id, channel_id, provider, external_id, note)
select c.tenant_id, c.id, 'instagram', c.external_id, 'D-141: Instagram account, messaged through its Page'
  from tenant_channels c join tenants t on t.id = c.tenant_id
 where t.slug = :'tenant_slug' and c.provider = 'instagram' and c.external_id = :'ig_id'
   and not exists (select 1 from channel_identity i
                    where i.provider = 'instagram' and i.external_id = :'ig_id' and i.active);

-- What was written. Exactly one row, OFF, pointing at the Page.
select c.id, c.provider, c.external_id, c.delivery_mode, c.token_status, c.app_slug, c.meta_app_id,
       p.external_id as sends_through_page,
       (select count(*) from channel_identity i where i.channel_id = c.id and i.active) as identities
  from tenant_channels c join tenants t on t.id = c.tenant_id
  left join tenant_channels p on p.id = c.via_channel_id
 where t.slug = :'tenant_slug' and c.provider = 'instagram';

commit;

-- ---------------------------------------------------------------------------
-- After this: republish the tenant once, so an `instagram` snapshot exists (same rows,
-- same compiler as the Page):   node scripts/publish/tenant.ts --tenant <slug>   (dry run,
-- then --apply). Until then an Instagram message is stored and refused `no_snapshot`.
--
-- Try it from your own Instagram (nobody else is answered):
--   update tenant_channels set delivery_mode = 'shadow', name_confirmed_at = now()
--    where provider = 'instagram' and external_id = '<ig_id>';
--   -- send one message from your own account, then add yourself as the tester:
--   update tenant_channels c set test_sender_ids = array[(
--     select k.external_id from contacts k where k.channel_id = c.id order by k.first_seen_at desc limit 1)]
--    where c.provider = 'instagram' and c.external_id = '<ig_id>';
--   -- your next messages are answered for real; everyone else is drafted only.
--
-- Go live for everybody:
--   update tenant_channels set delivery_mode = 'live', test_sender_ids = '{}'
--    where provider = 'instagram' and external_id = '<ig_id>';
-- Stop, instantly, no deploy:
--   update tenant_channels set delivery_mode = 'off' where provider = 'instagram' and external_id = '<ig_id>';
