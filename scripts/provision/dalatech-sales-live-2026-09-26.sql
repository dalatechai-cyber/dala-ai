-- DalaTech (tenant #0): the salesperson goes LIVE (founder, 2026-09-26, D-132).
--
-- *"DalaTech salesperson: go live without waiting for shadow numbers (my Page gets little
-- traffic). Tara stays in shadow until real-traffic numbers."*
--
--  1. The approved follow-up, exactly as the founder wrote it, becomes DalaTech's default next
--     step (`follow_up`). The demo row stops being the default and keeps its intent words: a
--     customer who asks for a demo still gets the approved demo line.
--  2. `small_talk`: greetings and thanks, as whole messages, in the spellings DalaTech's
--     customers use. A message that is only one of these gets no sales line.
--  3. The four active reply cases that expect the price_overview row EXACTLY now expect it
--     followed by the follow-up — that is what a live DalaTech sends for a first price
--     question. Found by their expected body, not by id.
--  4. `mode = 'live'`. Tara is not touched: it stays `shadow`.
--  5. `demo_request`: see below.
--
-- Needs 0054. Run AFTER the code that reads `live` is deployed.
begin;

update sales_next_steps s set is_default = false
  from tenants t where t.id = s.tenant_id and t.slug = 'dalatech' and s.kind = 'demo';

insert into sales_next_steps (tenant_id, kind, body, reviewed_at, link, priority, is_default, intent_matcher, enabled)
select t.id, 'follow_up',
       normalize(E'Дали бол таны бизнесийн Facebook, Instagram, вэбсайтад ирсэн зурваст 24/7 хариулдаг AI ажилтан.\nҮнэгүй демо вэбсайт авахыг хүсвэл: https://app.dalatech.online — 24 цагийн дотор бэлэн болно.\nМанай бусад AI ажилтнуудтай https://dalatech.online дээр танилцаарай, эсвэл асуух зүйлээ энд бичээрэй.', NFC),
       now(), 'https://app.dalatech.online', 50, true, null, true
  from tenants t where t.slug = 'dalatech'
on conflict (tenant_id, kind) do update
  set body = excluded.body, reviewed_at = excluded.reviewed_at, link = excluded.link,
      priority = excluded.priority, is_default = true, intent_matcher = null, enabled = true;

update sales_playbooks p set small_talk = array['сайн байна уу','сайн уу','сайн бна уу','сайн бну','сн бну','сайн байцгаана уу','оройн мэнд','өглөөний мэнд','sain baina uu','sain bnuu','sain bnu','sn bnu','sainuu','hi','hii','hello','hey','баярлалаа','их баярлалаа','за баярлалаа','баярлалаа танд','bayarlalaa','bayrlalaa','bayarllaa','bayrllaa','ih bayarlalaa','za bayarlalaa','thanks','thank you','thx','ok thanks']::text[], mode = 'live', updated_at = now()
  from tenants t where t.id = p.tenant_id and t.slug = 'dalatech';

update reply_cases r
   set expected_body = r.expected_body || E'\n\n' || f.body
  from tenants t, sales_next_steps f, deterministic_replies d
 where t.id = r.tenant_id and t.slug = 'dalatech' and r.active
   and f.tenant_id = t.id and f.kind = 'follow_up'
   and d.tenant_id = t.id and d.intent = 'price_overview'
   and r.expected_body = d.body
   and jsonb_array_length(r.history) = 0;

-- 5. A request for a demo, and nothing else («Демо үзмээр байна», «turshij uzej boloh uu»),
--    gets the approved demo line itself, with no model call: a `covers_message` row, so every
--    word must be a demo word or one of the filler words below. A question ABOUT the demo
--    («Демо хэдэн цагт бэлэн болох вэ?») still goes to the model, and the demo line follows it
--    as the intent step unless the answer already gave the link.
insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words,
                                   placement, quote_services, requires_empty_history, provenance)
select t.id, 'demo_request', s.body, true, 'covers_message',
       array['демо','demo','турши','turshi','туршилт','turshilt']::text[],
       array['үзмээр','үзэх','үзье','үзэж','үзэхийг','хүсэж','хүсч','хүсэн','авмаар','авах','авъя','авч','хийлгэх','хийлгэмээр','захиалах','захиалъя','захиалмаар','боломж','боломжтой','бий','байна','байгаа','байдаг','уу','үү','юу','вэ','бэ','болох','болно','хэрэгтэй','үнэгүй','надад','бид','би','манайд','манай','нэг','хувилбар','uzmeer','uzeh','uzye','uzie','uzej','uzeh','huseh','husej','husch','avmaar','avah','avya','avii','avch','hiilgeh','zahialah','zahialya','zahialmaar','bolomj','bolomjtoi','bii','baina','bna','bga','baigaa','uu','yu','ve','be','boloh','bolno','heregtei','unegui','nadad','bi','manaid','manai','neg','huvilbar','please']::text[],
       'replace', '{}'::text[], false, 'tenant_confirmed'
  from tenants t join sales_next_steps s on s.tenant_id = t.id and s.kind = 'demo' and s.reviewed_at is not null
 where t.slug = 'dalatech'
   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'demo_request');

do $$ begin
  if (select mode from sales_playbooks p join tenants t on t.id = p.tenant_id where t.slug = 'dalatech') <> 'live' then
    raise exception 'DalaTech is not live';
  end if;
  if (select mode from sales_playbooks p join tenants t on t.id = p.tenant_id where t.slug = 'matrix-eco-salon') = 'live' then
    raise exception 'Tara must stay in shadow';
  end if;
  if (select count(*) from sales_next_steps s join tenants t on t.id = s.tenant_id
       where t.slug = 'dalatech' and s.is_default and s.kind = 'follow_up' and s.reviewed_at is not null) <> 1 then
    raise exception 'the follow-up is not the reviewed default';
  end if;
end $$;

commit;
