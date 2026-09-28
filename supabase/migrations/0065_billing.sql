-- Client billing: DalaTech invoices its own clients by QPay (founder, 2026-09-28, D-156).
--
-- DalaTech's clients pay into the SAME QPay merchant Core Language uses. The two businesses
-- stay separate in the records: Core Language's orders live in its own Supabase project and
-- this project never reads them; every invoice here carries a `DT-` number that its QPay
-- description repeats, and nothing in this file knows Core Language exists.
--
-- The four promises the founder asked for, and what keeps each one:
--
--   * An invoice is never created twice. `billing_invoices (account_id, period_key)` is
--     unique, and a schedule's `next_month` moves in the same statement that inserts the
--     invoice (`billing_issue_due`), under a row lock.
--   * A payment is never counted twice or given to the wrong invoice. `billing_payments`
--     is append-only and unique on `payment_key` (QPay's own payment id), and
--     `billing_record_payment` refuses a QPay payment whose QPay invoice is not the one this
--     invoice holds. The invoice's status is DERIVED from the payments it holds: exactly the
--     amount is `paid`, any other non-zero sum is `mismatch` and goes to the founder.
--   * A message is never sent twice and a failed one is retried. `billing_deliveries` is an
--     outbox unique on `dedup_key`; a row is claimed before it is sent, a definite failure
--     is retried with a backoff, and a send whose outcome is unknown (claimed, never
--     finished) becomes `unknown` for the founder rather than being sent again.
--   * Nothing is invoiced until the founder says so. A schedule is invoiced only while
--     `confirmed_at` is set, and any change to what it charges clears it (trigger below).
--     Live clients are reached only when the caller passes `p_include_live` (the worker
--     does so only under `BILLING_MODE=live`).
--
-- Additive: seven new tables and their fifteen functions. No existing row changes. The pause
-- functions WRITE `tenant_channels.delivery_mode` / `comment_delivery_mode`, but only when
-- the founder has tapped the pause question, and they keep the prior values to restore.

create sequence billing_invoice_no_seq;

-- ---------------------------------------------------------------------------
-- Accounts: one per client. Amounts live on the schedules.
-- ---------------------------------------------------------------------------
create table billing_accounts (
  id            uuid primary key default gen_random_uuid(),
  -- The client's tenant: whose AI staff a pause stops. Null only on a test account, which
  -- has no AI staff to stop. `restrict`: bookkeeping outlives a purged tenant.
  tenant_id     uuid references tenants(id) on delete restrict,
  -- The client's legal name as the contract writes it, shown on every invoice.
  display_name  text not null check (display_name is normalized and length(btrim(display_name)) > 0),
  contract_ref  text check (contract_ref is null or contract_ref is normalized),
  -- Where invoices, reminders and receipts go. Null: the founder forwards the link by hand.
  email         text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  is_test       boolean not null default false,
  status        text not null default 'active' check (status in ('active', 'ended')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint billing_account_real_has_tenant check (is_test or tenant_id is not null)
);
create unique index billing_accounts_one_per_tenant on billing_accounts (tenant_id) where tenant_id is not null;

comment on table billing_accounts is
  'One row per DalaTech client that is invoiced. Amounts are on billing_schedules. D-156.';

-- The tenant a pause acts on cannot be swapped under an open pause or an issued invoice.
create or replace function ops.billing_account_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.tenant_id is distinct from old.tenant_id and old.tenant_id is not null then
    raise exception 'billing_accounts.tenant_id is fixed once set (account %)', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.is_test is distinct from old.is_test then
    raise exception 'billing_accounts.is_test is fixed at creation (account %)', old.id
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger billing_accounts_guard before update on billing_accounts
  for each row execute function ops.billing_account_guard();

-- ---------------------------------------------------------------------------
-- Schedules: what recurs. A monthly fee, an annual prepay, a yearly hosting fee.
-- ---------------------------------------------------------------------------
create table billing_schedules (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references billing_accounts(id) on delete restrict,
  kind          text not null check (kind in ('monthly_fee', 'annual_prepay', 'hosting')),
  -- What the invoice says it covers: [{"label": text, "amount_mnt": integer}], summing to
  -- amount_mnt. A discount is a line with a negative amount.
  lines         jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) > 0),
  amount_mnt    bigint not null check (amount_mnt > 0 and amount_mnt < 100000000),
  every_months  integer not null check (every_months in (1, 12)),
  -- The first period NOT yet invoiced: always the 1st of a month.
  next_month    date not null check (extract(day from next_month) = 1),
  -- The day of the period's first month by which it is due (the contract says the 5th).
  due_day       integer not null default 5 check (due_day between 1 and 28),
  active        boolean not null default true,
  confirmed_at  timestamptz,
  confirmed_by  text,
  created_at    timestamptz not null default now(),
  constraint billing_schedule_kind_period check (
    (kind = 'monthly_fee' and every_months = 1) or (kind in ('annual_prepay', 'hosting') and every_months = 12)),
  constraint billing_schedule_confirmed_by check ((confirmed_at is null) = (confirmed_by is null))
);
create unique index billing_schedules_one_active_kind on billing_schedules (account_id, kind) where active;

