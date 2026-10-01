-- DalaTech (tenant #0): Ора's new-customer gift as a fixed reply (D-173).
-- Revert: dalatech-ora-bonus-2026-10-01-revert.sql.
--
-- The --with-model dry run after D-172 passed 97/98; case 150 («Орад шинэ хэрэглэгчийн
-- урамшуулал байгаа юу?») was answered by the model without «500 асуулт». Like
-- `branch_count`, the answer is now a fixed reply that sends the approved document sentence
-- verbatim: «Шинэ хэрэглэгчид эхний сард +500 асуулт бэлэг.» No new wording.
--
-- Matcher: the message names Ора (whole word, Cyrillic or Latin, with its case endings) AND
-- carries a gift/offer stem («урамшуул», «бэлэг», «uramshuul», «beleg», «bonus»). Tested
-- against the real reply code (`gateTenant` over the live rows): answers «Орад шинэ
-- хэрэглэгчийн урамшуулал байгаа юу?», «Орагийн урамшуулал юу байгаа вэ», «ora uramshuulal
-- bga yu», «Ора бэлэг өгдөг үү?», «Ора шинэ хэрэглэгчид bonus бий юу»; leaves every other
-- tried question to its own path: «Ора сард хэдэн асуулт асууж болох вэ?», «Орагийн нэмэлт
-- багц хэд вэ?», «Орагийн нэмэлт хэрэглэгч хэд вэ?», «Ора одоо ажиллаж байгаа юу?»,
-- «Хямдрал байгаа юу?», «Шинэ хэрэглэгчид урамшуулал байгаа юу?» (no Ора), «Далид урамшуулал
-- бий юу», «Вирагийн урамшуулал бий юу», «Орох урамшуулал», «Хөнгөлөлт байгаа юу?».
--
-- The coming-soon line: the reply code appends it when the message names a service in
-- pre-registration. «Орад» was not one of Ора's item words, so case 150 would have gone out
-- without it; «орад» (and Latin «orad» for the status row) is added to Ора's piece in
-- `coming_soon_status` and «орад» in `coming_soon_in_reply`. Nothing else names «орад».
--
-- Expected bodies are built from the rows themselves (the fixed reply, the filled coming-soon
-- line, and the sales line the reply code adds: the default follow-up for «Орад…», the
-- callback line for «Орагийн…», whose matcher names «орагийн»), exactly as served.
--
-- Fixed replies are read per request: this answers customers the moment it commits.
begin;

create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
do $$ begin
  if (select count(*) from dt) <> 1 then raise exception 'tenant dalatech not found exactly once'; end if;
  if (select count(*) from deterministic_replies d join tenants t on t.id = d.tenant_id
       where t.slug = 'dalatech' and d.intent in ('coming_soon_status', 'coming_soon_in_reply')) <> 2 then
    raise exception 'expected exactly one coming_soon_status and one coming_soon_in_reply row';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. «орад» names Ора

update deterministic_replies d
   set items = (select jsonb_agg(case
                  when e.item ->> 'body' = 'Ора' and not (e.item -> 'words') ? w.word
                  then jsonb_set(e.item, '{words}', (e.item -> 'words') || to_jsonb(w.word))
                  else e.item end order by e.ord)
                  from jsonb_array_elements(d.items) with ordinality e(item, ord))
  from dt, (values ('coming_soon_status', 'орад'), ('coming_soon_in_reply', 'орад')) w(intent, word)
 where d.tenant_id = dt.id and d.intent = w.intent;

update deterministic_replies d
   set items = (select jsonb_agg(case
                  when e.item ->> 'body' = 'Ора' and not (e.item -> 'words') ? 'orad'
                  then jsonb_set(e.item, '{words}', (e.item -> 'words') || '"orad"'::jsonb)
                  else e.item end order by e.ord)
                  from jsonb_array_elements(d.items) with ordinality e(item, ord))
  from dt where d.tenant_id = dt.id and d.intent = 'coming_soon_status';

-- ---------------------------------------------------------------- 2. the fixed reply

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, matcher,
                                   requires_empty_history, provenance, placement)
