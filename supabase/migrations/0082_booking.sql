-- Booking and paying the deposit inside Messenger (design: docs/proposals/tara-inchat-booking.md).
--
-- OFF for every tenant: no `booking_config` row exists, and a row defaults to mode 'off'. The
-- environment switch `BOOKING_MODE` must also be set before any code path reads these tables
-- for a customer.
--
-- The four promises, and what keeps each one:
--
--   * Nothing is confirmed before the payment is confirmed. A hold becomes `booked` only from
--     `paid` (`booking_mark_booked`), and `paid` is reachable only through
--     `booking_record_payment`, which the code calls with what QPay's own payment check said.
--   * A slot is never held twice. `booking_acquire_hold` and the late branch of
--     `booking_record_payment` take a transaction-scoped advisory lock on the calendar, then
--     look for an overlapping active hold, then write. A unique index on (calendar, start) over
--     active holds is the second wall.
--   * A payment is recorded once. `booking_payments` is append-only and unique on QPay's
--     payment id; a second payment on a hold that already has one is `excess`, never a second
--     booking.
--   * A paid hold that cannot be booked is never silent: it ends `paid_unbooked`, which the
--     code pages at once, and which only a person closes.
--
-- Additive: six new tables and their functions. No existing row or table changes.

-- ---------------------------------------------------------------------------
-- Per-tenant configuration. One row per tenant; absent = off.
-- ---------------------------------------------------------------------------
create table booking_config (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  -- off: nothing. test: only the listed testers, 100₮, «ТЕСТ». live: every customer.
  mode        text not null default 'off' check (mode in ('off', 'test', 'live')),
  -- Validated by `src/lib/booking/config.ts`; a row that does not validate is OFF.
  config      jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_at  timestamptz not null default now(),
  updated_by  text
);
comment on table booking_config is
  'In-chat booking and QPay deposit, per tenant. Absent or mode off: nothing runs. Design: docs/proposals/tara-inchat-booking.md.';

-- ---------------------------------------------------------------------------
-- One booking conversation: what the customer has chosen so far.
-- ---------------------------------------------------------------------------
create table booking_sessions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  conversation_id  uuid not null,
  channel_id       uuid not null,
  psid             text not null check (length(psid) > 0),
  is_test          boolean not null,
  step             text not null check (length(step) > 0),
  data             jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  version          integer not null default 0,
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz,
  close_reason     text,
  -- The one «Цаг захиалах уу?» after the customer went quiet on the offered times.
  followed_up_at   timestamptz,
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, channel_id) references tenant_channels (tenant_id, id) on delete cascade,
  constraint booking_session_closed_has_reason check ((closed_at is null) = (close_reason is null))
);
create unique index booking_sessions_one_open on booking_sessions (tenant_id, conversation_id) where closed_at is null;
create unique index booking_sessions_tenant_id on booking_sessions (tenant_id, id);