comment on table billing_schedules is
  'What a client is invoiced for on a cycle. Invoiced only while confirmed_at is set; a change '
  'to lines, amount, period or due day clears it. D-156.';

-- Lines must add up, and a change to what is charged clears the founder's confirmation.
-- `next_month` moving is NOT a change to what is charged: the issuer moves it every period.
-- The one reader of a `lines` array: every line a non-empty NFC label and a whole-number
-- amount. Returns the sum, or raises. Used for schedules and one-off charges alike.
create or replace function ops.billing_lines_total(p_lines jsonb) returns bigint
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  total bigint;
  bad   integer;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines must be a non-empty array';
  end if;
  select count(*) filter (where jsonb_typeof(l) <> 'object'
                            or jsonb_typeof(l -> 'label') is distinct from 'string'
                            or length(btrim(l ->> 'label')) = 0
                            or not ((l ->> 'label') is normalized)
                            or jsonb_typeof(l -> 'amount_mnt') is distinct from 'number'
                            or (l ->> 'amount_mnt') !~ '^-?[0-9]+$'),
         coalesce(sum(case when (l ->> 'amount_mnt') ~ '^-?[0-9]+$' then (l ->> 'amount_mnt')::bigint end), 0)
    into bad, total
    from jsonb_array_elements(p_lines) l;
  if bad > 0 then
    raise exception 'lines: every line needs a non-empty NFC label and a whole-number amount_mnt';
  end if;
  return total;
end $$;

create or replace function ops.billing_schedule_guard() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
declare
  total bigint := ops.billing_lines_total(new.lines);
begin
  if total <> new.amount_mnt then
    raise exception 'billing_schedules: lines sum to % but amount_mnt is %', total, new.amount_mnt;
  end if;
  if tg_op = 'UPDATE' then
    if new.account_id is distinct from old.account_id or new.kind is distinct from old.kind then
      raise exception 'billing_schedules: account and kind are fixed; end this schedule and add another';
    end if;
    if (new.lines, new.amount_mnt, new.every_months, new.due_day)
       is distinct from (old.lines, old.amount_mnt, old.every_months, old.due_day)
       and new.confirmed_at is not distinct from old.confirmed_at then
      new.confirmed_at := null;
      new.confirmed_by := null;
    end if;
  end if;
  -- Annual prepay replaces the monthly fee: never both at once.
  if new.active and new.kind in ('monthly_fee', 'annual_prepay') and exists (
       select 1 from billing_schedules s
        where s.account_id = new.account_id and s.active and s.id <> new.id
          and s.kind in ('monthly_fee', 'annual_prepay') and s.kind <> new.kind) then
    raise exception 'billing_schedules: an account has a monthly fee or an annual prepay, never both';
  end if;
  return new;
end $$;
create trigger billing_schedules_guard before insert or update on billing_schedules
  for each row execute function ops.billing_schedule_guard();

