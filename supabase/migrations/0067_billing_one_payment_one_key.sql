-- 0067 — a QPay payment recorded by hand and the same payment read automatically can never
-- both be counted, even at the same moment (D-156 addendum, founder 2026-09-28).
--
-- A QPay payment is keyed `qpay:<id>`. The automatic check (recorded_by 'check' /
-- 'callback') keys it by the id QPay's API reports; the founder's `settle.ts qpay` keys it by
-- the id typed in (recorded_by 'operator:<name>'). If the two ids differ, the unique
-- `payment_key` cannot see that they are the same money. PR #231 guarded this in code, as a
-- read and then a write in separate statements: a hand entry and a check running in the same
-- seconds could each read "nothing conflicting" and both insert.
--
-- The rule now lives in `billing_record_payment`, after it has locked the invoice row
-- (`for update`), so every record for one invoice is serialised and each sees the one before:
--
--   a QPay payment under a NEW key is refused when the invoice already holds a QPay payment
--   recorded by the OTHER kind of recorder (hand vs automatic) under a different key,
--   unless the caller says it is a second payment (`p_second_payment`, only settle.ts
--   --second-payment yes passes it; the automatic path never does).
--
--   The automatic path passes every key in the QPay answer it is recording from
--   (`p_reported_keys`). A hand-recorded key QPay itself reports in that answer is a payment
--   QPay has identified, distinct from the others it lists, so it is not a conflict: a
--   second payment QPay reports after the founder typed the first under QPay's own id is
--   recorded (and the invoice shows paid twice), never swallowed.
--
-- And every write to billing_payments goes through this function (so through its lock and
-- its rule): a direct insert, which service_role's table grant would otherwise allow, is
-- refused by a trigger unless this function set the transaction-local marker.
--
-- Unchanged: the same key again is still a no-op (idempotent), a second automatic payment is
-- still recorded (a second payment on a paid code is a mismatch the founder must see), and a
-- bank transfer is never affected. Nothing is dropped from any table; only the function is
-- replaced. The engine calls it with named arguments and no `p_second_payment`, so the new
-- default (false) keeps the running code working before and after this migration.

drop function public.billing_record_payment(uuid, text, text, bigint, timestamptz, text, text, text);

create function public.billing_record_payment(
  p_invoice uuid, p_payment_key text, p_source text, p_amount bigint, p_paid_at timestamptz,
  p_qpay_invoice_id text, p_recorded_by text, p_note text, p_second_payment boolean default false,
  p_reported_keys text[] default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  inv       billing_invoices%rowtype;
  inserted  boolean;
  total     bigint;
  latest    timestamptz;
  next      text;
  by_hand   boolean := p_recorded_by like 'operator:%';
  other     text;
begin
  select * into inv from billing_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'no invoice %', p_invoice; end if;
  if p_source = 'qpay' and (inv.qpay_invoice_id is null or inv.qpay_invoice_id <> p_qpay_invoice_id) then
    raise exception 'payment for QPay invoice % does not belong to invoice % (holds %)',
      p_qpay_invoice_id, inv.invoice_no, coalesce(inv.qpay_invoice_id, 'none');
  end if;
  -- Under the invoice lock: a QPay payment the other kind of recorder already holds under a
  -- different key may be this same money. Refuse unless the caller says it is a second one.
  if p_source = 'qpay' and not coalesce(p_second_payment, false)
     and not exists (select 1 from billing_payments where payment_key = p_payment_key) then
    select string_agg(payment_key, ', ' order by payment_key collate "C") into other
      from billing_payments
     where invoice_id = p_invoice and source = 'qpay'
       and (recorded_by like 'operator:%') <> by_hand
       -- Only the automatic path may say which keys QPay named; a hand entry never skips.
       and (by_hand or payment_key <> all(coalesce(p_reported_keys, '{}'::text[])));
    if other is not null then
      raise exception 'invoice % already holds QPay payment % recorded %; % may be the same money and is not recorded',
        inv.invoice_no, other, case when by_hand then 'automatically' else 'by hand' end, p_payment_key;
    end if;
  end if;
  perform set_config('billing.recording_payment', 'on', true);
  insert into billing_payments (invoice_id, payment_key, source, amount_mnt, paid_at, qpay_invoice_id, recorded_by, note)
  values (p_invoice, p_payment_key, p_source, p_amount, p_paid_at,
          case when p_source = 'qpay' then p_qpay_invoice_id end, p_recorded_by, p_note)
  on conflict (payment_key) do nothing;
  get diagnostics total = row_count;
  perform set_config('billing.recording_payment', 'off', true);
  inserted := total = 1;
  if not inserted and not exists (select 1 from billing_payments where payment_key = p_payment_key and invoice_id = p_invoice) then
    raise exception 'payment % is already recorded against a different invoice', p_payment_key;
  end if;

  select coalesce(sum(amount_mnt), 0), max(paid_at) into total, latest
    from billing_payments where invoice_id = p_invoice;
  next := case
            when inv.status = 'void' then 'void'
            when inv.resolved_by is not null then inv.status
            when total = inv.amount_mnt then 'paid'
            when total = 0 then 'open'
            else 'mismatch'
          end;
  update billing_invoices
     set paid_sum_mnt = total, status = next,
         paid_at = case when next = 'paid' then coalesce(paid_at, latest) else null end,
         updated_at = now()
   where id = p_invoice;
  if inserted then
    insert into billing_events (account_id, invoice_id, kind, detail)
    values (inv.account_id, p_invoice, 'payment.recorded',
            jsonb_build_object('payment_key', p_payment_key, 'amount_mnt', p_amount, 'by', p_recorded_by,
                               'status', next, 'paid_sum_mnt', total,
                               'second_payment', coalesce(p_second_payment, false)));
  end if;
  return jsonb_build_object('inserted', inserted, 'previous_status', inv.status, 'status', next,
                            'paid_sum_mnt', total, 'amount_mnt', inv.amount_mnt);
end
$$;

comment on function public.billing_record_payment(uuid, text, text, bigint, timestamptz, text, text, text, boolean, text[]) is
  'Record one payment and re-derive the invoice status. Idempotent on p_payment_key. Under the '
  'invoice lock, refuses a QPay payment under a new key when the other kind of recorder (hand '
  'vs automatic) already holds one on the invoice (and QPay''s answer, p_reported_keys, does not '
  'name it), unless p_second_payment. D-156, 0067.';

revoke all on function public.billing_record_payment(uuid, text, text, bigint, timestamptz, text, text, text, boolean, text[])
  from public, anon, authenticated;
grant execute on function public.billing_record_payment(uuid, text, text, bigint, timestamptz, text, text, text, boolean, text[])
  to service_role;

-- Only billing_record_payment writes a payment: its lock and its rule cannot be skipped by a
-- direct insert (service_role holds INSERT on the table through 0065's grant).
create function ops.billing_payments_via_function()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('billing.recording_payment', true) is distinct from 'on' then
    raise exception 'billing_payments is written only by billing_record_payment (its invoice lock and rules)';
  end if;
  return new;
end
$$;
revoke all on function ops.billing_payments_via_function() from public, anon, authenticated;

create trigger billing_payments_via_function
  before insert on billing_payments
  for each row execute function ops.billing_payments_via_function();
alter table billing_payments enable always trigger billing_payments_via_function;
