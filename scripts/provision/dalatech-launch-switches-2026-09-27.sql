-- DalaTech (tenant #0): one launch switch per AI staff member (D-154, founder 2026-09-27).
--
-- Founder: *"When a staff member is ready I flip ITS switch, and the website AND Дали's chat
-- answers change to live together, with no code or copy edits. While a switch is off, that
-- staff member appears exactly as today («Удахгүй», pre-registration). Дали must never claim
-- a staff member works before its switch is on."* And: *"Дали's description of Нова must never
-- mention «ТИЙМ/ҮГҮЙ». Use the site's approved wording."*
--
-- RUN ONLY AFTER: `0063` is pushed and the code is deployed (D-058), AND the founder has
-- approved every new Mongolian line below in the PR. Then publish in the same sitting:
-- between this script and the publish, the conditioned rows are withheld.
--
-- WHAT IT DOES
--  1. The switches: Вира, Эхо, Нова, Ора → `preregistration`. Дали and the website stay `live`.
--     Nothing a customer reads changes until the next publish freezes them.
--  2. KB: each of the four gets its pre-registration document (today's, now conditioned, with
--     the site's approved one-line description and no «ТИЙМ/ҮГҮЙ») and a live document
--     (DRAFT). The shared document no longer says the four are not working: each document's
--     title carries the state.
--  3. Fixed replies: `nova_about` is conditioned and reworded (approved line); `nova_about_live`
--     (DRAFT) answers the same questions once Нова is live. `price_overview`,
--     `coming_soon_status` and `coming_soon_in_reply` become templates whose pieces follow the
--     switches: with all four off they produce TODAY'S TEXT byte for byte (the exact reply cases 9, 15, 16, 17, 19 and 41 prove it at
--     publish).
--  4. Reply cases: today's cases that describe the four as coming soon are conditioned on
--     that; the four staff-claim strings are moved out of the generic must-not lists into
--     one dedicated case per staff member per state; live cases are added (DRAFT answers).
--
-- Undo, before or after a publish: `dalatech-launch-switches-2026-09-27-revert.sql` restores
-- every row this script changes to today's text (then publish again).
--
-- Flip a switch afterwards with the publish command, never by hand:
--   node scripts/publish/tenant.ts --slug dalatech --launch "Вира — маркетинг менежер=live"
begin;
create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
create temp table sv on commit drop as
  select s.id, split_part(s.name, ' — ', 1) as short, s.name from services s, dt where s.tenant_id = dt.id;

do $$ begin
  if (select count(*) from sv where short in ('Вира', 'Эхо', 'Нова', 'Ора', 'Дали')) <> 5 then
    raise exception 'expected the five staff services by name';
  end if;
end $$;

-- The rows this script rewrites must be exactly the ones it was written against (today's
-- bodies, one row each). Anything else stops the run before a byte changes.
do $$ begin
  if (select count(*) from deterministic_replies d join tenants t on t.id = d.tenant_id
       where t.slug = 'dalatech' and d.intent in ('price_overview', 'coming_soon_status', 'coming_soon_in_reply', 'nova_about')) <> 4 then
    raise exception 'expected the four fixed replies this script rewrites';
  end if;
  if exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
              where t.slug = 'dalatech' and (
                (d.intent = 'price_overview' and d.body <> normalize('💬 Дали — AI хүлээн авагч: сард 250,000₮ (суурилуулалт 50,000₮)
🌐 Ухаалаг вэбсайт: 750,000₮
🎁 Вэбсайт + Дали багц: 800,000₮
⏳ Удахгүй: Вира сард 350,000₮, Нова сард 150,000₮, Ора сард 250,000₮, Эхо — урьдчилан бүртгэл авч байна', NFC)) or
                (d.intent in ('coming_soon_status', 'coming_soon_in_reply') and d.body <> normalize('Вира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно.', NFC)) or
                (d.intent = 'nova_about' and d.body <> normalize('Нова бол цаг захиалгын сануулгыг SMS-ээр илгээж, ТИЙМ/ҮГҮЙ хариуг хүлээн авдаг AI ажилтан. Одоогоор урьдчилан бүртгэл авч байна.', NFC)))) then
    raise exception 'a fixed reply is not the text this script was written against; re-read it before running';
  end if;
end $$;

-- 1. The switches -------------------------------------------------------------------------
update services s set launch_state = 'preregistration'
  from dt, sv where s.tenant_id = dt.id and s.id = sv.id and sv.short in ('Вира', 'Эхо', 'Нова', 'Ора');

-- 2. Knowledge base -------------------------------------------------------------------------
-- The approved one-line descriptions (founder, 2026-09-27: «Use the site's approved wording»).
create temp table ln on commit drop as select * from (values
  ('Вира', 'Пост бодох ажлаас таныг чөлөөлнө: сар бүр 3 богино видео, 8 пост, сурталчилгаа (boost) удирдлага.'),
  ('Нова', 'Цагийн сануулгыг танай дугаараас SMS-ээр автоматаар илгээж, ирэхээ мартах харилцагчийг цөөлнө.'),
  ('Эхо', 'Хаах цагийн дараа ч, ачаалалтай үед ч дуудлага бүрт хариулж, захиалгыг бүртгэнэ.'),
  ('Ора', 'Таны ширээн дээр хуримтлагддаг ажлыг хариуцна: гэрээ, албан бичиг боловсруулж, танилцуулга бэлтгэж, хугацааг сануулж, англи бичгийг орчуулж, шийдвэрийг хамт тунгаана. Зөвхөн тантай ажиллана.')
) v(short, line);

-- What each document says about the work, the same in both states. Ора's is today's list.
create temp table work on commit drop as
select 'Вира' as short, E'- Багцад мөн контент төлөвлөгөө, 7 хоног тутмын тайлан багтана. Сурталчилгааны төсөв ороогүй.' as body
union all select 'Нова', E'- Сард 1,000 SMS багтсан, нэмэлт SMS тутам 50₮.'
union all select 'Эхо', E'- Утсаар хүнтэй адил ярьж, асуултад хариулна.\n- Үнийг хараахан зарлаагүй.'
union all select 'Ора', (select k.body from knowledge_documents k, dt where k.tenant_id = dt.id
                          and k.title = normalize('Ора — хувийн туслах (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', NFC));

do $$ begin
  if (select count(*) from work where body is not null) <> 4 then raise exception 'Ора''s document not found'; end if;
end $$;

-- Pre-registration: today's documents, conditioned, reworded.
update knowledge_documents k set
  body = normalize('- ' || ln.line || E'\n' || w.body || E'\n- Одоогоор урьдчилан бүртгэл авч байна.', NFC),
  when_service_id = sv.id, when_launch_state = 'preregistration', updated_at = now()
  from dt, sv, ln, work w
 where k.tenant_id = dt.id and sv.short = ln.short and w.short = ln.short
   and k.title = normalize(sv.name || ' (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', NFC);

-- Live (DRAFT for the founder's approval).
insert into knowledge_documents (tenant_id, title, body, source, when_service_id, when_launch_state)
select dt.id,
       normalize(sv.name || ' (ИДЭВХТЭЙ, одоо ажиллаж байна)', NFC),
       normalize('- ' || ln.line || E'\n' || w.body || E'\n'
         || '- Одоо ажиллаж байна. Эхлүүлэхийн тулд нэр, утасны дугаараа үлдээвэл манай ажилтан холбогдож тохиргоог хийнэ; '
         || 'ихэвчлэн 1–2 долоо хоногийн дотор ажиллаж эхэлдэг.', NFC),
       'D-154', sv.id, 'live'
  from dt, sv, ln, work w
 where sv.short = ln.short and w.short = ln.short
   and not exists (select 1 from knowledge_documents k where k.tenant_id = dt.id
                    and k.title = normalize(sv.name || ' (ИДЭВХТЭЙ, одоо ажиллаж байна)', NFC));

update knowledge_documents k set
  body = normalize(replace(k.body,
    '- Вира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй; урьдчилан бүртгүүлж болно.',
    '- Ажилтан бүрийн гарчигт ИДЭВХТЭЙ эсвэл УДАХГҮЙ гэж бичсэн. УДАХГҮЙ ажилтныг ажиллаж байна гэж хэлэхгүй: урьдчилан бүртгэл авч байна гэж хэлнэ.'), NFC),
  updated_at = now()
  from dt where k.tenant_id = dt.id and k.title = normalize('Таван AI ажилтан — нийтлэг', NFC);

-- 3. Fixed replies --------------------------------------------------------------------------
-- Нова: the approved description in both states; never «ТИЙМ/ҮГҮЙ».
update deterministic_replies d set
  body = normalize('Нова цагийн сануулгыг танай дугаараас SMS-ээр автоматаар илгээж, ирэхээ мартах харилцагчийг цөөлнө. Одоогоор урьдчилан бүртгэл авч байна.', NFC),
  when_service_id = (select id from sv where short = 'Нова'), when_launch_state = 'preregistration'
  from dt where d.tenant_id = dt.id and d.intent = 'nova_about';

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words, placement,
  quote_services, requires_empty_history, provenance, matcher, when_service_id, when_launch_state)
select d.tenant_id, 'nova_about_live',
       normalize('Нова цагийн сануулгыг танай дугаараас SMS-ээр автоматаар илгээж, ирэхээ мартах харилцагчийг цөөлнө. Сарын төлбөр 150,000₮ (1,000 SMS багтсан), суурилуулалт 50,000₮.', NFC),
       d.enabled, d.match_mode, d.stems, d.cover_words, d.placement, d.quote_services, d.requires_empty_history,
       d.provenance, d.matcher, (select id from sv where short = 'Нова'), 'live'
  from deterministic_replies d, dt
 where d.tenant_id = dt.id and d.intent = 'nova_about'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = dt.id and x.intent = 'nova_about_live');

-- The price overview. All four off: today's text exactly (asserted at the end).
update deterministic_replies d set
  body = normalize(E'💬 Дали — AI хүлээн авагч: сард 250,000₮ (суурилуулалт 50,000₮)\n{{live}}\n🌐 Ухаалаг вэбсайт: 750,000₮\n🎁 Вэбсайт + Дали багц: 800,000₮\n⏳ Удахгүй: {{soon}}', NFC),
  items = jsonb_build_array(
    jsonb_build_object('slot', 'live', 'service_id', (select id from sv where short = 'Вира'), 'state', 'live',
      'body', normalize('💬 Вира — маркетинг менежер: сард 350,000₮ (суурилуулалт 50,000₮)', NFC)),
    jsonb_build_object('slot', 'live', 'service_id', (select id from sv where short = 'Нова'), 'state', 'live',
      'body', normalize('💬 Нова — сануулга, SMS: сард 150,000₮ (суурилуулалт 50,000₮)', NFC)),
    jsonb_build_object('slot', 'live', 'service_id', (select id from sv where short = 'Ора'), 'state', 'live',
      'body', normalize('💬 Ора — хувийн туслах: сард 250,000₮ (суурилуулалт 50,000₮)', NFC)),
    jsonb_build_object('slot', 'live', 'service_id', (select id from sv where short = 'Эхо'), 'state', 'live',
      'body', normalize('💬 Эхо — утасны оператор: үнийг хараахан зарлаагүй', NFC)),
    jsonb_build_object('slot', 'soon', 'service_id', (select id from sv where short = 'Вира'), 'state', 'preregistration',
      'body', normalize('Вира сард 350,000₮', NFC)),
    jsonb_build_object('slot', 'soon', 'service_id', (select id from sv where short = 'Нова'), 'state', 'preregistration',
      'body', normalize('Нова сард 150,000₮', NFC)),
    jsonb_build_object('slot', 'soon', 'service_id', (select id from sv where short = 'Ора'), 'state', 'preregistration',
      'body', normalize('Ора сард 250,000₮', NFC)),
    jsonb_build_object('slot', 'soon', 'service_id', (select id from sv where short = 'Эхо'), 'state', 'preregistration',
      'body', normalize('Эхо — урьдчилан бүртгэл авч байна', NFC)))
  from dt where d.tenant_id = dt.id and d.intent = 'price_overview';

-- The words that name each of the four, as today's two coming-soon rows list them.
create temp table nm on commit drop as select * from (values
  ('Вира', 1, array['вира','вираг','вирагийн','вирад','вираас'], array['веда','vira','virag','viragiin','veda']),
  ('Эхо',  2, array['эхо','эхог','эхогийн','эхоор','эхоос'], array['eho','echo','ehog','ehogiin','ehoor']),
  ('Нова', 3, array['нова','новаг','новагийн','новад','новаас'], array['nova','novag','novagiin']),
  ('Ора',  4, array['ора','ораг','орагийн','ораар','ораас'], array['ora','orag','oragiin'])
) v(short, ord, cyr, lat);

create temp table pre_words on commit drop as select * from (values
  ('урьдчилан бүртгэл'), ('урьдчилан бүртгэлд'), ('урьдчилан бүртгүүлж'), ('урьдчилан бүртгүүлэх'), ('урьдчилан бүртгүүлнэ')) v(w);

-- «Вира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй…» names only the ones still coming soon,
-- and fires only on a name of one of them (the customer's words, or the reply's).
update deterministic_replies d set
  body = normalize('{{soon}} хараахан ажиллаж эхлээгүй бөгөөд урьдчилан бүртгүүлж болно.', NFC),
  matcher = jsonb_build_object('mode', 'all_of', 'matchers', jsonb_build_array(
    case when d.intent = 'coming_soon_in_reply'
         then jsonb_build_object('mode', 'in_reply', 'matcher', jsonb_build_object('mode', 'item_words'))
         else jsonb_build_object('mode', 'item_words') end,
    jsonb_build_object('mode', 'not', 'matcher', jsonb_build_object('mode', 'in_reply', 'matcher',
      jsonb_build_object('mode', 'has_word', 'words', (select jsonb_agg(w) from pre_words)))))),
  items = (select jsonb_agg(jsonb_build_object('slot', 'soon', 'service_id', sv.id, 'state', 'preregistration',
             'body', nm.short,
             'words', to_jsonb(case when d.intent = 'coming_soon_in_reply' then nm.cyr else nm.cyr || nm.lat end))
             order by nm.ord)
           from nm join sv on sv.short = nm.short)
  from dt where d.tenant_id = dt.id and d.intent in ('coming_soon_status', 'coming_soon_in_reply');

-- 4. Reply cases ----------------------------------------------------------------------------
create temp table pre4 on commit drop as
  select jsonb_agg(jsonb_build_object('service_id', id, 'state', 'preregistration') order by short) as j
    from sv where short in ('Вира', 'Эхо', 'Нова', 'Ора');
create temp table live4 on commit drop as
  select jsonb_agg(jsonb_build_object('service_id', id, 'state', 'live') order by short) as j
    from sv where short in ('Вира', 'Эхо', 'Нова', 'Ора');
create or replace function pg_temp.one(s text, st text) returns jsonb language sql as
  $f$ select jsonb_build_array(jsonb_build_object('service_id', (select id from sv where short = s), 'state', st)) $f$;

-- Today's cases, each tied to the states it describes. Matched by id AND text, so a case that
-- is not what this script thinks it is stops the run instead of being conditioned wrongly.
create temp table cond on commit drop as select * from (values
  (9,   'үнэ хэд вэ', 'all'), (15, 'une hed ve', 'all'), (16, 'Сайн байна уу, үнэ ямар байдаг вэ?', 'all'),
  (17,  'How much?', 'all'), (19, 'tanaih yamar unetei ve', 'all'), (41, 'үнэ хэд вэ', 'all'),
  (28,  'Аль ажилтан чинь одоо ажиллаж байгаа вэ?', 'all'),
  (48,  'Вирагийн үнэ хэд вэ?', 'Вира'), (29, 'Утсаар ярьдаг AI ажилтан байгаа юу?', 'Эхо'),
  (79,  'Эхогийн үнэ хэд вэ?', 'Эхо'),
  (103, 'Нова юу хийдэг вэ?', 'Нова'), (104, 'Нова гэж юу вэ?', 'Нова'), (105, 'nova yu hiideg ve', 'Нова')
) v(id, msg, who);

do $$ declare n int; begin
  select count(*) into n from cond c join reply_cases r on r.id = c.id join dt on r.tenant_id = dt.id
   where r.customer_message = normalize(c.msg, NFC);
  if n <> (select count(*) from cond) then raise exception 'reply cases are not the ones this script expects (% of %)', n, (select count(*) from cond); end if;
end $$;

update reply_cases r set when_launch = case when c.who = 'all' then (select j from pre4) else pg_temp.one(c.who, 'preregistration') end
  from cond c, dt where r.id = c.id and r.tenant_id = dt.id;

-- Нова's description, in the approved words, then the callback line the gate already adds.
update reply_cases r set expected_body = normalize(
    'Нова цагийн сануулгыг танай дугаараас SMS-ээр автоматаар илгээж, ирэхээ мартах харилцагчийг цөөлнө. Одоогоор урьдчилан бүртгэл авч байна.'
    || E'\n\nНэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.', NFC)
  from dt where r.tenant_id = dt.id and r.id in (103, 104, 105);

-- «X одоо ажиллаж байна» is false only while X is coming soon. The generic lists lose those
-- sixteen strings; a case per staff member per state carries the check instead.
create temp table claims on commit drop as
  select nm.short, c.tail, nm.short || ' ' || c.tail as s
    from nm, (values ('одоо ажиллаж байна'), ('одоо ажиллаж байгаа'), ('идэвхтэй ажиллаж байна'), ('идэвхтэй байна')) c(tail);
update reply_cases r set must_not_include = array(select x from unnest(r.must_not_include) x
                                                   where normalize(x, NFC) not in (select normalize(s, NFC) from claims))
  from dt where r.tenant_id = dt.id and r.must_not_include && (select array_agg(normalize(s, NFC)) from claims);

insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active, when_launch)
select dt.id, 'facebook_page', normalize(x.m, NFC), x.exp, x.inc, x.nots, 'D-154 founder 2026-09-27: ' || x.n, true, x.w
  from dt, (
    -- coming soon: never claimed to work (model)
    select sv.short || ' одоо ажиллаж байгаа юу?' as m, null::text as exp, array['урьдчилан'] as inc,
           (select array_agg(s) from claims c where c.short = sv.short) as nots,
           sv.short || ' coming soon: never claimed to work' as n, pg_temp.one(sv.short, 'preregistration') as w
      from sv where sv.short in ('Вира', 'Эхо', 'Нова', 'Ора')
    union all
    -- live: never still called coming soon (model)
    select sv.short || ' одоо ажиллаж байгаа юу?', null, array[sv.short],
           array['урьдчилан бүртгэл', 'хараахан ажиллаж эхлээгүй'],
           sv.short || ' live: never called coming soon', pg_temp.one(sv.short, 'live')
      from sv where sv.short in ('Вира', 'Эхо', 'Нова', 'Ора')
    union all
    select 'Вирагийн үнэ хэд вэ?', null, array['350,000'], array['урьдчилан бүртгэл', 'хараахан ажиллаж эхлээгүй'],
           'Вира live: her price, no pre-registration', pg_temp.one('Вира', 'live')
    union all
    select 'Утсаар ярьдаг AI ажилтан байгаа юу?', null, array['Эхо'], array['урьдчилан бүртгэл', 'хараахан ажиллаж эхлээгүй'],
           'Эхо live: the phone operator, working', pg_temp.one('Эхо', 'live')
    union all
    select 'Аль ажилтан чинь одоо ажиллаж байгаа вэ?', null, array['Дали', 'Вира', 'Эхо', 'Нова', 'Ора'],
           array['урьдчилан бүртгэл', 'хараахан ажиллаж эхлээгүй'], 'all live: all five working', (select j from live4)
    union all
    -- exact: Нова's live description, then the callback line
    select 'Нова юу хийдэг вэ?', normalize(
             'Нова цагийн сануулгыг танай дугаараас SMS-ээр автоматаар илгээж, ирэхээ мартах харилцагчийг цөөлнө. Сарын төлбөр 150,000₮ (1,000 SMS багтсан), суурилуулалт 50,000₮.'
             || E'\n\nНэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.', NFC),
           array[]::text[], array[]::text[], 'Нова live: nova_about_live, exact', pg_temp.one('Нова', 'live')
    union all
    -- exact: the price overview with all four live, then the Page's follow-up
    select 'үнэ хэд вэ', normalize(
             E'💬 Дали — AI хүлээн авагч: сард 250,000₮ (суурилуулалт 50,000₮)\n'
             || E'💬 Вира — маркетинг менежер: сард 350,000₮ (суурилуулалт 50,000₮)\n'
             || E'💬 Нова — сануулга, SMS: сард 150,000₮ (суурилуулалт 50,000₮)\n'
             || E'💬 Ора — хувийн туслах: сард 250,000₮ (суурилуулалт 50,000₮)\n'
             || E'💬 Эхо — утасны оператор: үнийг хараахан зарлаагүй\n'
             || E'🌐 Ухаалаг вэбсайт: 750,000₮\n🎁 Вэбсайт + Дали багц: 800,000₮\n\n'
             || E'🤖 Таны Facebook, Instagram, вэбсайтын зурваст 24/7 хариулна.\n'
             || E'🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online\n'
             || '👉 Бусад AI ажилтнууд: https://dalatech.online', NFC),
           array[]::text[], array[]::text[], 'all live: price_overview, exact', (select j from live4)
  ) x(m, exp, inc, nots, n, w)
 where not exists (select 1 from reply_cases r where r.tenant_id = dt.id and r.note = 'D-154 founder 2026-09-27: ' || x.n);

-- Assertions ----------------------------------------------------------------------------------
do $$ declare n int; begin
  select count(*) into n from services s join tenants t on t.id = s.tenant_id
   where t.slug = 'dalatech' and s.launch_state = 'preregistration';
  if n <> 4 then raise exception 'expected 4 services in preregistration, found %', n; end if;
  select count(*) into n from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'dalatech' and k.when_service_id is not null;
  if n <> 8 then raise exception 'expected 8 conditioned documents, found %', n; end if;
  if exists (select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
              where t.slug = 'dalatech' and (k.body like '%ТИЙМ/ҮГҮЙ%' or k.body like '%хараахан ажиллаж эхлээгүй%')) then
    raise exception 'a document still says ТИЙМ/ҮГҮЙ or that the four are not working';
  end if;
  if exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id
              where t.slug = 'dalatech' and (d.body like '%ТИЙМ/ҮГҮЙ%' or d.items::text like '%ТИЙМ/ҮГҮЙ%')) then
    raise exception 'a fixed reply still says ТИЙМ/ҮГҮЙ';
  end if;
  if exists (select 1 from knowledge_documents k join tenants t on t.id = k.tenant_id
              where t.slug = 'dalatech' and k.when_launch_state = 'live'
                and (k.body like '%урьдчилан%' or k.body like '%УДАХГҮЙ%' or k.title like '%УДАХГҮЙ%')) then
    raise exception 'a live document still says pre-registration';
  end if;
  select count(*) into n from reply_cases r join tenants t on t.id = r.tenant_id
   where t.slug = 'dalatech' and r.note like 'D-154 founder 2026-09-27: %';
  if n <> 13 then raise exception 'expected 13 new cases, found %', n; end if;
end $$;
commit;
