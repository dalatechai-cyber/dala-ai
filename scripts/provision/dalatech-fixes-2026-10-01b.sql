-- DalaTech (tenant #0): fixes for the --with-model dry run of 2026-10-01 after
-- dalatech-prices-2026-10-01.sql, and the founder's rename (D-172).
-- Revert: dalatech-fixes-2026-10-01b-revert.sql.
--
-- What the dry run failed, and what was wrong (each reproduced locally with the real reply
-- code over the live rows, `gateTenant` + `fixtureDb`, no model):
--
--   1. Cases 9, 15, 16, 17, 19, 41 expect «⏳ Удахгүй: Вира сард 250,000₮, …». The ROW was
--      wrong, not the cases: `price_overview.items` still held «Вира сард 350,000₮» (and the
--      live-state piece «… маркетинг менежер: сард 350,000₮»). D-171 changed the price row
--      and the cases but not these two pieces. Fixed in the row; the cases keep 250,000.
--   2. Cases 149, 151 (outbound_percent): not this file. The guard approves exactly the
--      percentages the tenant's own sections state; the dry-run harness judged the NEW
--      prefix with the LIVE snapshot's list, which predates Ора's 100% and +25%. Fixed in
--      `src/lib/replycases/run.ts` (`withCompiled`), no tenant-specific code.
--   3. Case 154: the CASE was wrong. The row answers, and the reviewed coming-soon line is
--      appended because the question names Ора: «…холбогдоно.\n\nВира, Эхо, Нова, Ора
--      хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно.» Expected body updated.
--      Case 23 («daly gj yuve»): no row answered «what is Дали», so the model did, and the
--      dry run served a reviewed line that names no role. A fixed reply `dali_about` (live
--      only) now answers it from Дали's own approved KB sentences; cases 23 and 34 follow it.
--
-- Rename (founder, 2026-10-01, to match the website, contract and forms):
--   «Дали — AI хүлээн авагч» → «Дали — Харилцагчийн менежер»
--   «Нова — сануулга, SMS»  → «Нова — Захиалгын менежер»
-- Everywhere these names are on the dalatech tenant: services, knowledge document titles,
-- the price overview (body and pieces), and every active reply case quoting them. No canned
-- line, FAQ, alias, document body or sales line carries either name (read 2026-10-01), so
-- none needs re-signing. The launch states in the snapshot pick up the names at the publish.
--
-- Customer-visible Mongolian beyond the names: only `dali_about`'s body, which is the new
-- name plus three sentences already in Дали's approved knowledge document, unchanged.
-- It waits for the founder's approval like every new line.
begin;

create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
do $$ begin
  if (select count(*) from dt) <> 1 then raise exception 'tenant dalatech not found exactly once'; end if;
end $$;

create temp table ren (old text, new text) on commit drop;
insert into ren values
  (normalize('Дали — AI хүлээн авагч', NFC), normalize('Дали — Харилцагчийн менежер', NFC)),
  (normalize('Нова — сануулга, SMS', NFC), normalize('Нова — Захиалгын менежер', NFC));

-- ---------------------------------------------------------------- 1. names

update services s set name = r.new from dt, ren r where s.tenant_id = dt.id and s.name = r.old;

update knowledge_documents k set title = replace(k.title, r.old, r.new), updated_at = now()
  from dt, ren r where k.tenant_id = dt.id and starts_with(k.title, r.old || ' (');

-- ---------------------------------------------------------------- 2. the price overview

-- The body names Дали; the pieces name Нова (live state) and carry Вира's price (both
-- states). Each replacement is an exact substring of the reviewed text; the checks below
-- refuse the file unless every one of them landed.
update deterministic_replies d
   set body = replace(d.body, normalize('💬 Дали — AI хүлээн авагч:', NFC), normalize('💬 Дали — Харилцагчийн менежер:', NFC)),
       items = replace(replace(replace(d.items::text,
                 normalize('💬 Нова — сануулга, SMS:', NFC), normalize('💬 Нова — Захиалгын менежер:', NFC)),
                 normalize('маркетинг менежер: сард 350,000₮', NFC), normalize('маркетинг менежер: сард 250,000₮', NFC)),
                 normalize('Вира сард 350,000₮', NFC), normalize('Вира сард 250,000₮', NFC))::jsonb
  from dt where d.tenant_id = dt.id and d.intent = 'price_overview';

-- ---------------------------------------------------------------- 3. «what is Дали»

