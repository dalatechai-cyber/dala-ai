-- Reconcile `tenant_channels.subscribed_fields` with what Meta actually delivers.
--
-- ## Why this needed a correction at all
--
-- The column is READ BY NOTHING. It is written at provisioning and never consulted since
-- — D-064's shape — so being wrong cost no customer anything. What it did cost is worse
-- in a slower way: it is the ONLY record inside this platform of which fields are
-- subscribed at Meta, and `developers.facebook.com` is 403 through this environment's
-- egress proxy, so no session can check the App Dashboard to correct it. An unfalsifiable
-- claim in this repository is a claim to re-ask about, not a fact to inherit (CLAUDE.md),
-- and this one had already misled a document: `docs/comments.md` states that
-- `subscribed_fields` "now carries `feed`" while the live row said `{messages}`. Two
-- copies of one fact, drifting, with the wrong one written down as settled.
--
-- ## Why DELIVERY is better evidence than "what we wrote to Meta"
--
-- `scripts/provision/matrix-stage1.sql` says the column "mirrors what was actually
-- written to Meta". That is the weaker source and D-043 is why: `POST
-- /{page-id}/subscribed_apps` returns `{"success": true}` when the app has never enabled
-- the field on the object, so a write can succeed and subscribe nothing. A delivery
-- cannot lie in that direction — Meta does not send a field nobody is subscribed to.
--
-- ## The evidence, per page, measured 2026-09-21 against `webhook_events`
--
--   page 1520409424715591 (Matrix)    feed 86   messaging 219   echoes 1
--   page 863503883522801 (tenant #0)  feed  0   messaging  11   echoes 0
--
-- Matrix therefore carries all three. Tenant #0 is NOT touched by this script and its
-- `{messages}` stands: zero `feed` entries is not evidence of no subscription, only
-- evidence that nobody has commented on that Page — the absence/disproof distinction
-- D-062 cost eleven days on. Writing `{messages}` back over it would assert a fact this
-- measurement cannot support.
--
-- Reversible in one statement; nothing reads the column, so applying it changes no
-- behaviour for any tenant.
--
--   \set ON_ERROR_STOP on
--   psql "$SUPABASE_DB_URL" -f scripts/provision/matrix-subscribed-fields.sql

update tenant_channels
set    subscribed_fields = '{messages,feed,message_echoes}'
where  external_id = '1520409424715591'
  and  provider    = 'facebook_page';

-- Read it back in the same breath. A write that reports success and changed no row looks
-- identical to one that worked, which is the failure this file exists to end.
select external_id, subscribed_fields
from   tenant_channels
where  external_id in ('1520409424715591', '863503883522801')
order  by external_id;
