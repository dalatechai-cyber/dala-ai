-- billing.sql — client billing's promises, against the functions themselves (0065, D-156).
--
-- The engine's unit tests stub `db.rpc`, so they say nothing about the plpgsql that decides
-- whether an invoice is created twice, a payment counted twice, a payment credited to the
-- wrong client, or a reminder sent to a client who has paid. This does, end state by end
-- state. Runs as service_role (the role every deployed surface holds), inside a transaction
-- that is rolled back. `now()` is fixed for a transaction, so "older than" is tested with a
-- negative interval.
\set ON_ERROR_STOP on

begin;
set local role service_role;

do $$
declare
  v_t     uuid := 'b1111111-0000-0000-0000-000000000001';
  v_live  uuid;
  v_test  uuid;
  v_s     uuid;
  v_s2    uuid;
  v_i     uuid;
  v_i2    uuid;
  v_ch    uuid := 'b2222222-0000-0000-0000-000000000001';
  r       jsonb;
  n       integer;
  fp      text;
  ok      boolean;
  checks  integer := 0;
begin
  reset role;
  insert into tenants (id, slug, display_name, vertical, timezone)
  values (v_t, 'billing-t', 'Биллинг Т', 'salon', 'Asia/Ulaanbaatar');
  insert into tenant_channels (id, tenant_id, provider, external_id, auth_flavour, app_slug, status,
                               delivery_mode, token_status, comment_delivery_mode)
  values (v_ch, v_t, 'facebook_page', 'billing-page', 'facebook_login', 'dalatech', 'pending',
          'shadow', 'unprovisioned', 'shadow');
  set local role service_role;

  insert into billing_accounts (tenant_id, display_name, email) values (v_t, 'Биллинг ХХК', 'client@example.mn')
    returning id into v_live;
  insert into billing_accounts (display_name, is_test, email) values ('Туршилтын харилцагч', true, 'me@example.mn')
    returning id into v_test;

  -- B1 — lines must add up.
  begin
    insert into billing_schedules (account_id, kind, lines, amount_mnt, every_months, next_month)
    values (v_test, 'monthly_fee', '[{"label":"Дали","amount_mnt":100}]', 200, 1, '2026-10-01');
    raise exception 'B1 FAILED: lines summing to 100 were accepted for 200';
  exception when raise_exception then
    if sqlerrm like 'B1 FAILED%' then raise; end if;
  end;
  checks := checks + 1;

  -- B2 — an unconfirmed schedule is never invoiced; a wrong fingerprint never confirms.
  insert into billing_schedules (account_id, kind, lines, amount_mnt, every_months, next_month)
  values (v_test, 'monthly_fee', '[{"label":"Дали — AI хүлээн авагч","amount_mnt":100}]', 100, 1, '2026-10-01')
  returning id into v_s;
  r := billing_issue_due('2026-10-01', false);
  if jsonb_array_length(r -> 'issued') <> 0 then raise exception 'B2 FAILED: unconfirmed schedule invoiced: %', r; end if;
  begin
    perform billing_confirm_schedule(v_s, 'not-it', 'Bilguun');
    raise exception 'B2 FAILED: a wrong fingerprint confirmed';
  exception when raise_exception then
    if sqlerrm like 'B2 FAILED%' then raise; end if;
  end;
  checks := checks + 1;

  -- B3 — confirmed: exactly one invoice for the month, however many times it runs.
  fp := billing_schedule_fingerprint(v_s);
  if not billing_confirm_schedule(v_s, fp, 'Bilguun') then raise exception 'B3 FAILED: confirm returned false'; end if;
  r := billing_issue_due('2026-10-01', false);
  if jsonb_array_length(r -> 'issued') <> 1 then raise exception 'B3 FAILED: expected one invoice, got %', r; end if;
  v_i := (r -> 'issued' ->> 0)::uuid;
  r := billing_issue_due('2026-10-01', false);
  r := billing_issue_due('2026-10-02', false);
  select count(*) into n from billing_invoices where account_id = v_test;
  if n <> 1 then raise exception 'B3 FAILED: % invoices after three runs', n; end if;
  perform 1 from billing_invoices where id = v_i and due_on = '2026-10-05' and issued_on = '2026-10-01'
    and period_start = '2026-10-01' and period_end = '2026-10-31' and invoice_no like 'TEST-202610-%' and status = 'open';
  if not found then raise exception 'B3 FAILED: invoice dates/number wrong'; end if;
  perform 1 from billing_schedules where id = v_s and next_month = '2026-11-01';
  if not found then raise exception 'B3 FAILED: schedule did not move to November'; end if;
  checks := checks + 1;

  -- B4 — a change to what is charged clears the confirmation; moving next_month does not.
  update billing_schedules set next_month = '2026-11-01' where id = v_s;
  perform 1 from billing_schedules where id = v_s and confirmed_at is not null;
  if not found then raise exception 'B4 FAILED: moving next_month cleared the confirmation'; end if;
  update billing_schedules set lines = '[{"label":"Дали","amount_mnt":150}]', amount_mnt = 150 where id = v_s;
  perform 1 from billing_schedules where id = v_s and confirmed_at is null and confirmed_by is null;
  if not found then raise exception 'B4 FAILED: a new amount kept the old confirmation'; end if;
  checks := checks + 1;

  -- B5 — live accounts are reached only with p_include_live; a schedule behind is reported, not caught up.
  insert into billing_schedules (account_id, kind, lines, amount_mnt, every_months, next_month)
  values (v_live, 'monthly_fee', '[{"label":"Дали","amount_mnt":250000}]', 250000, 1, '2026-09-01')
  returning id into v_s2;
  perform billing_confirm_schedule(v_s2, billing_schedule_fingerprint(v_s2), 'Bilguun');
  r := billing_issue_due('2026-10-01', false);
  if exists (select 1 from billing_invoices where account_id = v_live) then raise exception 'B5 FAILED: live invoiced in test mode'; end if;
  r := billing_issue_due('2026-10-01', true);
  if jsonb_array_length(r -> 'behind') <> 1 or exists (select 1 from billing_invoices where account_id = v_live) then
    raise exception 'B5 FAILED: a schedule behind was caught up or not reported: %', r;
  end if;
  checks := checks + 1;

  -- B6 — never a monthly fee and an annual prepay at once.
  begin
    insert into billing_schedules (account_id, kind, lines, amount_mnt, every_months, next_month)
    values (v_live, 'annual_prepay', '[{"label":"Жил","amount_mnt":2500000}]', 2500000, 12, '2026-10-01');
    raise exception 'B6 FAILED: annual prepay beside a monthly fee';
  exception when raise_exception then
    if sqlerrm like 'B6 FAILED%' then raise; end if;
  end;
  checks := checks + 1;

  -- B7 — one QPay invoice per invoice: a claim is exclusive, a stale claim is taken over,
  -- and a recorded QPay id is never replaced.
  if billing_claim_qpay(v_i, interval '10 minutes') is distinct from 1 then raise exception 'B7 FAILED: first claim'; end if;
  if billing_claim_qpay(v_i, interval '10 minutes') is not null then raise exception 'B7 FAILED: second claim won'; end if;
  if billing_claim_qpay(v_i, interval '-1 second') is distinct from 2 then raise exception 'B7 FAILED: stale claim not taken over'; end if;
  if not billing_set_qpay(v_i, 'QP-1', 'qr', 'img', '[]') then raise exception 'B7 FAILED: set_qpay'; end if;
  if billing_set_qpay(v_i, 'QP-2', 'qr', 'img', '[]') then raise exception 'B7 FAILED: QPay id replaced'; end if;
  if billing_claim_qpay(v_i, interval '-1 second') is not null then raise exception 'B7 FAILED: claimed after set'; end if;
  checks := checks + 1;

  -- B8 — a payment for another QPay invoice is refused; the exact amount is paid; the same
  -- payment twice is one payment.
  begin
    perform billing_record_payment(v_i, 'qpay:X', 'qpay', 100, now(), 'QP-OTHER', 'check', null);
    raise exception 'B8 FAILED: payment for another QPay invoice accepted';
  exception when raise_exception then
    if sqlerrm like 'B8 FAILED%' then raise; end if;
  end;
  r := billing_record_payment(v_i, 'qpay:P1', 'qpay', 100, now(), 'QP-1', 'callback', null);
  if r ->> 'status' <> 'paid' or not (r ->> 'inserted')::boolean then raise exception 'B8 FAILED: exact amount not paid: %', r; end if;
  r := billing_record_payment(v_i, 'qpay:P1', 'qpay', 100, now(), 'QP-1', 'check', null);
  if r ->> 'status' <> 'paid' or (r ->> 'inserted')::boolean or (r ->> 'paid_sum_mnt')::bigint <> 100 then
    raise exception 'B8 FAILED: the same payment counted twice: %', r;
  end if;
  checks := checks + 1;

  -- B9 — a second payment makes it a mismatch (paid twice), for the founder.
  r := billing_record_payment(v_i, 'qpay:P2', 'qpay', 100, now(), 'QP-1', 'check', null);
  if r ->> 'status' <> 'mismatch' or (r ->> 'paid_sum_mnt')::bigint <> 200 then raise exception 'B9 FAILED: overpayment not flagged: %', r; end if;
  perform 1 from billing_invoices where id = v_i and paid_at is null;
  if not found then raise exception 'B9 FAILED: a mismatch kept paid_at'; end if;
  checks := checks + 1;

  -- B10 — an underpayment is a mismatch; only the founder settles it, with a reason.
  r := billing_issue_one_off(v_test, 'setup-test', '[{"label":"Суурилуулалт","amount_mnt":50000}]', 50000,
                             '2026-10-01', '2026-10-06', 'Bilguun');
  v_i2 := (r ->> 'invoice_id')::uuid;
  r := billing_record_payment(v_i2, 'bank:REF-1', 'bank', 40000, now(), null, 'operator:Bilguun', 'Хаан банк');
  if r ->> 'status' <> 'mismatch' then raise exception 'B10 FAILED: underpayment not flagged: %', r; end if;
  begin
    perform billing_resolve(v_i2, 'paid', 'Bilguun', '');
    raise exception 'B10 FAILED: resolved without a reason';
  exception when raise_exception then
    if sqlerrm like 'B10 FAILED%' then raise; end if;
  end;
  if billing_resolve(v_i2, 'paid', 'Bilguun', 'discount agreed by phone') <> 'paid' then raise exception 'B10 FAILED: resolve'; end if;
  r := billing_record_payment(v_i2, 'bank:REF-2', 'bank', 10000, now(), null, 'operator:Bilguun', null);
  if r ->> 'status' <> 'paid' then raise exception 'B10 FAILED: a later payment undid the founder''s resolution: %', r; end if;
  checks := checks + 1;

  -- B11 — the same payment key cannot be credited to a second invoice.
  begin
    perform billing_record_payment(v_i2, 'qpay:P1', 'qpay', 100, now(), 'QP-1', 'check', null);
    raise exception 'B11 FAILED: one payment credited to two invoices';
  exception when raise_exception then
    if sqlerrm like 'B11 FAILED%' then raise; end if;
  end;
  checks := checks + 1;

  -- B12 — a one-off is created once; the same key with different content refuses.
  r := billing_issue_one_off(v_test, 'setup-test', '[{"label":"Суурилуулалт","amount_mnt":50000}]', 50000,
                             '2026-10-01', '2026-10-06', 'Bilguun');
  if (r ->> 'created')::boolean then raise exception 'B12 FAILED: one-off created twice'; end if;
  begin
    perform billing_issue_one_off(v_test, 'setup-test', '[{"label":"Суурилуулалт","amount_mnt":60000}]', 60000,
                                  '2026-10-01', '2026-10-06', 'Bilguun');
    raise exception 'B12 FAILED: an issued one-off was changed';
  exception when raise_exception then
    if sqlerrm like 'B12 FAILED%' then raise; end if;
  end;
  checks := checks + 1;

  -- B13 — the evidence is append-only, even for service_role.
  begin
    update billing_payments set amount_mnt = 1;
    raise exception 'B13 FAILED: a payment was rewritten';
  exception when restrict_violation then null;
  end;
  begin
    truncate billing_events;
    raise exception 'B13 FAILED: events truncated';
  exception when insufficient_privilege or restrict_violation then null;
  end;
  checks := checks + 1;

  -- B14 — the outbox: a reminder for a paid invoice is cancelled, not sent; a message is
  -- claimed once; an unfinished claim becomes unknown, never pending again.
  insert into billing_deliveries (dedup_key, account_id, invoice_id, is_test, kind, channel, recipient, body, only_while_unpaid)
  values ('t:reminder', v_test, v_i2, true, 'reminder_after', 'email', 'me@example.mn', 'сануулга', true),
         ('t:receipt', v_test, v_i2, true, 'receipt', 'email', 'me@example.mn', 'баримт', false),
         ('t:live', v_live, null, false, 'founder_summary', 'telegram', 'founder', 'summary', false);
  select count(*) into n from billing_claim_deliveries(10, false);
  if n <> 1 then raise exception 'B14 FAILED: expected only the receipt claimed in test mode, got %', n; end if;
  perform 1 from billing_deliveries where dedup_key = 't:reminder' and status = 'cancelled';
  if not found then raise exception 'B14 FAILED: reminder for a paid invoice not cancelled'; end if;
  perform 1 from billing_deliveries where dedup_key = 't:live' and status = 'pending';
  if not found then raise exception 'B14 FAILED: a live message was claimed in test mode'; end if;
  select count(*) into n from billing_claim_deliveries(10, false);
  if n <> 0 then raise exception 'B14 FAILED: a claimed message was claimed again'; end if;
  select count(*) into n from billing_sweep_unfinished(interval '-1 second');
  if n <> 1 then raise exception 'B14 FAILED: unfinished claim not swept'; end if;
  if billing_finish_delivery((select id from billing_deliveries where dedup_key = 't:receipt'), true, 'm1', null, null) then
    raise exception 'B14 FAILED: an unknown message was marked sent by a late finisher';
  end if;
  select count(*) into n from billing_claim_deliveries(10, true);
  if n <> 1 then raise exception 'B14 FAILED: live message not claimed in live mode'; end if;
  if not billing_finish_delivery((select id from billing_deliveries where dedup_key = 't:live'), false, null, 'telegram 502', now() - interval '1 second') then
    raise exception 'B14 FAILED: failure not recorded';
  end if;
  select count(*) into n from billing_claim_deliveries(10, true);
  if n <> 1 then raise exception 'B14 FAILED: a failed message was not retried'; end if;
  perform billing_finish_delivery((select id from billing_deliveries where dedup_key = 't:live'), false, null, 'gave up', null);
  select count(*) into n from billing_claim_deliveries(10, true);
  if n <> 0 then raise exception 'B14 FAILED: a terminal failure was retried'; end if;
  checks := checks + 1;

  -- B15 — pause keeps the prior modes; a second pause is a no-op; resume restores them.
  r := billing_pause(v_live, null, 'Bilguun');
  if (r ->> 'channels')::int <> 1 then raise exception 'B15 FAILED: pause: %', r; end if;
  perform 1 from tenant_channels where id = v_ch and delivery_mode = 'off' and comment_delivery_mode = 'off';
  if not found then raise exception 'B15 FAILED: channel not off'; end if;
  r := billing_pause(v_live, null, 'Bilguun');
  if not (r ->> 'already_paused')::boolean then raise exception 'B15 FAILED: second pause not a no-op'; end if;
  r := billing_resume(v_live, 'Bilguun');
  perform 1 from tenant_channels where id = v_ch and delivery_mode = 'shadow' and comment_delivery_mode = 'shadow';
  if not found or (r ->> 'restored')::int <> 1 then raise exception 'B15 FAILED: resume did not restore: %', r; end if;
  r := billing_resume(v_live, 'Bilguun');
  if (r ->> 'resumed')::boolean then raise exception 'B15 FAILED: resumed twice'; end if;
  checks := checks + 1;

  -- B16 — a channel somebody changed while paused is left alone on resume.
  perform billing_pause(v_live, null, 'Bilguun');
  update tenant_channels set delivery_mode = 'shadow_routing' where id = v_ch;
  r := billing_resume(v_live, 'Bilguun');
  perform 1 from tenant_channels where id = v_ch and delivery_mode = 'shadow_routing';
  if not found or jsonb_array_length(r -> 'skipped') <> 1 then raise exception 'B16 FAILED: %', r; end if;
  checks := checks + 1;

  -- B17 — a test account never becomes live, and an account's tenant never changes.
  begin
    update billing_accounts set is_test = false where id = v_test;
    raise exception 'B17 FAILED: test account made live';
  exception when restrict_violation then null;
  end;
  checks := checks + 1;

  raise notice 'billing: % checks passed', checks;
  if checks <> 17 then raise exception 'billing: expected 17 checks, ran %', checks; end if;
end $$;

rollback;
