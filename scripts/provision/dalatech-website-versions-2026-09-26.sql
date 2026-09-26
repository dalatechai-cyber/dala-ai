-- DalaTech (tenant #0): website wording, and the office answer on both channels (D-140).
--
-- Founder, 2026-09-26: *"On the website channel, Дали never links or refers visitors to
-- dalatech.online itself. On Messenger it still may."* The rule is code and every tenant's
-- (`src/lib/website/ownSite.ts`); these are DalaTech's rows under it.
--
--  1. The follow-up's website version, approved exactly: the Page keeps «👉 Бусад AI
--     ажилтнууд: https://dalatech.online»; the website does not send its visitor there.
--  2. `office_location`: «Бид Улаанбаатарт байрладаг, онлайнаар ажилладаг.» for an office or
--     address question, on both channels, answered from the row before the model. Covers the
--     question only when every word is an office word or a filler around it, so «Имэйл хаяг
--     чинь юу вэ», «Вэбсайтын хаяг» and «Демо хаана үзэх вэ» still go to the model.
--  3. Permanent cases (`reply_cases.channel`, `0056`): the office question on both channels, and
--     the website versions of the general price answer and the office answer.
--
-- Needs 0056. Run AFTER the code that reads `web_body` and `reply_cases.channel` is deployed.
begin;

update sales_next_steps s
   set web_body = normalize(E'🤖 Таны Facebook, Instagram, вэбсайтын зурваст 24/7 хариулна.\n🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online', NFC)
  from tenants t
 where t.id = s.tenant_id and t.slug = 'dalatech' and s.kind = 'follow_up';

insert into deterministic_replies
  (tenant_id, intent, body, enabled, match_mode, stems, cover_words, placement, quote_services, requires_empty_history, provenance)
select t.id, 'office_location',
       normalize('Бид Улаанбаатарт байрладаг, онлайнаар ажилладаг.', NFC),
       true, 'covers_message',
       array['оффис','офис','office','offis','ofis','хаяг','hayag','xayag','байршил','bairshil','байрлал','bairlal',
             'байрладаг','bairladag','address','location','located']::text[],
       array['танай','танайх','tanai','tanaih','хаана','haana','xaana','hana','байдаг','baidag','bdg','байгаа','baigaa','bga',
             'байна','baina','bna','bn','вэ','бэ','ve','be','we','уу','үү','uu','юу','yu','чинь','chini','нь','ni',
             'компани','компаний','kompani','kompaniin','та','нар','ta','nar','ямар','yamar','where','is','your','the','what',
             'are','you']::text[],
       'replace', '{}'::text[], false, 'tenant_confirmed'
  from tenants t where t.slug = 'dalatech'
on conflict (tenant_id, intent) do update
  set body = excluded.body, enabled = true, match_mode = excluded.match_mode, stems = excluded.stems,
      cover_words = excluded.cover_words, placement = excluded.placement, requires_empty_history = false,
      provenance = 'tenant_confirmed';

insert into reply_cases (tenant_id, customer_message, expected_body, must_include, must_not_include, note, active, history, channel)
select t.id, v.msg, null, v.inc, v.exc, v.note, true, '[]'::jsonb, v.channel
  from tenants t,
  (values
    ('Танай оффис хаана байдаг вэ?', 'web',
     array['Бид Улаанбаатарт байрладаг, онлайнаар ажилладаг.']::text[],
     array['https://dalatech.online', 'dalatech.online хуудас', '👉 Бусад AI ажилтнууд']::text[],
     'D-140 founder 2026-09-26, website: the office answer, and nothing sends the visitor to dalatech.online.'),
    ('Танай оффис хаана байдаг вэ?', 'facebook_page',
     array['Бид Улаанбаатарт байрладаг, онлайнаар ажилладаг.']::text[], array[]::text[],
     'D-140 founder 2026-09-26, Page: the office answer.'),
    ('tanai office haana baidag ve', 'web',
     array['Бид Улаанбаатарт байрладаг, онлайнаар ажилладаг.']::text[], array['https://dalatech.online']::text[],
     'D-140: the office answer in Latin letters, website.'),
    ('үнэ хэд вэ', 'web',
     array['💬 Дали — AI хүлээн авагч: сард 250,000₮', '🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online']::text[],
     array['👉 Бусад AI ажилтнууд', 'https://dalatech.online']::text[],
     'D-140 founder 2026-09-26, website: the price layout, then the website follow-up (no link to dalatech.online).'),
    ('үнэ хэд вэ', 'facebook_page',
     array['👉 Бусад AI ажилтнууд: https://dalatech.online']::text[], array[]::text[],
     'D-140: the Page keeps the full follow-up, link included.')
  ) as v(msg, channel, inc, exc, note)
 where t.slug = 'dalatech';

-- Read back.
select kind, web_body from sales_next_steps s join tenants t on t.id = s.tenant_id where t.slug = 'dalatech' and kind = 'follow_up';
select intent, body from deterministic_replies d join tenants t on t.id = d.tenant_id where t.slug = 'dalatech' and intent = 'office_location';
select r.id, r.channel, r.customer_message from reply_cases r join tenants t on t.id = r.tenant_id
 where t.slug = 'dalatech' and r.note like 'D-140%' order by r.id;

commit;
