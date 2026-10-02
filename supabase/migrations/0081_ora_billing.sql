-- 0081 — Ора's packs through DalaTech's billing (founder, 2026-10-02; ora repo,
-- docs/DALA_AI_CHANGE_REQUEST.md and docs/PAYMENTS.md).
--
-- An Ора owner buys a pack inside Ора. Ора asks this platform for a one-off invoice
-- (`POST /api/ora/pack-invoice`, signed); the owner pays it on the usual pay page through
-- QPay; once the payment is recorded, the engine sends Ора one signed `pack.paid` event
-- through the existing outbox. Ора never talks to QPay.
--
-- 1. `billing_accounts.ora_account`: the founder marks which billing accounts are Ора
--    clients. Only those may be invoiced by Ора's request, so a holder of Ора's platform
--    secret can never put an invoice on Tara's or DalaTech's own account. False on every
--    existing row: nothing changes for them.
-- 2. The outbox gains a `webhook` channel and an `ora_pack_paid` kind: the event to Ора is
--    queued once per paid pack invoice (dedup key), claimed, sent and retried like an
--    e-mail. Widening two CHECKs: no existing row is touched or narrowed.

alter table billing_accounts add column ora_account boolean not null default false;
comment on column billing_accounts.ora_account is
  'An Ора client: Ора may request pack invoices on this account (POST /api/ora/pack-invoice). Set by the founder. 0081.';

alter table billing_deliveries drop constraint billing_deliveries_kind_check;
alter table billing_deliveries add constraint billing_deliveries_kind_check check (kind in (
  'invoice', 'reminder_before', 'reminder_after', 'receipt', 'pause',
  'founder_copy', 'founder_paid', 'founder_mismatch', 'founder_pause',
  'founder_summary', 'founder_ledger', 'founder_problem',
  'ora_pack_paid'));

alter table billing_deliveries drop constraint billing_deliveries_channel_check;
alter table billing_deliveries add constraint billing_deliveries_channel_check check (channel in ('email', 'telegram', 'webhook'));