-- ---------------------------------------------------------------------------
-- A held time. Active while held, paid or booked.
-- ---------------------------------------------------------------------------
create table booking_holds (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  session_id       uuid not null,
  conversation_id  uuid,
  channel_id       uuid not null,
  psid             text not null,
  is_test          boolean not null,
  calendar_id      text not null check (length(calendar_id) > 0),
  staff_name       text not null,
  level            text not null,
  service          text not null,
  minutes          integer not null check (minutes > 0 and minutes <= 720),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  deposit_mnt      integer not null check (deposit_mnt > 0),
  customer_name    text not null check (customer_name is normalized and length(btrim(customer_name)) > 0),
  customer_phone   text not null check (customer_phone ~ '^[0-9]{8}$'),
  -- Null when the tenant has no gender rule: never recorded as a guess.
  gender           text check (gender in ('female', 'male')),
  -- When and what the customer accepted with «Зөвшөөрч, захиалах»: the summary exactly as shown
  -- (service, stylist, day, time, deposit). Дали states no deposit terms in chat (founder, 2026-10-03).
  agreed_at        timestamptz not null,
  agreement_text   text not null check (agreement_text is normalized and length(btrim(agreement_text)) > 0),
  state            text not null default 'held'
                     check (state in ('held', 'paid', 'booked', 'expired', 'released', 'paid_unbooked')),
  expires_at       timestamptz not null,
  -- Our event in the stylist's calendar: a busy hold, then the booking itself.
  calendar_event_id text,
  calendar_state   text not null default 'none' check (calendar_state in ('none', 'held', 'booked', 'deleted')),
  paid_at          timestamptz,
  booked_at        timestamptz,
  ended_at         timestamptz,
  ended_reason     text,
  -- A late payment that re-took the slot. Shown in the confirmation's alert trail only.
  late             boolean not null default false,
  -- When QPay was last asked about this hold: the pay page's poll asks at most every few seconds.
  last_checked_at  timestamptz,
  -- Set once the customer (and, for paid_unbooked, the founder) has been told the outcome.
  -- A booked or paid_unbooked hold without it is swept until it is told.
  notified_at      timestamptz,
  -- A paid deposit whose time was taken, moved by the customer to another free time
  -- (`booking_rebook_hold`): the same money, one booking.
  rebooked_at      timestamptz,
  version          integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, session_id) references booking_sessions (tenant_id, id) on delete cascade,
  constraint booking_hold_window check (ends_at > starts_at),
  constraint booking_hold_booked_was_paid check (state <> 'booked' or (paid_at is not null and booked_at is not null)),
  constraint booking_hold_paid_has_time check (state not in ('paid', 'paid_unbooked') or paid_at is not null)
);
-- The second wall: one active hold per calendar and start, whatever wrote it.
create unique index booking_holds_active_start on booking_holds (calendar_id, starts_at)
  where state in ('held', 'paid', 'booked');
-- One held time per customer: a new QR replaces the customer's old hold (booking_acquire_hold
-- reports it, the platform releases it, then holds the new time).
create unique index booking_holds_one_held_per_customer on booking_holds (tenant_id, psid) where state = 'held';
create index booking_holds_calendar_window on booking_holds (calendar_id, starts_at, ends_at)
  where state in ('held', 'paid', 'booked');
create index booking_holds_due on booking_holds (expires_at) where state in ('held', 'paid');
create index booking_holds_untold on booking_holds (updated_at) where state in ('booked', 'paid_unbooked') and notified_at is null;
create unique index booking_holds_tenant_id on booking_holds (tenant_id, id);

