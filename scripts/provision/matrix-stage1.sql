-- Matrix Eco Salon — Stage 1: routing only.
--
-- Run once, against the project, as a role that can write these tables. Idempotent: every
-- statement is guarded on a natural key, so a second run changes nothing.
--
-- ## What this does and, more importantly, what it does not
--
-- On 2026-09-07 DALA_AI was subscribed to Matrix's Page 1520409424715591 alongside the
-- incumbent `dalatech` app, and the mirror was proven on their own Page: event 9 arrived in
-- `entry.messaging`, no Handover demotion, their bot answering normally throughout (D-043).
-- Their real customer traffic is therefore arriving here NOW and landing as
-- `routing='unrouted'` — persisted, unattributed, unanswerable, and outside every alert.
--
-- This file makes those messages ROUTE. It does not make them ANSWERED:
-- `delivery_mode='shadow_routing'` is the mode whose own description reads «routing is
-- being rehearsed; nothing is generated or sent», and `channel/delivery.ts` returns
-- `generate: false` for it. `worker/reception.ts` therefore stops after storing the inbound
-- message — §3.4.5's "persist everything, generate nothing" — before the spend reservation
-- and before any model call. **Zero dollars, zero replies.**
--
-- Deliberately NOT here, and each for its own reason:
--   * `tenant_budgets` — money movement, founder-gated. Not needed until generation starts.
--   * `tenant_roles`   — entitlement. Same: nothing is generated yet.
--   * `canned_responses`, the knowledge base — customer-visible Mongolian, founder-gated,
--                         and blocked on Matrix's own answers (chemistry still in flight).
--   * `tenant_secrets` — a Page token. The mirror never sends, and `reception.ts` returns
--                         at `if (!delivery.deliver)` BEFORE `fx.deliver`, which is the only
--                         thing that opens a sealed secret. Credentials are off this path.
--
-- Stage 5 (`delivery_mode='shadow'`) waits for the knowledge base. Starting the fourteen-day
-- mirror against a draft KB measures a draft: `hasTenantData` would be false, every reply
-- would be the handoff line (D-033), and any partial KB produces coverage numbers that have
-- to be discounted afterwards.
--
-- ## `app_slug` is `dalatech`, and that is not a typo — read D-041
--
-- The Page really is on the Meta app named DALA_AI (1562862634970492). `app_slug` is NOT
-- Meta's name for an app: it is this platform's name for a callback path, and the value the
-- cross-check compares against is `verifyMetaSignature(...).matchedAppSlug` — the key in
-- `META_APP_SECRETS` that matched. Both apps' secrets live under the single key `dalatech`
-- as an array, so `matchedAppSlug` is always `dalatech`. Measured, not assumed: webhook
-- events 9 and 10, arriving on Matrix's Page through DALA_AI, carry dedup keys ending
-- `:dalatech`.
--
-- The cost of getting this wrong is not a warning. `webhook/entry.ts` runs
--
--     if (tenant.appSlug !== null && tenant.appSlug !== input.matchedAppSlug)
--       return { outcome: 'app_mismatch', ... };
--
-- and that `return` is BEFORE `claimWebhookEvent`. So `app_slug='DALA_AI'` would drop every
-- Matrix message with no row at all — a console.error and a 200 — which is strictly worse
-- than the unrouted state this file replaces, because unrouted at least persists.
--
-- The check consequently cannot fail today (D-041); it is set to the value that routes, and
-- the slug move is what makes it meaningful again.
--
-- ## Business hours: Mon-Sat 10:00-20:00, Sun 11:00-19:00, as stated by Matrix
--
-- `weekday` is **0 = Sunday**, the Postgres `dow` convention — see `reception/volatile.ts`.
-- Hours are what the silence watchdog measures silence in: without them the channel reads
-- `not_provisioned` and is recorded rather than alerted (D-032), which is exactly the blind
-- spot this stage exists to close.

begin;

-- 1. The tenant. `status` stays the default 'provisioning' — `active` would need
--    `probe_passed_at` and `live_revision_id`, and nothing on the reply path reads it.
insert into tenants (slug, display_name, vertical, timezone)
select 'matrix-eco-salon', 'Matrix Eco Salon', 'salon', 'Asia/Ulaanbaatar'
where not exists (select 1 from tenants where slug = 'matrix-eco-salon');

-- 2. The channel. `status='pending'` is honest: no probe has run.
--    `subscribed_fields` mirrors what was actually written to Meta for DALA_AI.
insert into tenant_channels (
  tenant_id, provider, external_id, auth_flavour, app_slug,
  status, delivery_mode, token_status, subscribed_fields
)
select t.id, 'facebook_page', '1520409424715591', 'facebook_login', 'dalatech',
       'pending', 'shadow_routing', 'unprovisioned', array['messages']
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from tenant_channels c
    where c.provider = 'facebook_page' and c.external_id = '1520409424715591'
  );

-- 3. The identity row. THIS is what routing resolves against — `tenant/resolve.ts` reads
--    `channel_identity` and inner-joins `tenant_channels`, so a channel row alone still
--    routes to nobody. `channel_identity_live_key` is unique on (provider, external_id)
--    where active, which is what makes one Page belong to at most one tenant platform-wide.
insert into channel_identity (tenant_id, channel_id, provider, external_id, active, note)
select c.tenant_id, c.id, c.provider, c.external_id, true,
       'Mirror subscription via DALA_AI alongside the incumbent dalatech app (D-043).'
from tenant_channels c
join tenants t on t.id = c.tenant_id
where t.slug = 'matrix-eco-salon'
  and c.external_id = '1520409424715591'
  and not exists (
    select 1 from channel_identity ci
    where ci.provider = 'facebook_page'
      and ci.external_id = '1520409424715591'
      and ci.active
  );

-- 4. Business hours, as stated by Matrix. `open_days_have_hours` refuses a row that is not
--    closed and has no times, so a typo here fails loudly rather than reading as midnight.
insert into business_hours (tenant_id, weekday, opens, closes, closed)
select t.id, v.weekday, v.opens::time, v.closes::time, false
from tenants t
cross join (values
  (0::smallint, '11:00', '19:00'),   -- Sunday
  (1::smallint, '10:00', '20:00'),   -- Monday
  (2::smallint, '10:00', '20:00'),
  (3::smallint, '10:00', '20:00'),
  (4::smallint, '10:00', '20:00'),
  (5::smallint, '10:00', '20:00'),
  (6::smallint, '10:00', '20:00')    -- Saturday
) as v(weekday, opens, closes)
where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, weekday) do nothing;

commit;