-- ---------------------------------------------------------------------------
-- Invoices.
-- ---------------------------------------------------------------------------
create table billing_invoices (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references billing_accounts(id) on delete restrict,
  schedule_id      uuid references billing_schedules(id) on delete restrict,
  -- 'monthly_fee:2026-10', 'annual_prepay:2026-11', 'hosting:2027-03', 'one_off:<key>'.
  period_key       text not null check (period_key ~ '^(monthly_fee|annual_prepay|hosting):[0-9]{4}-[0-9]{2}$|^one_off:[a-z0-9][a-z0-9_-]{0,62}$'),
  invoice_no       text not null unique,
  kind             text not null check (kind in ('monthly_fee', 'annual_prepay', 'hosting', 'one_off')),
  lines            jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) > 0),
  amount_mnt       bigint not null check (amount_mnt > 0 and amount_mnt < 100000000),
  period_start     date,
  period_end       date,
  issued_on        date not null,
  due_on           date not null,
  is_test          boolean not null,
  -- open: waiting for money. paid: the payments sum to exactly amount_mnt. mismatch: they
  -- sum to anything else, for the founder. void: withdrawn by the founder.
  status           text not null default 'open' check (status in ('open', 'paid', 'mismatch', 'void')),
  paid_sum_mnt     bigint not null default 0 check (paid_sum_mnt >= 0),
  paid_at          timestamptz,
  -- Set only by the founder, on a mismatch they accepted (`billing_resolve`).
  resolved_by      text,
  resolved_note    text,
  -- The QPay invoice. Claimed before the call so two runs never both create one.
  qpay_invoice_id  text unique,
  qpay_qr_text     text,
  qpay_qr_image    text,
  qpay_urls        jsonb not null default '[]'::jsonb check (jsonb_typeof(qpay_urls) = 'array'),
  qpay_claimed_at  timestamptz,
  qpay_attempts    integer not null default 0,
  qpay_last_error  text,
  qpay_checked_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (account_id, period_key),
  constraint billing_invoice_due_after_issue check (due_on >= issued_on),
  constraint billing_invoice_period check ((period_start is null) = (period_end is null) and (period_end is null or period_end >= period_start)),
  constraint billing_invoice_paid_has_time check ((status = 'paid') = (paid_at is not null)),
  constraint billing_invoice_schedule_kind check ((kind = 'one_off') = (schedule_id is null)),
  constraint billing_invoice_resolution check ((resolved_by is null) or status in ('paid', 'void'))
);
create index billing_invoices_unsettled on billing_invoices (status) where status in ('open', 'mismatch');

comment on table billing_invoices is
  'One per client per period (or per one-off charge). Status is derived from billing_payments '
  'by billing_record_payment. D-156.';

-- ---------------------------------------------------------------------------
-- Payments: the evidence. Append-only.
-- ---------------------------------------------------------------------------
create table billing_payments (
  id               bigint generated always as identity primary key,
  invoice_id       uuid not null references billing_invoices(id) on delete restrict,
  -- 'qpay:<payment_id>', or 'bank:<reference>' for a transfer the founder records.
  payment_key      text not null unique check (payment_key ~ '^(qpay|qpay-invoice|bank):.+$'),
  source           text not null check (source in ('qpay', 'bank')),
  amount_mnt       bigint not null check (amount_mnt > 0),
  paid_at          timestamptz not null,
  qpay_invoice_id  text,
  recorded_by      text not null,
  note             text,
  created_at       timestamptz not null default now(),
  constraint billing_payment_qpay_has_invoice check ((source = 'qpay') = (qpay_invoice_id is not null))
);

comment on table billing_payments is
  'Every payment against an invoice, once, keyed by QPay''s own payment id. Append-only. D-156.';

-- ---------------------------------------------------------------------------
-- Outbox: every message to a client or to the founder.
-- ---------------------------------------------------------------------------
create table billing_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  dedup_key           text not null unique,
  account_id          uuid references billing_accounts(id) on delete restrict,
  invoice_id          uuid references billing_invoices(id) on delete restrict,
  is_test             boolean not null,
  kind                text not null check (kind in (
                        'invoice', 'reminder_before', 'reminder_after', 'receipt',
                        'founder_copy', 'founder_paid', 'founder_mismatch', 'founder_pause',
                        'founder_summary', 'founder_ledger', 'founder_problem')),
  channel             text not null check (channel in ('email', 'telegram')),
  recipient           text not null,
  subject             text,
  body                text not null check (length(body) > 0),
  button_url          text,
  button_label        text,
  attachment_name     text,
  attachment_body     text,
  -- A reminder is cancelled rather than sent once its invoice is no longer open.
  only_while_unpaid   boolean not null default false,
  status              text not null default 'pending'
                        check (status in ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
  attempts            integer not null default 0,
  next_attempt_at     timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  provider_message_id text,
  last_error          text,
  created_at          timestamptz not null default now(),
  constraint billing_delivery_sent_has_time check ((status = 'sent') = (sent_at is not null)),
  constraint billing_delivery_button check ((button_url is null) = (button_label is null)),
  constraint billing_delivery_attachment check ((attachment_name is null) = (attachment_body is null))
);
create index billing_deliveries_due on billing_deliveries (next_attempt_at) where status in ('pending', 'failed');
create index billing_deliveries_sending on billing_deliveries (claimed_at) where status = 'sending';

comment on table billing_deliveries is
  'Outbox for invoices, reminders, receipts and the founder''s billing messages. Unique per '
  'dedup_key; claimed before sending; an unfinished claim becomes unknown, never a resend. D-156.';

