-- The flaw loop (founder, 2026-09-24, first live day on Matrix).
--
-- 1. `reply_cases`: a reply the founder marked wrong becomes a permanent test. It carries
--    what the customer wrote, the conversation before it, and what the right answer is.
--    Every publish and every production deploy replays all of them and refuses to go out
--    unless each one passes (`scripts/replycases/gate.ts`). Nothing deletes a case: `active`
--    can be switched off by a person, and that is the only way one stops being checked.
--
-- 2. `spellings`: how a customer's Latin spelling of a Mongolian word maps to the word the
--    tenant's own data uses («usnii» → «үсний»). Grown every morning from real customer
--    messages. A mapping the data settles on its own is `settled`, the founder's is
--    `confirmed`, one the data cannot settle is `ask` and goes to the founder, and a no is
--    `rejected`. Only `settled` and `confirmed` are ever applied to matching.
--
-- 3. `mark_reply_wrong(ref, expected)` and `set_spelling(slug, latin, cyrillic)`: the two
--    things the morning report asks the founder to run, one line each, in the SQL editor.
--
-- Additive: two new tables and two functions. No existing row changes.

create table reply_cases (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references tenants(id) on delete cascade,
  -- The reply that was marked wrong. Null for a case written by hand. Provenance only, and
  -- deliberately NOT a foreign key: retention purges `outbound_messages`, and the case must
  -- outlive the reply it came from — the history and message are copied for that reason.
  source_outbound_id uuid,
  -- The turns before the customer's message, oldest first: [{role, content}, …].
  history            jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  customer_message   text not null check (length(btrim(customer_message)) > 0),
  -- The right answer, word for word. A reply passes when it is this text once whitespace
  -- is collapsed.
  expected_body      text,
  -- For an answer the model words: text that must appear, and text that must not.
  must_include       text[] not null default '{}',
  must_not_include   text[] not null default '{}',
  note               text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  constraint reply_cases_says_something check (
    expected_body is not null or cardinality(must_include) > 0 or cardinality(must_not_include) > 0
  )
);

comment on table reply_cases is
  'Replies marked wrong, kept as permanent tests. Replayed before every publish and every '
  'production deploy; a failing case stops both. D-120.';

create index reply_cases_tenant_active on reply_cases (tenant_id) where active;

create table spellings (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- One word, or two when only the neighbouring word settles it («usnii himi»).
  latin       text not null check (latin ~ '^[a-z0-9]{2,40}( [a-z0-9]{2,40})?$'),
  cyrillic    text,
  status      text not null check (status in ('settled', 'confirmed', 'ask', 'rejected')),
  -- The Cyrillic words the tenant's data could mean, when more than one.
  candidates  text[] not null default '{}',
  -- Up to three customer messages the token was seen in, for the founder to judge by.
  evidence    text[] not null default '{}',
  seen        integer not null default 1 check (seen >= 1),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  primary key (tenant_id, latin),
  constraint spellings_applied_have_a_word check (status not in ('settled', 'confirmed') or cyrillic is not null)
);

comment on table spellings is
  'Latin spellings customers use for the tenant''s Mongolian words. settled/confirmed rows '
  'are applied to matching; ask rows go to the founder in the morning report. D-120.';

alter table reply_cases enable row level security;
alter table reply_cases force row level security;
alter table spellings enable row level security;
alter table spellings force row level security;

create policy reply_cases_no_client_insert on reply_cases
  as restrictive for insert to anon, authenticated with check (false);
create policy reply_cases_no_client_update on reply_cases
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy reply_cases_no_client_delete on reply_cases
  as restrictive for delete to anon, authenticated using (false);
create policy spellings_no_client_insert on spellings
  as restrictive for insert to anon, authenticated with check (false);
create policy spellings_no_client_update on spellings
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy spellings_no_client_delete on spellings
  as restrictive for delete to anon, authenticated using (false);