-- Answers only while Дали is live, like `nova_about`. Matched when every word of the message
-- is Дали's name or one of the cover words (the `nova_about` list, plus greetings and the
-- Latin «gj», «yuve»). Tested against the real matcher: answers «daly gj yuve», «Сайн байна
-- уу, Дали юу хийдэг вэ?», «Дали гэж юу вэ?», «dali yu hiideg ve»; leaves «Дали сард хэд
-- вэ?», «Далигийн үнэ хэд вэ?», «Дали авъя», «Дали ажиллаж байгаа юу?» to their own paths.
insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words,
                                   requires_empty_history, provenance, placement, when_service_id, when_launch_state)
select dt.id, 'dali_about',
       normalize('Дали — Харилцагчийн менежер. Facebook, Instagram, вэбсайтад ирсэн зурваст шууд хариулж, үнэ, цаг, үйлчилгээний мэдээллийг өгнө. Захиалга, цаг товлолтыг бүртгэнэ. Шөнө ирсэн зурваст ч хариулна.', NFC),
       true, 'covers_message',
       array['дали', 'далиг', 'далигийн', 'далийн', 'dali', 'daly', 'dalig', 'daligiin', 'daliin'],
       (select n.cover_words from deterministic_replies n where n.tenant_id = dt.id and n.intent = 'nova_about')
         || array['сайн', 'sain', 'sn', 'bnu', 'bnuu', 'gj', 'yuve', 'yuu', 'юм', 'yum'],
       false, 'tenant_confirmed', 'replace', s.id, 'live'
  from dt join services s on s.tenant_id = dt.id and s.name = normalize('Дали — Харилцагчийн менежер', NFC)
 where not exists (select 1 from deterministic_replies x where x.tenant_id = dt.id and x.intent = 'dali_about');

-- ---------------------------------------------------------------- 4. reply cases

-- Exact bodies and must-include lists that quote a renamed name.
update reply_cases r
   set expected_body = replace(replace(r.expected_body,
         normalize('💬 Дали — AI хүлээн авагч:', NFC), normalize('💬 Дали — Харилцагчийн менежер:', NFC)),
         normalize('💬 Нова — сануулга, SMS:', NFC), normalize('💬 Нова — Захиалгын менежер:', NFC)),
       note = coalesce(r.note, '') || ' Renamed 2026-10-01 (D-172).'
  from dt where r.tenant_id = dt.id and r.active
   and (r.expected_body like '%Дали — AI хүлээн авагч:%' or r.expected_body like '%Нова — сануулга, SMS:%');

update reply_cases r
   set must_include = array_replace(r.must_include, normalize('💬 Дали — AI хүлээн авагч: сард 250,000₮', NFC),
                                    normalize('💬 Дали — Харилцагчийн менежер: сард 250,000₮', NFC)),
       note = coalesce(r.note, '') || ' Renamed 2026-10-01 (D-172).'
  from dt where r.tenant_id = dt.id and r.active
   and normalize('💬 Дали — AI хүлээн авагч: сард 250,000₮', NFC) = any(r.must_include);

-- «daly gj yuve» and «Сайн байна уу, Дали юу хийдэг вэ?»: the role is the new name.
update reply_cases r
   set must_include = array_replace(r.must_include, normalize('хүлээн авагч', NFC), normalize('Харилцагчийн менежер', NFC)),
       note = coalesce(r.note, '') || ' Answered by dali_about from 2026-10-01 (D-172).'
  from dt where r.tenant_id = dt.id and r.active
   and normalize('хүлээн авагч', NFC) = any(r.must_include)
   and r.customer_message in (normalize('daly gj yuve', NFC), normalize('Сайн байна уу, Дали юу хийдэг вэ?', NFC));

-- Case 154: the coming-soon line is appended, built here from the rows themselves (the
-- reviewed template filled with the pieces whose service is in pre-registration, in the
-- pieces' order, joined by «, »; appended after a blank line), exactly as the reply code
-- does (`fillTemplate`, `withAppended`).
create temp table soon_line on commit drop as
select replace(d.body, '{{soon}}', (
         select string_agg(e.item ->> 'body', ', ' order by e.ord)
           from jsonb_array_elements(d.items) with ordinality e(item, ord)
           join services s on s.id = (e.item ->> 'service_id')::uuid
          where s.launch_state = 'preregistration' and e.item ->> 'state' = 'preregistration')) as line
  from deterministic_replies d join dt on dt.id = d.tenant_id where d.intent = 'coming_soon_status';

update reply_cases r
   set expected_body = x.body || E'\n\n' || sl.line,
       note = coalesce(r.note, '') || ' The question names Ора, so the coming-soon line is appended (D-172).'
  from dt, soon_line sl, deterministic_replies x
 where r.tenant_id = dt.id and r.active and x.tenant_id = dt.id and x.intent = 'extra_user_price'
   and r.customer_message = normalize('Орагийн нэмэлт хэрэглэгч хэд вэ?', NFC)
   and r.expected_body = x.body;

-- Exact cases for `dali_about` (live state only): its body, then the follow-up sales line.
insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active, when_launch)
select dt.id, 'facebook_page', normalize(q, NFC), d.body || E'\n\n' || f.body, array[]::text[], array['хүлээн авагч'],
       'D-172: «what is Дали» is answered by dali_about, no model.', true,
       jsonb_build_array(jsonb_build_object('service_id', d.when_service_id, 'state', 'live'))
  from dt join deterministic_replies d on d.tenant_id = dt.id and d.intent = 'dali_about'
          join sales_next_steps f on f.tenant_id = dt.id and f.kind = 'follow_up' and f.enabled,
       unnest(array['Дали гэж юу вэ?', 'dali yu hiideg ve']) q
 where not exists (select 1 from reply_cases r where r.tenant_id = dt.id and r.active and r.customer_message = normalize(q, NFC));

