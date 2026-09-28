-- 0068 — a client can always pay, on time or late: every pay-page visit gets a QPay code
-- that is still alive (D-156 addendum, founder 2026-09-28).
--
-- A QPay Quick QR invoice ("code") lives five minutes; a bank refuses it after that
-- (QP2036 «Нэхэмжлэхийн хугацаа дууссан байна», seen on TEST-202609-0002). 0065 made ONE code
-- per invoice when the invoice was issued, so anyone paying more than five minutes after the
-- e-mail could not pay at all. Now the pay page makes a code when the client opens it, and a
-- new one when they ask; an invoice holds any number of codes, and a payment on ANY of them
-- (an older one included) belongs to that invoice.
--
-- What does not change: a payment is keyed by QPay's own payment id (`qpay:<id>`, unique), so
-- however many codes exist, each payment is recorded once; the invoice's status is still
-- derived from the sum; 0067's rules (hand vs automatic, the invoice lock, only the function
-- writes a payment) all stay.
--
--   billing_qpay_codes       every code ever shown for an invoice; never deleted, and its
--                            invoice and QPay id never change (a payment on it must always
--                            find its invoice).
--   billing_pay_code_slot    may a new code be made for this invoice now? (open, and under the
--                            hourly cap: a link hammered by a bot cannot mint codes forever)
--   billing_add_pay_code     records a code QPay made, under the invoice lock, BEFORE it is
--                            shown to anyone.
--   billing_record_payment   accepts a QPay payment whose QPay invoice is any code of this
--                            invoice (or the pre-0068 single code).
--
-- Backfill: every invoice's existing single code becomes a row here, so the codes already
-- sent in e-mails stay watched and payable-to-the-right-invoice. Apply it away from the
-- hourly run (the only caller of the old billing_set_qpay), then check that no invoice holds
-- a code without a row:
--   select invoice_no from billing_invoices i where qpay_invoice_id is not null
--      and not exists (select 1 from billing_qpay_codes c where c.qpay_invoice_id = i.qpay_invoice_id);

create table billing_qpay_codes (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references billing_invoices(id) on delete restrict,
  qpay_invoice_id  text not null unique check (btrim(qpay_invoice_id) <> ''),
  qr_text          text,
  qr_image         text,
  urls             jsonb not null default '[]'::jsonb check (jsonb_typeof(urls) = 'array'),
  created_at       timestamptz not null default now(),
  -- When a bank stops accepting it (QPay: five minutes). The page counts down to this.
  expires_at       timestamptz not null,
  -- 'page': made when the client opened the pay page; 'issue': the pre-0068 code made at issue.
  made_by          text not null check (made_by in ('page', 'issue')),
  -- The last QPay check that answered for this code.
  checked_at       timestamptz,
  -- Answered by QPay after it could no longer take money: final, no longer watched.
  closed_at        timestamptz,
  -- Withdrawn at QPay because the client asked for a new one (best effort; a payment made
  -- before the withdrawal still counts, which is why a withdrawn code is still watched).
  cancelled_at     timestamptz,
  -- Every payment key QPay has ever reported on this code. Kept after the code closes, so a
  -- payment recorded by hand that QPay once named is never taken for a conflict later (0067).
  reported_keys    text[] not null default '{}'::text[],
  constraint billing_qpay_code_expiry check (expires_at > created_at)
);
create index billing_qpay_codes_invoice on billing_qpay_codes (invoice_id, created_at desc);
create index billing_qpay_codes_watched on billing_qpay_codes (expires_at) where closed_at is null;

comment on table billing_qpay_codes is
  'Every QPay code (Quick QR invoice, five minutes) shown for a billing invoice. A payment on any '
  'of them belongs to that invoice. Never deleted; its invoice and QPay id never change. D-156, 0068.';

-- The identity of a code is fixed: only the check bookkeeping may change.
create function ops.billing_qpay_code_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'billing_qpay_codes rows are never deleted: a payment on the code must always find its invoice';
  end if;
  if new.invoice_id is distinct from old.invoice_id or new.qpay_invoice_id is distinct from old.qpay_invoice_id
     or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at
     or new.made_by is distinct from old.made_by then
    raise exception 'billing_qpay_codes: a code''s invoice, QPay id and lifetime never change';
  end if;
  return new;
end
$$;
revoke all on function ops.billing_qpay_code_guard() from public, anon, authenticated;
create trigger billing_qpay_codes_guard before update or delete on billing_qpay_codes
  for each row execute function ops.billing_qpay_code_guard();
alter table billing_qpay_codes enable always trigger billing_qpay_codes_guard;
create trigger billing_qpay_codes_no_truncate before truncate on billing_qpay_codes
  for each statement execute function ops.deny_truncate();
alter table billing_qpay_codes enable always trigger billing_qpay_codes_no_truncate;

alter table public.billing_qpay_codes enable row level security;
alter table public.billing_qpay_codes force row level security;
create policy billing_qpay_codes_no_client_insert on public.billing_qpay_codes as restrictive for insert to anon, authenticated with check (false);
create policy billing_qpay_codes_no_client_update on public.billing_qpay_codes as restrictive for update to anon, authenticated using (false) with check (false);
create policy billing_qpay_codes_no_client_delete on public.billing_qpay_codes as restrictive for delete to anon, authenticated using (false);
revoke all on public.billing_qpay_codes from anon, authenticated;
grant all on public.billing_qpay_codes to service_role;
revoke truncate on public.billing_qpay_codes from service_role;

insert into ops.table_security_class (table_schema, table_name, class, note)
values ('public', 'billing_qpay_codes', 'server_owned', 'every QPay code shown for a billing invoice; a payment on any of them is that invoice''s');