-- ---------------------------------------------------------------------------
-- QPay invoices made for a hold. Claimed before QPay is asked, as billing does: a create whose
-- outcome is unknown is never shown, so nobody can pay it.
-- ---------------------------------------------------------------------------
create table booking_invoices (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  hold_id          uuid not null,
  amount_mnt       integer not null check (amount_mnt > 0),
  -- Whose money, as the invoice was made (the merchant it was invoiced under and the account it
  -- pays into), whatever the tenant's row says later. Every invoice is on the platform's login.
  merchant_id      text not null check (length(merchant_id) > 0),
  payout_account   text not null check (length(payout_account) > 0),
  state            text not null default 'creating' check (state in ('creating', 'open', 'unknown', 'refused', 'cancelled', 'paid')),
  qpay_invoice_id  text unique,
  qr_text          text,
  qr_image         text,
  urls             jsonb,
  qr_expires_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, hold_id) references booking_holds (tenant_id, id) on delete cascade,
  constraint booking_invoice_open_has_id check (state not in ('open', 'cancelled', 'paid') or qpay_invoice_id is not null)
);
create index booking_invoices_hold on booking_invoices (hold_id, created_at);
create unique index booking_invoices_tenant_id on booking_invoices (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Evidence: one row per QPay payment id. Append-only.
-- ---------------------------------------------------------------------------
create table booking_payments (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references tenants(id) on delete restrict,
  hold_id          uuid not null,
  invoice_id       uuid not null,
  payment_key      text not null unique check (payment_key ~ '^qpay:.+'),
  amount_mnt       bigint not null check (amount_mnt > 0),
  paid_at          timestamptz not null,
  -- applied: this payment paid the hold. excess: the hold already had one (refund).
  -- short: less than the deposit (refund or settle by hand). late: arrived after the hold
  -- ended; `late_booked` re-took the slot, `late_unbooked` could not.
  disposition      text not null check (disposition in ('applied', 'excess', 'short', 'late_booked', 'late_unbooked')),
  recorded_at      timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references booking_invoices (tenant_id, id) on delete restrict
);
create index booking_payments_hold on booking_payments (hold_id);

-- ---------------------------------------------------------------------------
-- Audit trail. Append-only.
-- ---------------------------------------------------------------------------
create table booking_events (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references tenants(id) on delete restrict,
  hold_id    uuid,
  session_id uuid,
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index booking_events_hold on booking_events (hold_id, at);

-- ---------------------------------------------------------------------------
-- Security: server-owned, invisible to clients, the two evidence tables append-only.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['booking_config','booking_sessions','booking_holds','booking_invoices',
                           'booking_payments','booking_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy %I on public.%I as restrictive for insert to anon, authenticated with check (false)', t || '_no_client_insert', t);
    execute format('create policy %I on public.%I as restrictive for update to anon, authenticated using (false) with check (false)', t || '_no_client_update', t);
    execute format('create policy %I on public.%I as restrictive for delete to anon, authenticated using (false)', t || '_no_client_delete', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  foreach t in array array['booking_payments','booking_events']
  loop
    execute format('create trigger %I before update or delete on public.%I for each statement execute function ops.deny_mutation()', t || '_append_only', t);
    execute format('alter table public.%I enable always trigger %I', t, t || '_append_only');
    execute format('create trigger %I before truncate on public.%I for each statement execute function ops.deny_truncate()', t || '_no_truncate', t);
    execute format('alter table public.%I enable always trigger %I', t, t || '_no_truncate');
    execute format('revoke truncate on public.%I from service_role', t);
  end loop;
end $$;

insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'booking_config', 'tenant_id'),
       ('public', 'booking_sessions', 'tenant_id'),
       ('public', 'booking_holds', 'tenant_id'),
       ('public', 'booking_invoices', 'tenant_id'),
       ('public', 'booking_payments', 'tenant_id'),
       ('public', 'booking_events', 'tenant_id');

insert into ops.table_security_class (table_schema, table_name, class, note)
values
  ('public', 'booking_config', 'server_owned', 'in-chat booking switch and rules per tenant; off by default'),
  ('public', 'booking_sessions', 'server_owned', 'what a customer has chosen so far in a booking chat'),
  ('public', 'booking_holds', 'server_owned', 'a held, paid or booked time; one active per calendar and start'),
  ('public', 'booking_invoices', 'server_owned', 'QPay deposit invoices per hold'),
  ('public', 'booking_payments', 'append_only', 'evidence: one row per QPay payment id'),
  ('public', 'booking_events', 'append_only', 'booking audit trail');

-- ---------------------------------------------------------------------------
-- Functions. All in `public` (PostgREST serves only `public`, D-029), SECURITY INVOKER under
-- service_role, EXECUTE revoked from everyone else at the end of the file.
-- ---------------------------------------------------------------------------

-- The open session of a conversation, or a new one. Never two open at once (unique index).
create or replace function public.booking_open_session(
  p_tenant uuid, p_conversation uuid, p_channel uuid, p_psid text, p_is_test boolean,
  p_step text, p_data jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare s booking_sessions%rowtype;
begin
  insert into booking_sessions (tenant_id, conversation_id, channel_id, psid, is_test, step, data)
  values (p_tenant, p_conversation, p_channel, p_psid, p_is_test, p_step, coalesce(p_data, '{}'::jsonb))
  on conflict (tenant_id, conversation_id) where closed_at is null do nothing
  returning * into s;
  if s.id is null then
    select * into s from booking_sessions
     where tenant_id = p_tenant and conversation_id = p_conversation and closed_at is null;
    return jsonb_build_object('created', false, 'session', to_jsonb(s));
  end if;
  insert into booking_events (tenant_id, session_id, kind, detail)
  values (p_tenant, s.id, 'session.opened', jsonb_build_object('step', p_step, 'is_test', p_is_test));
  return jsonb_build_object('created', true, 'session', to_jsonb(s));
end
$$;

-- One customer message, answered: the session moves on AND the reply is drafted, in one
-- transaction, so a crash can never leave the session ahead of an answer nobody stored.
--
--   drafted: both happened.
--   exists:  this message already has a reply (a redelivery); nothing changed.
--   stale:   the session moved since it was read (another message won); nothing changed.
create or replace function public.booking_apply_turn(
  p_tenant uuid, p_session uuid, p_version integer, p_dedup_key text,
  p_step text, p_data jsonb, p_close_reason text, p_body text, p_channel uuid, p_conversation uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  existing outbound_messages%rowtype;
  new_id   uuid;
  n        integer;
begin
  if p_dedup_key is null or p_dedup_key = '' then raise exception 'a booking reply needs a dedup key'; end if;
  select * into existing from outbound_messages
   where tenant_id = p_tenant and kind = 'reply' and dedup_key = p_dedup_key;
  if existing.id is not null then
    return jsonb_build_object('outcome', 'exists', 'outbound_id', existing.id, 'state', existing.state);
  end if;

  update booking_sessions
     set step = p_step, data = coalesce(p_data, data), version = version + 1, updated_at = now(),
         closed_at = case when p_close_reason is null then null else now() end,
         close_reason = p_close_reason
   where id = p_session and tenant_id = p_tenant and version = p_version and closed_at is null;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('outcome', 'stale');
  end if;

  if p_body is not null and btrim(p_body) <> '' then
    insert into outbound_messages (tenant_id, channel_id, conversation_id, kind, body, dedup_key, state)
    values (p_tenant, p_channel, p_conversation, 'reply', p_body, p_dedup_key, 'draft')
    returning id into new_id;
  end if;
  return jsonb_build_object('outcome', 'drafted', 'outbound_id', new_id, 'version', p_version + 1);
end
$$;

-- Hold a time. Serialised per calendar; refuses an overlap with any active hold.
create or replace function public.booking_acquire_hold(p_tenant uuid, p_session uuid, p_hold jsonb, p_expires_at timestamptz)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cal   text := p_hold->>'calendar_id';
  s_at  timestamptz := (p_hold->>'starts_at')::timestamptz;
  e_at  timestamptz := (p_hold->>'ends_at')::timestamptz;
  clash uuid;
  h     booking_holds%rowtype;
  sess  booking_sessions%rowtype;
begin
  select * into sess from booking_sessions where id = p_session and tenant_id = p_tenant for update;
  if sess.id is null or sess.closed_at is not null then
    return jsonb_build_object('outcome', 'no_session');
  end if;
  -- One live hold per session: a redelivered message picks its own hold up again.
  if exists (select 1 from booking_holds where session_id = p_session and state = 'held') then
    return jsonb_build_object('outcome', 'session_has_hold',
      'hold_id', (select id from booking_holds where session_id = p_session and state = 'held' limit 1));
  end if;
  -- One live hold per customer: a hold from their earlier booking chat is replaced, never kept
  -- beside the new one. The platform releases it (QPay asked first) and asks again.
  if exists (select 1 from booking_holds where tenant_id = p_tenant and psid = sess.psid and state = 'held') then
    return jsonb_build_object('outcome', 'customer_has_hold',
      'hold_id', (select id from booking_holds where tenant_id = p_tenant and psid = sess.psid and state = 'held' limit 1));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('booking:' || cal, 0));
  select id into clash from booking_holds
   where calendar_id = cal and state in ('held', 'paid', 'booked')
     and tstzrange(starts_at, ends_at, '[)') && tstzrange(s_at, e_at, '[)')
   limit 1;
  if clash is not null then
    return jsonb_build_object('outcome', 'taken');
  end if;

  insert into booking_holds (tenant_id, session_id, conversation_id, channel_id, psid, is_test, calendar_id,
                             staff_name, level, service, minutes, starts_at, ends_at, deposit_mnt,
                             customer_name, customer_phone, gender, agreed_at, agreement_text, expires_at)
  values (p_tenant, p_session, sess.conversation_id, sess.channel_id, sess.psid, sess.is_test, cal,
          p_hold->>'staff_name', p_hold->>'level', p_hold->>'service', (p_hold->>'minutes')::integer,
          s_at, e_at, (p_hold->>'deposit_mnt')::integer,
          p_hold->>'customer_name', p_hold->>'customer_phone', p_hold->>'gender',
          (p_hold->>'agreed_at')::timestamptz, p_hold->>'agreement_text', p_expires_at)
  returning * into h;
  insert into booking_events (tenant_id, hold_id, session_id, kind, detail)
  values (p_tenant, h.id, p_session, 'hold.acquired',
          jsonb_build_object('calendar_id', cal, 'starts_at', s_at, 'ends_at', e_at, 'deposit_mnt', h.deposit_mnt));
  return jsonb_build_object('outcome', 'held', 'hold', to_jsonb(h));
end
$$;

-- End a hold that was never paid. `expired` only once its time is up; `released` at any time
-- (the chat lost a race to the website, or the hold could not be completed). Refuses a hold
-- that a payment paid: money is never released by a timer. A SHORT payment did not pay it (it
-- was paged for a refund when recorded), so it does not keep the time held for ever.
create or replace function public.booking_end_hold(p_hold uuid, p_reason text, p_kind text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare h booking_holds%rowtype;
begin
  if p_kind not in ('expired', 'released') then raise exception 'bad end kind %', p_kind; end if;
  select * into h from booking_holds where id = p_hold for update;
  if h.id is null then raise exception 'no hold %', p_hold; end if;
  if h.state <> 'held' then
    return jsonb_build_object('outcome', 'not_held', 'state', h.state);
  end if;
  if exists (select 1 from booking_payments where hold_id = p_hold
               and disposition in ('applied', 'late_booked', 'late_unbooked')) then
    return jsonb_build_object('outcome', 'has_payment', 'state', h.state);
  end if;
  if p_kind = 'expired' and now() < h.expires_at then
    return jsonb_build_object('outcome', 'not_due', 'state', h.state);
  end if;
  update booking_holds
     set state = p_kind, ended_at = now(), ended_reason = p_reason, version = version + 1, updated_at = now()
   where id = p_hold;
  insert into booking_events (tenant_id, hold_id, session_id, kind, detail)
  values (h.tenant_id, h.id, h.session_id, 'hold.' || p_kind, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('outcome', p_kind, 'state', p_kind);
end
$$;

-- A QPay payment, as QPay's own check reported it. Decides what the money does, once.
create or replace function public.booking_record_payment(
  p_hold uuid, p_invoice uuid, p_payment_key text, p_amount bigint, p_paid_at timestamptz, p_qpay_invoice_id text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  h        booking_holds%rowtype;
  inv      booking_invoices%rowtype;
  prior    booking_payments%rowtype;
  applied  boolean;
  clash    uuid;
  disp     text;
  next     text;
begin
  select * into h from booking_holds where id = p_hold for update;
  if h.id is null then raise exception 'no hold %', p_hold; end if;
  select * into inv from booking_invoices where id = p_invoice;
  if inv.id is null or inv.hold_id <> p_hold then
    raise exception 'invoice % is not an invoice of hold %', p_invoice, p_hold;
  end if;
  if inv.qpay_invoice_id is null or inv.qpay_invoice_id <> p_qpay_invoice_id then
    raise exception 'payment for QPay invoice % does not belong to invoice % (holds %)',
      p_qpay_invoice_id, p_invoice, coalesce(inv.qpay_invoice_id, 'none');
  end if;

  select * into prior from booking_payments where payment_key = p_payment_key;
  if prior.id is not null then
    if prior.hold_id <> p_hold then
      raise exception 'payment % is already recorded against another hold', p_payment_key;
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'disposition', prior.disposition, 'state', h.state);
  end if;

  applied := exists (select 1 from booking_payments where hold_id = p_hold
                       and disposition in ('applied', 'late_booked', 'late_unbooked'));
  next := h.state;
  if p_amount < h.deposit_mnt then
    disp := 'short';
  elsif applied or h.state in ('paid', 'booked', 'paid_unbooked') then
    disp := 'excess';
  elsif h.state = 'held' then
    disp := 'applied';
    next := 'paid';
  else
    -- expired or released: the money came after the time was let go. Take it back if free.
    perform pg_advisory_xact_lock(hashtextextended('booking:' || h.calendar_id, 0));
    select id into clash from booking_holds
     where calendar_id = h.calendar_id and id <> h.id and state in ('held', 'paid', 'booked')
       and tstzrange(starts_at, ends_at, '[)') && tstzrange(h.starts_at, h.ends_at, '[)')
     limit 1;
    -- Only a time that has not started yet can be taken back.
    if clash is null and h.starts_at > now() then
      disp := 'late_booked';
      next := 'paid';
    else
      disp := 'late_unbooked';
      next := 'paid_unbooked';
    end if;
  end if;

  insert into booking_payments (tenant_id, hold_id, invoice_id, payment_key, amount_mnt, paid_at, disposition)
  values (h.tenant_id, p_hold, p_invoice, p_payment_key, p_amount, p_paid_at, disp);

  if next is distinct from h.state then
    update booking_holds
       set state = next, paid_at = coalesce(paid_at, p_paid_at), late = (disp in ('late_booked', 'late_unbooked')),
           ended_at = case when next = 'paid_unbooked' then now() else null end,
           ended_reason = case when next = 'paid_unbooked' then 'late payment: the time was taken' else null end,
           version = version + 1, updated_at = now()
     where id = p_hold;
  end if;
  insert into booking_events (tenant_id, hold_id, session_id, kind, detail)
  values (h.tenant_id, h.id, h.session_id, 'payment.recorded',
          jsonb_build_object('payment_key', p_payment_key, 'amount_mnt', p_amount, 'disposition', disp,
                             'from', h.state, 'to', next));
  return jsonb_build_object('outcome', 'recorded', 'disposition', disp, 'previous_state', h.state, 'state', next);
end
$$;

-- The calendar holds the booking: paid -> booked.
create or replace function public.booking_mark_booked(p_hold uuid, p_event_id text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare h booking_holds%rowtype;
begin
  select * into h from booking_holds where id = p_hold for update;
  if h.id is null then raise exception 'no hold %', p_hold; end if;
  if h.state = 'booked' then return jsonb_build_object('outcome', 'already_booked'); end if;
  if h.state <> 'paid' then return jsonb_build_object('outcome', 'not_paid', 'state', h.state); end if;
  update booking_holds
     set state = 'booked', booked_at = now(), calendar_event_id = p_event_id, calendar_state = 'booked',
         version = version + 1, updated_at = now()
   where id = p_hold;
  insert into booking_events (tenant_id, hold_id, session_id, kind, detail)
  values (h.tenant_id, h.id, h.session_id, 'hold.booked', jsonb_build_object('event_id', p_event_id, 'late', h.late));
  return jsonb_build_object('outcome', 'booked');
end
$$;

-- Paid, and the time cannot be had (the website took it, or the calendar refused): a person
-- must refund or rebook. paid -> paid_unbooked.
create or replace function public.booking_mark_unbooked(p_hold uuid, p_reason text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare h booking_holds%rowtype;
begin
  select * into h from booking_holds where id = p_hold for update;
  if h.id is null then raise exception 'no hold %', p_hold; end if;
  if h.state = 'paid_unbooked' then return jsonb_build_object('outcome', 'already'); end if;
  if h.state <> 'paid' then return jsonb_build_object('outcome', 'not_paid', 'state', h.state); end if;
  update booking_holds
     set state = 'paid_unbooked', ended_at = now(), ended_reason = p_reason, version = version + 1, updated_at = now()
   where id = p_hold;
  insert into booking_events (tenant_id, hold_id, session_id, kind, detail)
  values (h.tenant_id, h.id, h.session_id, 'hold.paid_unbooked', jsonb_build_object('reason', p_reason));
  return jsonb_build_object('outcome', 'paid_unbooked');
end
$$;

-- A paid deposit whose time was taken (paid_unbooked), moved to another free time the customer
-- picked: the hold takes the new stylist and time and is `paid` again, so the ordinary booking
-- path writes it. Same length (same service), same level (same deposit), never in the past,
-- never over another hold, never while its old busy event is still in a calendar, and only
-- for 30 minutes after the time was lost: the founder's page names that deadline, after which
-- the deposit is the founder's to refund or book by hand, and a late tap can no longer book it.
create or replace function public.booking_rebook_hold(
  p_hold uuid, p_calendar text, p_staff text, p_level text, p_starts timestamptz, p_ends timestamptz)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  h     booking_holds%rowtype;
  clash uuid;
begin
  select * into h from booking_holds where id = p_hold for update;
  if h.id is null then raise exception 'no hold %', p_hold; end if;
  if h.state <> 'paid_unbooked' then
    return jsonb_build_object('outcome', 'not_paid_unbooked', 'state', h.state);
  end if;
  if h.ended_at is null or now() > h.ended_at + interval '30 minutes' then
    return jsonb_build_object('outcome', 'offer_over');
  end if;
  if p_starts <= now() or p_ends - p_starts <> make_interval(mins => h.minutes) or p_level is distinct from h.level then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if h.calendar_state = 'held' then
    return jsonb_build_object('outcome', 'calendar_busy');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('booking:' || p_calendar, 0));
  select id into clash from booking_holds
   where calendar_id = p_calendar and id <> h.id and state in ('held', 'paid', 'booked')
     and tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts, p_ends, '[)')
   limit 1;
  if clash is not null then
    return jsonb_build_object('outcome', 'taken');
  end if;
  update booking_holds
     set calendar_id = p_calendar, staff_name = p_staff, starts_at = p_starts, ends_at = p_ends,
         state = 'paid', calendar_state = 'none', calendar_event_id = null, notified_at = null,
         ended_at = null, ended_reason = null, rebooked_at = now(), version = version + 1, updated_at = now()
   where id = p_hold;
  insert into booking_events (tenant_id, hold_id, session_id, kind, detail)
  values (h.tenant_id, h.id, h.session_id, 'hold.rebooked',
          jsonb_build_object('from_calendar', h.calendar_id, 'from_starts_at', h.starts_at,
                             'to_calendar', p_calendar, 'to_starts_at', p_starts));
  return jsonb_build_object('outcome', 'rebooked');
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'booking_open_session(uuid, uuid, uuid, text, boolean, text, jsonb)',
    'booking_apply_turn(uuid, uuid, integer, text, text, jsonb, text, text, uuid, uuid)',
    'booking_acquire_hold(uuid, uuid, jsonb, timestamptz)',
    'booking_end_hold(uuid, text, text)',
    'booking_record_payment(uuid, uuid, text, bigint, timestamptz, text)',
    'booking_mark_booked(uuid, text)',
    'booking_mark_unbooked(uuid, text)',
    'booking_rebook_hold(uuid, text, text, text, timestamptz, timestamptz)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
