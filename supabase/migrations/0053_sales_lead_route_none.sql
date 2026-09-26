-- A tenant whose staff do not call customers back has nowhere to route a lead (2026-09-26).
--
-- Founder, 2026-09-26: *"The salon confirmed their staff will not call customers back. For
-- Tara: remove the callback and lead_thanks steps entirely. Дали never asks a Tara customer
-- for a phone number. The Page inbox label for Tara leads isn't needed any more."*
--
-- `lead_route` is NOT NULL with three destinations, so "no destination" had no honest value:
-- leaving Tara on `page_label` would record every volunteered number as routed to a label
-- nobody wants. `none` says what is true. A customer who types a number anyway is still
-- DETECTED (the shadow records it, masked) and still silences the next step for that turn —
-- only the routing claim changes.
--
-- Additive: the CHECK widens, no row changes here. The tenant's row moves in
-- scripts/provision/matrix-no-callback-2026-09-26.sql.
alter table sales_playbooks drop constraint sales_playbooks_lead_route_check;
alter table sales_playbooks add constraint sales_playbooks_lead_route_check
  check (lead_route in ('founder_telegram', 'tenant_telegram', 'page_label', 'none'));