select dt.id, 'ora_new_user_bonus', normalize('Шинэ хэрэглэгчид эхний сард +500 асуулт бэлэг.', NFC),
       true, 'matcher', '{}'::text[],
       '{"mode": "all_of", "matchers": [
          {"mode": "has_word", "words": ["ора", "ораг", "орагийн", "орад", "ораар", "ораас", "ora", "orag", "oragiin", "orad"]},
          {"mode": "contains_stem", "stems": ["урамшуул", "бэлэг", "uramshuul", "beleg", "bonus"]}]}'::jsonb,
       false, 'tenant_confirmed', 'replace'
  from dt
 where not exists (select 1 from deterministic_replies x where x.tenant_id = dt.id and x.intent = 'ora_new_user_bonus');

-- ---------------------------------------------------------------- 3. cases

create temp table soon_line on commit drop as
select replace(d.body, '{{soon}}', (
         select string_agg(e.item ->> 'body', ', ' order by e.ord)
           from jsonb_array_elements(d.items) with ordinality e(item, ord)
           join services s on s.id = (e.item ->> 'service_id')::uuid
          where s.launch_state = 'preregistration' and e.item ->> 'state' = 'preregistration')) as line
  from deterministic_replies d join dt on dt.id = d.tenant_id where d.intent = 'coming_soon_status';

-- Case 150 becomes exact.
update reply_cases r
   set expected_body = b.body || E'\n\n' || sl.line || E'\n\n' || f.body,
       must_include = array[]::text[],
       note = coalesce(r.note, '') || ' Exact from 2026-10-01: answered by ora_new_user_bonus (D-173).'
  from dt, soon_line sl, deterministic_replies b, sales_next_steps f
 where r.tenant_id = dt.id and r.active and b.tenant_id = dt.id and b.intent = 'ora_new_user_bonus'
   and f.tenant_id = dt.id and f.kind = 'follow_up' and f.enabled
   and r.customer_message = normalize('Орад шинэ хэрэглэгчийн урамшуулал байгаа юу?', NFC)
   and r.expected_body is null;

insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active)
select dt.id, 'facebook_page', normalize('Орагийн урамшуулал юу байгаа вэ?', NFC),
       b.body || E'\n\n' || sl.line || E'\n\n' || c.body, array[]::text[], array[]::text[],
       'D-173: Ора''s new-customer gift, fixed reply.', true
  from dt, soon_line sl, deterministic_replies b, sales_next_steps c
 where b.tenant_id = dt.id and b.intent = 'ora_new_user_bonus'
   and c.tenant_id = dt.id and c.kind = 'callback' and c.enabled
   and not exists (select 1 from reply_cases r where r.tenant_id = dt.id and r.active
                      and r.customer_message = normalize('Орагийн урамшуулал юу байгаа вэ?', NFC));

-- ---------------------------------------------------------------- refuse a partial write

do $$
declare n int; tid uuid := (select id from tenants where slug = 'dalatech');
begin
  select count(*) into n from deterministic_replies where tenant_id = tid and intent = 'ora_new_user_bonus' and enabled
     and body = normalize('Шинэ хэрэглэгчид эхний сард +500 асуулт бэлэг.', NFC) and match_mode = 'matcher';
  if n <> 1 then raise exception 'ora_new_user_bonus was not written'; end if;
  -- The body is the approved document sentence, byte for byte.
  if not exists (select 1 from knowledge_documents where tenant_id = tid and title like 'Ора%'
                   and position(normalize('Шинэ хэрэглэгчид эхний сард +500 асуулт бэлэг.', NFC) in body) > 0) then
    raise exception 'the gift sentence is not in Ора''s approved document';
  end if;
  select count(*) into n from deterministic_replies d, jsonb_array_elements(d.items) e(item)
   where d.tenant_id = tid and d.intent in ('coming_soon_status', 'coming_soon_in_reply')
     and e.item ->> 'body' = 'Ора' and (e.item -> 'words') ? 'орад';
  if n <> 2 then raise exception '«орад» is not an Ора item word in both coming-soon rows (%)', n; end if;
  select count(*) into n from reply_cases where tenant_id = tid and active and expected_body is not null
     and starts_with(expected_body, normalize(E'Шинэ хэрэглэгчид эхний сард +500 асуулт бэлэг.\n\nВира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно.\n\n', NFC))
     and customer_message in (normalize('Орад шинэ хэрэглэгчийн урамшуулал байгаа юу?', NFC), normalize('Орагийн урамшуулал юу байгаа вэ?', NFC));
  if n <> 2 then raise exception 'expected 2 exact gift cases, found %', n; end if;
end $$;

commit;