-- ---------------------------------------------------------------------------
-- Pauses: the founder stopped a client's AI staff for non-payment.
-- ---------------------------------------------------------------------------
create table billing_pauses (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references billing_accounts(id) on delete restrict,
  invoice_id  uuid references billing_invoices(id) on delete restrict,
  -- The channels as they were: [{"channel_id", "delivery_mode", "comment_delivery_mode"}].
  channels    jsonb not null check (jsonb_typeof(channels) = 'array'),
  paused_at   timestamptz not null default now(),
  paused_by   text not null,
  resumed_at  timestamptz,
  resumed_by  text,
  resume_report jsonb,
  constraint billing_pause_resumed check ((resumed_at is null) = (resumed_by is null))
);
create unique index billing_pauses_one_open on billing_pauses (account_id) where resumed_at is null;

-- ---------------------------------------------------------------------------
-- Events: the audit trail for bookkeeping. Append-only.
-- ---------------------------------------------------------------------------
create table billing_events (
  id          bigint generated always as identity primary key,
  account_id  uuid references billing_accounts(id) on delete restrict,
  invoice_id  uuid references billing_invoices(id) on delete restrict,
  kind        text not null,
  detail      jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index billing_events_invoice on billing_events (invoice_id, at);

-- ---------------------------------------------------------------------------
-- Security: server-owned, invisible to clients, the two evidence tables append-only.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['billing_accounts','billing_schedules','billing_invoices','billing_payments',
                           'billing_deliveries','billing_pauses','billing_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy %I on public.%I as restrictive for insert to anon, authenticated with check (false)', t || '_no_client_insert', t);
    execute format('create policy %I on public.%I as restrictive for update to anon, authenticated using (false) with check (false)', t || '_no_client_update', t);
    execute format('create policy %I on public.%I as restrictive for delete to anon, authenticated using (false)', t || '_no_client_delete', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  foreach t in array array['billing_payments','billing_events']
  loop
    execute format('create trigger %I before update or delete on public.%I for each statement execute function ops.deny_mutation()', t || '_append_only', t);
    execute format('alter table public.%I enable always trigger %I', t, t || '_append_only');
    execute format('create trigger %I before truncate on public.%I for each statement execute function ops.deny_truncate()', t || '_no_truncate', t);
    execute format('alter table public.%I enable always trigger %I', t, t || '_no_truncate');
    execute format('revoke truncate on public.%I from service_role', t);
  end loop;
end $$;
revoke all on sequence billing_invoice_no_seq from anon, authenticated;
grant usage on sequence billing_invoice_no_seq to service_role;

insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'billing_accounts', 'tenant_id');

insert into ops.table_security_class (table_schema, table_name, class, note)
values
  ('public', 'billing_accounts', 'server_owned', 'DalaTech''s clients as invoiced; never client-readable'),
  ('public', 'billing_schedules', 'server_owned', 'what each client is invoiced for'),
  ('public', 'billing_invoices', 'server_owned', 'invoices; status derived from billing_payments'),
  ('public', 'billing_payments', 'append_only', 'evidence: one row per QPay payment id'),
  ('public', 'billing_deliveries', 'server_owned', 'billing outbox'),
  ('public', 'billing_pauses', 'server_owned', 'founder pauses for non-payment, with the prior channel modes'),
  ('public', 'billing_events', 'append_only', 'billing audit trail');

-- ---------------------------------------------------------------------------
-- Functions. All in `public` (PostgREST serves only `public`, D-029), all SECURITY INVOKER
-- under service_role, EXECUTE revoked from everyone else at the end of the file.
-- ---------------------------------------------------------------------------

-- Issue this month's invoices. One per active, confirmed schedule whose `next_month` is the
-- month `p_today` falls in; the schedule moves on in the same transaction. A schedule behind
-- the current month is NOT caught up here — it is returned as `behind` for the founder,
-- because a burst of back invoices must be a decision, not a side effect.
create or replace function public.billing_issue_due(p_today date, p_include_live boolean)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  s        record;
  month0   date := date_trunc('month', p_today)::date;
  inv_id   uuid;
  due      date;
  issued   jsonb := '[]'::jsonb;
  behind   jsonb := '[]'::jsonb;
  prefix   text;
begin
  if p_today is null then raise exception 'p_today is required'; end if;
  for s in
    select sc.*, a.is_test
      from billing_schedules sc
      join billing_accounts a on a.id = sc.account_id
     where sc.active and sc.confirmed_at is not null and a.status = 'active'
       and (a.is_test or p_include_live)
       and sc.next_month <= month0
     order by sc.id
       for update of sc
  loop
    if s.next_month < month0 then
      behind := behind || jsonb_build_object('schedule_id', s.id, 'account_id', s.account_id,
                                             'kind', s.kind, 'next_month', s.next_month);
      continue;
    end if;
    due := greatest(make_date(extract(year from month0)::int, extract(month from month0)::int, s.due_day), p_today);
    prefix := case when s.is_test then 'TEST-' else 'DT-' end;
    insert into billing_invoices (account_id, schedule_id, period_key, invoice_no, kind, lines, amount_mnt,
                                  period_start, period_end, issued_on, due_on, is_test)
    values (s.account_id, s.id, s.kind || ':' || to_char(month0, 'YYYY-MM'),
            prefix || to_char(p_today, 'YYYYMM') || '-' || lpad(nextval('billing_invoice_no_seq')::text, 4, '0'),
            s.kind, s.lines, s.amount_mnt,
            month0, (month0 + make_interval(months => s.every_months) - interval '1 day')::date,
            p_today, due, s.is_test)
    on conflict (account_id, period_key) do nothing
    returning id into inv_id;
    update billing_schedules set next_month = (month0 + make_interval(months => s.every_months))::date
     where id = s.id;
    if inv_id is not null then
      issued := issued || to_jsonb(inv_id);
      insert into billing_events (account_id, invoice_id, kind, detail)
      values (s.account_id, inv_id, 'invoice.issued', jsonb_build_object('schedule_id', s.id, 'amount_mnt', s.amount_mnt));
    end if;
  end loop;
  return jsonb_build_object('issued', issued, 'behind', behind);
end
$$;

-- A one-off charge: a setup fee, a website half, a first month at 50%. The founder's
-- command is the confirmation; `p_key` makes a second run of the same command a no-op.
create or replace function public.billing_issue_one_off(
  p_account uuid, p_key text, p_lines jsonb, p_amount bigint, p_issued_on date, p_due_on date, p_by text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  a      billing_accounts%rowtype;
  total  bigint;
  inv    billing_invoices%rowtype;
begin
  select * into a from billing_accounts where id = p_account;
  if a.id is null then raise exception 'no billing account %', p_account; end if;
  if a.status <> 'active' then raise exception 'billing account % is %', p_account, a.status; end if;
  if coalesce(btrim(p_by), '') = '' then raise exception 'p_by (who ran this) is required'; end if;
  if p_key is null or p_key !~ '^[a-z0-9][a-z0-9_-]{0,62}$' then
    raise exception 'the key is lower-case letters, digits, - and _, e.g. setup-2026-10';
  end if;
  if p_due_on is null or p_issued_on is null or p_due_on < p_issued_on then
    raise exception 'issued and due dates are required, due on or after issue';
  end if;
  total := ops.billing_lines_total(p_lines);
  if total <> p_amount then raise exception 'lines sum to % but the amount is %', total, p_amount; end if;
  select * into inv from billing_invoices where account_id = p_account and period_key = 'one_off:' || p_key;
  if inv.id is not null then
    if inv.amount_mnt <> p_amount or inv.lines <> p_lines then
      raise exception 'one-off % already exists with different content (%); refusing to change an issued invoice', p_key, inv.invoice_no;
    end if;
    return jsonb_build_object('invoice_id', inv.id, 'invoice_no', inv.invoice_no, 'created', false);
  end if;
  insert into billing_invoices (account_id, schedule_id, period_key, invoice_no, kind, lines, amount_mnt,
                                issued_on, due_on, is_test)
  values (p_account, null, 'one_off:' || p_key,
          (case when a.is_test then 'TEST-' else 'DT-' end) || to_char(p_issued_on, 'YYYYMM') || '-'
            || lpad(nextval('billing_invoice_no_seq')::text, 4, '0'),
          'one_off', p_lines, p_amount, p_issued_on, p_due_on, a.is_test)
  returning * into inv;
  insert into billing_events (account_id, invoice_id, kind, detail)
  values (p_account, inv.id, 'invoice.issued', jsonb_build_object('one_off', p_key, 'amount_mnt', p_amount, 'by', p_by));
  return jsonb_build_object('invoice_id', inv.id, 'invoice_no', inv.invoice_no, 'created', true);
end
$$;

-- Confirm a schedule exactly as the founder read it. `p_expected` is the fingerprint the
-- confirming command printed (`billing_schedule_fingerprint`); a schedule changed since is refused.
create or replace function public.billing_schedule_fingerprint(p_schedule uuid)
returns text
language sql stable
set search_path = public, pg_temp
as $$
  select left(md5(concat_ws('|', s.id::text, s.kind, s.lines::text, s.amount_mnt::text, s.every_months::text,
                            s.next_month::text, s.due_day::text)), 12)
    from billing_schedules s where s.id = p_schedule
$$;

create or replace function public.billing_confirm_schedule(p_schedule uuid, p_expected text, p_by text)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if coalesce(btrim(p_by), '') = '' then raise exception 'p_by is required'; end if;
  if billing_schedule_fingerprint(p_schedule) is distinct from p_expected then
    raise exception 'schedule % changed since it was printed (or does not exist); read it again', p_schedule;
  end if;
  update billing_schedules set confirmed_at = now(), confirmed_by = p_by
   where id = p_schedule and confirmed_at is null;
  get diagnostics n = row_count;
  if n = 1 then
    insert into billing_events (account_id, kind, detail)
    select account_id, 'schedule.confirmed', jsonb_build_object('schedule_id', id, 'amount_mnt', amount_mnt, 'by', p_by)
      from billing_schedules where id = p_schedule;
  end if;
  return n = 1;
end
$$;

-- Claim the right to create this invoice's QPay invoice. Returns the attempt number, or
-- null when it already has one, is not open, or another run holds a fresh claim. A claim
-- older than `p_stale_after` is taken over: its QPay invoice, if QPay made one, was never
-- recorded and so was never shown to anybody — nobody holds its QR, so nobody can pay it.
create or replace function public.billing_claim_qpay(p_invoice uuid, p_stale_after interval)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update billing_invoices
     set qpay_claimed_at = now(), qpay_attempts = qpay_attempts + 1, updated_at = now()
   where id = p_invoice and qpay_invoice_id is null and status = 'open'
     and (qpay_claimed_at is null or qpay_claimed_at < now() - p_stale_after)
  returning qpay_attempts into n;
  return n;
end
$$;

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
    insert into billing_events (account_id, invoice_id, kind, detail)
    select account_id, id, 'qpay.created', jsonb_build_object('qpay_invoice_id', p_qpay_invoice_id)
      from billing_invoices where id = p_invoice;
  end if;
  return n = 1;
end
$$;

-- QPay answered with a definite refusal: release the claim so the next run tries again.
create or replace function public.billing_release_qpay(p_invoice uuid, p_error text)
returns void
language sql
set search_path = public, pg_temp
as $$
  update billing_invoices set qpay_claimed_at = null, qpay_last_error = left(p_error, 500), updated_at = now()
   where id = p_invoice and qpay_invoice_id is null
$$;

-- Record one payment and re-derive the invoice's status from every payment it holds.
-- Idempotent on `p_payment_key`. Refuses a QPay payment for a QPay invoice this invoice does
-- not hold, so a callback or a check can never credit the wrong client.
create or replace function public.billing_record_payment(
  p_invoice uuid, p_payment_key text, p_source text, p_amount bigint, p_paid_at timestamptz,
  p_qpay_invoice_id text, p_recorded_by text, p_note text)
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
begin
  select * into inv from billing_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'no invoice %', p_invoice; end if;
  if p_source = 'qpay' and (inv.qpay_invoice_id is null or inv.qpay_invoice_id <> p_qpay_invoice_id) then
    raise exception 'payment for QPay invoice % does not belong to invoice % (holds %)',
      p_qpay_invoice_id, inv.invoice_no, coalesce(inv.qpay_invoice_id, 'none');
  end if;
  insert into billing_payments (invoice_id, payment_key, source, amount_mnt, paid_at, qpay_invoice_id, recorded_by, note)
  values (p_invoice, p_payment_key, p_source, p_amount, p_paid_at,
          case when p_source = 'qpay' then p_qpay_invoice_id end, p_recorded_by, p_note)
  on conflict (payment_key) do nothing;
  get diagnostics total = row_count;
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
                               'status', next, 'paid_sum_mnt', total));
  end if;
  return jsonb_build_object('inserted', inserted, 'previous_status', inv.status, 'status', next,
                            'paid_sum_mnt', total, 'amount_mnt', inv.amount_mnt);
