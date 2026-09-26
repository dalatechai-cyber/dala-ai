-- The sales line goes live, tenant by tenant, as a row (founder, 2026-09-26, D-132).
--
-- *"DalaTech salesperson: go live without waiting for shadow numbers (my Page gets little
-- traffic). Tara stays in shadow until real-traffic numbers."* And the line itself: after Дали
-- answers a question, one approved follow-up, once per conversation, never after a complaint
-- or a greeting or a thanks; the approved demo / callback / lead_thanks lines still apply
-- when the customer asks for a demo, a call, or leaves a number.
--
-- Three additive changes, nothing narrowed:
--
--  1. `sales_playbooks.mode` admits `live`. 0051 left the value out on purpose so that no
--     UPDATE could switch sending on before the code that sends existed; this is that code's
--     migration. `shadow` and `off` mean what they meant.
--  2. `sales_next_steps.kind` admits `follow_up`: the default line after an answer, when no
--     step's intent words fired. It may be the tenant's default step.
--  3. `sales_playbooks.small_talk`: whole messages that are only a greeting or a thanks, in the
--     tenant's own words and spellings. A message matched whole by one gets no sales line.
--     Rows, not code: a greeting list is language data and differs by tenant.
alter table sales_playbooks drop constraint sales_playbooks_mode_check;
alter table sales_playbooks add constraint sales_playbooks_mode_check
  check (mode in ('off', 'shadow', 'live'));

alter table sales_playbooks add column small_talk text[] not null default '{}';
comment on column sales_playbooks.small_talk is
  'Whole messages that are only a greeting or a thanks. A match gets no sales line. D-132.';

alter table sales_next_steps drop constraint sales_next_steps_kind_check;
alter table sales_next_steps add constraint sales_next_steps_kind_check
  check (kind in ('demo', 'booking', 'callback', 'related_service', 'lead_thanks', 'follow_up'));

alter table sales_next_steps drop constraint sales_step_default_is_offerable;
alter table sales_next_steps add constraint sales_step_default_is_offerable
  check (not is_default or kind in ('demo', 'booking', 'callback', 'follow_up'));
