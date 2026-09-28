-- 0070 — the branded invoice e-mail, and test accounts never reached in live (D-156 addendum,
-- founder 2026-09-28).
--
-- 1. A TEST account is never invoiced, checked or written to once BILLING_MODE=live.
--    Until now `live` meant "every account", test ones included (`a.is_test or
--    p_include_live`), so the founder's test account would have been invoiced alongside the
--    clients. The modes now partition the accounts: `test` reaches only test accounts, `live`
--    only real ones. The engine filters its reads the same way (`engine.ts`).
--
-- 2. The outbox carries the e-mail as the client receives it: the HTML version beside the
--    plain text, and a binary attachment (the PDF invoice) as base64. Both are rendered when
--    the message is planned, like the text already is, so the row holds the exact bytes that
--    go out. `attachment_encoding` says how `attachment_body` is stored; every existing row
--    is 'utf8' (the founder's CSV ledger), which is what the sender always assumed.
--
-- Nothing is dropped or narrowed. The two functions are replaced with the same signatures.

alter table billing_deliveries
  add column html_body text check (html_body is null or length(html_body) between 1 and 400000),
  add column attachment_encoding text not null default 'utf8' check (attachment_encoding in ('utf8', 'base64')),
  add constraint billing_delivery_attachment_size check (attachment_body is null or length(attachment_body) <= 3000000);

comment on column billing_deliveries.html_body is
  'The HTML version of a client e-mail, rendered when planned (0070). Null: the text is sent as simple HTML.';
comment on column billing_deliveries.attachment_encoding is
  'How attachment_body is stored: utf8 text (the CSV ledger) or base64 bytes (the PDF invoice). 0070.';

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
  if p_include_live is null then raise exception 'p_include_live is required'; end if;
  for s in
    select sc.*, a.is_test
      from billing_schedules sc
      join billing_accounts a on a.id = sc.account_id
     where sc.active and sc.confirmed_at is not null and a.status = 'active'
       -- 0070: test mode reaches only test accounts, live mode only real ones.
       and a.is_test = not p_include_live
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

create or replace function public.billing_claim_deliveries(p_limit integer, p_include_live boolean)
returns setof billing_deliveries
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_include_live is null then raise exception 'p_include_live is required'; end if;
  update billing_deliveries d
     set status = 'cancelled', last_error = 'invoice no longer unpaid'
    from billing_invoices i
   where d.invoice_id = i.id and d.only_while_unpaid and d.status in ('pending', 'failed')
     and i.status <> 'open';
  -- Oldest first, and RETURNED oldest first (an UPDATE's RETURNING has no order of its
  -- own): an invoice goes out before the founder's copy of it.
  return query
  with claimed as (
    update billing_deliveries d
       set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
     where d.id in (
       select x.id from billing_deliveries x
        where x.status in ('pending', 'failed') and x.next_attempt_at <= now()
          -- 0070: a message about a test account is never sent in live mode, nor a live one in test.
          and x.is_test = not p_include_live
        order by x.created_at
        limit p_limit
          for update skip locked)
    returning d.*)
  select * from claimed order by claimed.created_at, claimed.id;
end
$$;

revoke all on function public.billing_issue_due(date, boolean) from public, anon, authenticated;
grant execute on function public.billing_issue_due(date, boolean) to service_role;
revoke all on function public.billing_claim_deliveries(integer, boolean) from public, anon, authenticated;
grant execute on function public.billing_claim_deliveries(integer, boolean) to service_role;