end
$$;

-- The founder settles a mismatch or withdraws an invoice. Only a person does this.
create or replace function public.billing_resolve(p_invoice uuid, p_outcome text, p_by text, p_note text)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  inv billing_invoices%rowtype;
begin
  if p_outcome not in ('paid', 'void') then raise exception 'outcome is paid or void'; end if;
  if coalesce(btrim(p_by), '') = '' or coalesce(btrim(p_note), '') = '' then
    raise exception 'who and why are both required';
  end if;
  select * into inv from billing_invoices where id = p_invoice for update;
  if inv.id is null then raise exception 'no invoice %', p_invoice; end if;
  if p_outcome = 'paid' and inv.status <> 'mismatch' then
    raise exception 'only a mismatch is accepted as paid by hand (invoice % is %)', inv.invoice_no, inv.status;
  end if;
  if p_outcome = 'void' and inv.status not in ('open', 'mismatch') then
    raise exception 'invoice % is % and cannot be withdrawn', inv.invoice_no, inv.status;
  end if;
  update billing_invoices
     set status = p_outcome, resolved_by = p_by, resolved_note = p_note,
         paid_at = case when p_outcome = 'paid' then now() else null end, updated_at = now()
   where id = p_invoice;
  insert into billing_events (account_id, invoice_id, kind, detail)
  values (inv.account_id, p_invoice, 'invoice.resolved',
          jsonb_build_object('outcome', p_outcome, 'by', p_by, 'note', p_note, 'paid_sum_mnt', inv.paid_sum_mnt));
  return p_outcome;