insert into ops.tenant_scope (table_schema, table_name, tenant_column)
values ('public', 'reply_cases', 'tenant_id'), ('public', 'spellings', 'tenant_id');

insert into ops.table_security_class (table_schema, table_name, class, note)
values
  ('public', 'reply_cases', 'server_owned', 'replies marked wrong, kept as permanent tests'),
  ('public', 'spellings', 'server_owned', 'customer Latin spellings mapped to the tenant''s words');

revoke all on reply_cases from anon, authenticated;
revoke all on spellings from anon, authenticated;
grant all on reply_cases to service_role;
grant all on spellings to service_role;

-- Mark a reply wrong. `p_ref` is the id prefix the morning report prints. The customer's
-- message and the ten turns before it (RECEPTION_HISTORY_TURNS, read the way
-- `inbound/persist.ts` reads them) are copied into the case, so it keeps testing the
-- same situation after the conversation itself has aged out of retention.
create or replace function public.mark_reply_wrong(p_ref text, p_expected text, p_note text default null)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o         outbound_messages%rowtype;
  n         integer;
  inbound   messages%rowtype;
  h         jsonb;
  new_id    bigint;
begin
  if p_ref is null or p_ref !~ '^[0-9a-f]{8,36}$' then
    raise exception 'the ref is the 8 characters the morning report printed, e.g. 4f2a9c1b';
  end if;
  if p_expected is null or length(btrim(p_expected)) = 0 then
    raise exception 'the expected answer is required';
  end if;
  select count(*) into n from outbound_messages where id::text like p_ref || '%';
  if n <> 1 then
    raise exception 'ref % matches % replies', p_ref, n;
  end if;
  select * into o from outbound_messages where id::text like p_ref || '%';
  select * into inbound from messages
   where tenant_id = o.tenant_id and direction = 'inbound' and 'in:' || external_id = o.dedup_key
   limit 1;
  if inbound.id is null or inbound.body is null then
    raise exception 'no customer message is stored for reply %', p_ref;
  end if;
  select coalesce(jsonb_agg(t.turn order by t.at), '[]'::jsonb) into h from (
    select * from (
      select jsonb_build_object('role', 'user', 'content', m.body) as turn, m.at
        from messages m
       where m.conversation_id = o.conversation_id and m.direction = 'inbound'
         and m.at < inbound.at and m.body is not null
      union all
      select jsonb_build_object('role', 'assistant', 'content', x.body), x.created_at
        from outbound_messages x
       where x.conversation_id = o.conversation_id
         and x.created_at < inbound.at and x.state in ('sent', 'draft')
    ) u order by u.at desc limit 10
  ) t;
  insert into reply_cases (tenant_id, source_outbound_id, history, customer_message, expected_body, note)
  values (o.tenant_id, o.id, h, inbound.body, p_expected, p_note)
  returning id into new_id;
  return new_id;
end
$$;

-- Settle a spelling by hand: a Cyrillic word confirms it, null rejects it.
create or replace function public.set_spelling(p_slug text, p_latin text, p_cyrillic text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t uuid;
begin
  select id into t from tenants where slug = p_slug;
  if t is null then raise exception 'no tenant with slug %', p_slug; end if;
  insert into spellings (tenant_id, latin, cyrillic, status, decided_at)
  values (t, lower(btrim(p_latin)), normalize(btrim(p_cyrillic), NFC),
          case when p_cyrillic is null then 'rejected' else 'confirmed' end, now())
  on conflict (tenant_id, latin) do update
     set cyrillic = excluded.cyrillic, status = excluded.status, decided_at = now();
  return case when p_cyrillic is null then 'rejected' else 'confirmed' end;
end
$$;

revoke all on function public.mark_reply_wrong(text, text, text) from public, anon, authenticated;
revoke all on function public.set_spelling(text, text, text) from public, anon, authenticated;
grant execute on function public.mark_reply_wrong(text, text, text) to service_role;
grant execute on function public.set_spelling(text, text, text) to service_role;
