-- 0078 — the pause notice: a client e-mail after the founder pauses them (2026-10-02, founder).
--
-- One new outbox kind, `pause`. The engine plans it once per paused invoice, cancels it unsent
-- if the invoice is paid first (`only_while_unpaid`), and sends it only once its wording is
-- signed. Widening a CHECK: no existing row is touched or narrowed.

alter table billing_deliveries drop constraint billing_deliveries_kind_check;
alter table billing_deliveries add constraint billing_deliveries_kind_check check (kind in (
  'invoice', 'reminder_before', 'reminder_after', 'receipt', 'pause',
  'founder_copy', 'founder_paid', 'founder_mismatch', 'founder_pause',
  'founder_summary', 'founder_ledger', 'founder_problem'));