end
$$;

-- Claim up to `p_limit` messages that are due. First cancels reminders whose invoice is no
-- longer unpaid, so a paid client is never reminded. SKIP LOCKED: two runs share the work.
create or replace function public.billing_claim_deliveries(p_limit integer, p_include_live boolean)
returns setof billing_deliveries
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update billing_deliveries d
     set status = 'cancelled', last_error = 'invoice no longer unpaid'
    from billing_invoices i
   where d.invoice_id = i.id and d.only_while_unpaid and d.status in ('pending', 'failed')
     and i.status not in ('open', 'mismatch');
  return query
  update billing_deliveries d
     set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
   where d.id in (
     select x.id from billing_deliveries x
      where x.status in ('pending', 'failed') and x.next_attempt_at <= now()
        and (x.is_test or p_include_live)
      order by x.created_at
      limit p_limit
        for update skip locked)
  returning d.*;
end
$$;

-- Finish a claimed message. `p_retry_at` null on a failure means give up (terminal).
create or replace function public.billing_finish_delivery(
  p_id uuid, p_ok boolean, p_provider_message_id text, p_error text, p_retry_at timestamptz)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update billing_deliveries
     set status = case when p_ok then 'sent' else 'failed' end,
         sent_at = case when p_ok then now() end,
         provider_message_id = case when p_ok then p_provider_message_id else provider_message_id end,
         last_error = case when p_ok then null else left(p_error, 500) end,
         -- A terminal failure parks the row far in the future: it stays visible, never retried.
         next_attempt_at = case when p_ok then next_attempt_at when p_retry_at is null then 'infinity' else p_retry_at end
   where id = p_id and status = 'sending';
  get diagnostics n = row_count;
  return n = 1;