-- ---------------------------------------------------------------- refuse a partial write

do $$
declare n int; tid uuid := (select id from tenants where slug = 'dalatech');
begin
  if exists (select 1 from services where tenant_id = tid and name in (normalize('Дали — AI хүлээн авагч', NFC), normalize('Нова — сануулга, SMS', NFC))) then
    raise exception 'an old service name is still there';
  end if;
  select count(*) into n from services where tenant_id = tid
     and name in (normalize('Дали — Харилцагчийн менежер', NFC), normalize('Нова — Захиалгын менежер', NFC));
  if n <> 2 then raise exception 'expected 2 renamed services, found %', n; end if;
  select count(*) into n from knowledge_documents where tenant_id = tid
     and (starts_with(title, normalize('Дали — Харилцагчийн менежер (', NFC)) or starts_with(title, normalize('Нова — Захиалгын менежер (', NFC)));
  if n <> 3 then raise exception 'expected 3 renamed document titles, found %', n; end if;
  -- No active row anywhere on this tenant still says an old name or Вира's old price.
  if exists (select 1 from knowledge_documents where tenant_id = tid and (title || body) ~ '(AI хүлээн авагч|сануулга, SMS)')
     or exists (select 1 from deterministic_replies where tenant_id = tid
                 and (body || coalesce(web_body, '') || coalesce(items::text, '')) ~ '(AI хүлээн авагч|сануулга, SMS|350,000)')
     or exists (select 1 from reply_cases where tenant_id = tid and active
                 and (coalesce(expected_body, '') || must_include::text) ~ '(AI хүлээн авагч|сануулга, SMS|350,000)') then
    raise exception 'an old name or 350,000 is still in a document, fixed reply or active case';
  end if;
  -- The overview renders the new figures in both states.
  select count(*) into n from deterministic_replies d where d.tenant_id = tid and d.intent = 'price_overview'
     and position(normalize('💬 Дали — Харилцагчийн менежер: сард 250,000₮', NFC) in d.body) = 1
     and position(normalize('"Вира сард 250,000₮"', NFC) in d.items::text) > 0
     and position(normalize('💬 Вира — маркетинг менежер: сард 250,000₮', NFC) in d.items::text) > 0
     and position(normalize('💬 Нова — Захиалгын менежер: сард 150,000₮', NFC) in d.items::text) > 0;
  if n <> 1 then raise exception 'price_overview was not updated'; end if;
  select count(*) into n from deterministic_replies where tenant_id = tid and intent = 'dali_about' and enabled
     and when_launch_state = 'live' and when_service_id is not null and cardinality(cover_words) > 60;
  if n <> 1 then raise exception 'dali_about was not written'; end if;
  select count(*) into n from reply_cases r where r.tenant_id = tid and r.active
     and r.customer_message = normalize('Орагийн нэмэлт хэрэглэгч хэд вэ?', NFC)
     and r.expected_body like '%' || normalize(E'холбогдоно.\n\nВира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно.', NFC);
  if n <> 1 then raise exception 'case «Орагийн нэмэлт хэрэглэгч хэд вэ?» was not updated'; end if;
  select count(*) into n from reply_cases where tenant_id = tid and active and normalize('Харилцагчийн менежер', NFC) = any(must_include);
  if n <> 2 then raise exception 'expected 2 cases to require «Харилцагчийн менежер», found %', n; end if;
  select count(*) into n from reply_cases where tenant_id = tid and active and note like 'D-172: «what is Дали»%';
  if n <> 2 then raise exception 'expected 2 dali_about cases, found %', n; end if;
end $$;

select d.body from deterministic_replies d join tenants t on t.id = d.tenant_id
 where t.slug = 'dalatech' and d.intent in ('price_overview', 'dali_about') order by d.intent;

commit;