-- Backfill the pre-0068 single codes (made at issue). Their lifetime is QPay's five minutes
-- from when they were recorded.
insert into billing_qpay_codes (invoice_id, qpay_invoice_id, qr_text, qr_image, urls, created_at, expires_at, made_by, checked_at)
select i.id, i.qpay_invoice_id, i.qpay_qr_text, i.qpay_qr_image, i.qpay_urls,
       coalesce(e.at, i.created_at), coalesce(e.at, i.created_at) + interval '5 minutes', 'issue', i.qpay_checked_at
  from billing_invoices i
  left join lateral (select min(ev.at) as at from billing_events ev
                      where ev.invoice_id = i.id and ev.kind = 'qpay.created') e on true
 where i.qpay_invoice_id is not null;

-- The pre-0068 engine's issue-time code (billing_set_qpay) is recorded as a code too, so
-- between this migration and the new engine's deploy no code goes unwatched.
create or replace function public.billing_set_qpay(
  p_invoice uuid, p_qpay_invoice_id text, p_qr_text text, p_qr_image text, p_urls jsonb)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if coalesce(btrim(p_qpay_invoice_id), '') = '' then raise exception 'p_qpay_invoice_id is required'; end if;
  update billing_invoices
     set qpay_invoice_id = p_qpay_invoice_id, qpay_qr_text = p_qr_text, qpay_qr_image = p_qr_image,
         qpay_urls = coalesce(p_urls, '[]'::jsonb), qpay_last_error = null, updated_at = now()
   where id = p_invoice and qpay_invoice_id is null;
  get diagnostics n = row_count;
  if n = 1 then
    insert into billing_qpay_codes (invoice_id, qpay_invoice_id, qr_text, qr_image, urls, expires_at, made_by)
    values (p_invoice, p_qpay_invoice_id, p_qr_text, p_qr_image, coalesce(p_urls, '[]'::jsonb), now() + interval '5 minutes', 'issue');
    insert into billing_events (account_id, invoice_id, kind, detail)
    select account_id, id, 'qpay.created', jsonb_build_object('qpay_invoice_id', p_qpay_invoice_id)
      from billing_invoices where id = p_invoice;
  end if;
  return n = 1;
end
$$;

-- May a new code be made for this invoice now? Under the invoice lock. Returns the invoice
-- status when it is not open (the page then shows that instead), 'capped' past the hourly
-- cap, else 'ok'.
create function public.billing_pay_code_slot(p_invoice uuid, p_max_per_hour integer)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  inv billing_invoices%rowtype;
  n   integer;
begin
  select * into inv from billing_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'no invoice %', p_invoice; end if;
  if inv.status <> 'open' then return inv.status; end if;
  select count(*) into n from billing_qpay_codes
   where invoice_id = p_invoice and created_at > now() - interval '1 hour';
  if n >= p_max_per_hour then return 'capped'; end if;
  return 'ok';
end
$$;

-- Record a code QPay made, before it is shown. Always recorded (QPay made it; a payment on it
-- must find this invoice), and the invoice's status is returned so the caller shows it only
-- while the invoice is still open.
create function public.billing_add_pay_code(
  p_invoice uuid, p_qpay_invoice_id text, p_qr_text text, p_qr_image text, p_urls jsonb, p_expires_at timestamptz)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  inv billing_invoices%rowtype;
begin
  select * into inv from billing_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'no invoice %', p_invoice; end if;
  if coalesce(btrim(p_qpay_invoice_id), '') = '' then raise exception 'p_qpay_invoice_id is required'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    raise exception 'a QPay code lives minutes: expires_at % is not in the next ten minutes', p_expires_at;
  end if;
  insert into billing_qpay_codes (invoice_id, qpay_invoice_id, qr_text, qr_image, urls, expires_at, made_by)
  values (p_invoice, p_qpay_invoice_id, p_qr_text, p_qr_image, coalesce(p_urls, '[]'::jsonb), p_expires_at, 'page');
  insert into billing_events (account_id, invoice_id, kind, detail)
  values (inv.account_id, p_invoice, 'qpay.created',
          jsonb_build_object('qpay_invoice_id', p_qpay_invoice_id, 'made_by', 'page', 'expires_at', p_expires_at));
  return inv.status;
end
$$;

-- billing_record_payment, as 0067 left it, with one change: a QPay payment belongs to this
-- invoice when its QPay invoice is ANY code of this invoice.
create or replace function public.billing_record_payment(
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
  -- Every code, the pre-0068 single ones included (backfilled above, and written by
  -- billing_set_qpay from here on), is a row of billing_qpay_codes: that is the only test.
  if p_source = 'qpay' and (p_qpay_invoice_id is null or not exists (
       select 1 from billing_qpay_codes c where c.invoice_id = p_invoice and c.qpay_invoice_id = p_qpay_invoice_id)) then
    raise exception 'payment for QPay invoice % does not belong to invoice % (not one of its codes)',
      coalesce(p_qpay_invoice_id, 'none'), inv.invoice_no;
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
                               'status', next, 'paid_sum_mnt', total, 'qpay_invoice_id', p_qpay_invoice_id,
                               'second_payment', coalesce(p_second_payment, false)));
  end if;
  return jsonb_build_object('inserted', inserted, 'previous_status', inv.status, 'status', next,
                            'paid_sum_mnt', total, 'amount_mnt', inv.amount_mnt);
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'billing_pay_code_slot(uuid, integer)',
    'billing_add_pay_code(uuid, text, text, text, jsonb, timestamptz)',
    'billing_record_payment(uuid, text, text, bigint, timestamptz, text, text, text, boolean, text[])'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