end
$$;

-- A claim that never finished: the process died between claiming and recording the result,
-- so the message may or may not have gone out. Never resent automatically; the founder is told.
create or replace function public.billing_sweep_unfinished(p_older_than interval)
returns setof billing_deliveries
language sql
set search_path = public, pg_temp
as $$
  update billing_deliveries
     set status = 'unknown', last_error = 'claimed at ' || claimed_at::text || ' and never finished'
   where status = 'sending' and claimed_at < now() - p_older_than
  returning *
$$;

-- The founder sends a message again: one that failed for good, or one whose send never
-- finished and did not arrive. Only a person does this; nothing automatic resends.
create or replace function public.billing_requeue_delivery(p_id uuid, p_by text)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if coalesce(btrim(p_by), '') = '' then raise exception 'p_by is required'; end if;
  update billing_deliveries
     set status = 'pending', next_attempt_at = now(), claimed_at = null,
         last_error = 'requeued by ' || p_by || coalesce(' after: ' || last_error, '')
   where id = p_id and status in ('failed', 'unknown');
  get diagnostics n = row_count;
  if n = 1 then
    insert into billing_events (account_id, invoice_id, kind, detail)
    select account_id, invoice_id, 'delivery.requeued', jsonb_build_object('delivery_id', id, 'kind', kind, 'by', p_by)
      from billing_deliveries where id = p_id;
  end if;
  return n = 1;
end
$$;

-- Pause a client's AI staff: every channel of the tenant to `off`, the prior modes kept.
-- Only ever called from the founder's confirmed tap (`/billing/action`) or command.
create or replace function public.billing_pause(p_account uuid, p_invoice uuid, p_by text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  a      billing_accounts%rowtype;
  snap   jsonb;
  pid    uuid;
begin
  if coalesce(btrim(p_by), '') = '' then raise exception 'p_by is required'; end if;
  select * into a from billing_accounts where id = p_account for update;
  if a.id is null then raise exception 'no billing account %', p_account; end if;
  select id into pid from billing_pauses where account_id = p_account and resumed_at is null;
  if pid is not null then return jsonb_build_object('pause_id', pid, 'already_paused', true, 'channels', 0); end if;
  perform 1 from tenant_channels c where a.tenant_id is not null and c.tenant_id = a.tenant_id for update;
  select coalesce(jsonb_agg(jsonb_build_object('channel_id', c.id, 'delivery_mode', c.delivery_mode,
                                               'comment_delivery_mode', c.comment_delivery_mode) order by c.id), '[]'::jsonb)
    into snap
    from tenant_channels c where a.tenant_id is not null and c.tenant_id = a.tenant_id;
  update tenant_channels set delivery_mode = 'off', comment_delivery_mode = 'off'
   where a.tenant_id is not null and tenant_id = a.tenant_id;
  insert into billing_pauses (account_id, invoice_id, channels, paused_by)
  values (p_account, p_invoice, snap, p_by) returning id into pid;
  insert into billing_events (account_id, invoice_id, kind, detail)
  values (p_account, p_invoice, 'client.paused', jsonb_build_object('by', p_by, 'channels', snap));
  return jsonb_build_object('pause_id', pid, 'already_paused', false, 'channels', jsonb_array_length(snap));
end
$$;

-- Resume: each channel back to the mode it had, but only where it is still `off` (somebody
-- may have changed it since). A channel the schema refuses to put back — a token revoked
-- while paused cannot be `live` — is left `off` and named in the report.
create or replace function public.billing_resume(p_account uuid, p_by text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  p        billing_pauses%rowtype;
  a        billing_accounts%rowtype;
  ch       jsonb;
  restored jsonb := '[]'::jsonb;
  skipped  jsonb := '[]'::jsonb;
  n        integer;
begin
  if coalesce(btrim(p_by), '') = '' then raise exception 'p_by is required'; end if;
  select * into a from billing_accounts where id = p_account for update;
  select * into p from billing_pauses where account_id = p_account and resumed_at is null for update;
  if p.id is null then return jsonb_build_object('resumed', false, 'reason', 'not_paused'); end if;
  for ch in select * from jsonb_array_elements(p.channels)
  loop
    begin
      update tenant_channels
         set delivery_mode = ch ->> 'delivery_mode', comment_delivery_mode = ch ->> 'comment_delivery_mode'
       where id = (ch ->> 'channel_id')::uuid and tenant_id = a.tenant_id
         and delivery_mode = 'off' and comment_delivery_mode = 'off';
      get diagnostics n = row_count;
      if n = 1 then restored := restored || ch;
      else skipped := skipped || (ch || jsonb_build_object('why', 'changed while paused'));
      end if;
    exception when check_violation then
      skipped := skipped || (ch || jsonb_build_object('why', sqlerrm));
    end;
  end loop;
  update billing_pauses
     set resumed_at = now(), resumed_by = p_by,
         resume_report = jsonb_build_object('restored', restored, 'skipped', skipped)
   where id = p.id;
  insert into billing_events (account_id, invoice_id, kind, detail)
  values (p_account, p.invoice_id, 'client.resumed', jsonb_build_object('by', p_by, 'restored', restored, 'skipped', skipped));
  return jsonb_build_object('resumed', true, 'restored', jsonb_array_length(restored), 'skipped', skipped);
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'billing_issue_due(date, boolean)',
    'billing_issue_one_off(uuid, text, jsonb, bigint, date, date, text)',
    'billing_schedule_fingerprint(uuid)',
    'billing_confirm_schedule(uuid, text, text)',
    'billing_claim_qpay(uuid, interval)',
    'billing_set_qpay(uuid, text, text, text, jsonb)',
    'billing_release_qpay(uuid, text)',
    'billing_record_payment(uuid, text, text, bigint, timestamptz, text, text, text)',
    'billing_resolve(uuid, text, text, text)',
    'billing_claim_deliveries(integer, boolean)',
    'billing_finish_delivery(uuid, boolean, text, text, timestamptz)',
    'billing_sweep_unfinished(interval)',
    'billing_requeue_delivery(uuid, text)',
    'billing_pause(uuid, uuid, text)',
    'billing_resume(uuid, text)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
revoke all on function ops.billing_account_guard() from public, anon, authenticated;
revoke all on function ops.billing_schedule_guard() from public, anon, authenticated;
revoke all on function ops.billing_lines_total(jsonb) from public, anon, authenticated;
grant execute on function ops.billing_lines_total(jsonb) to service_role;
