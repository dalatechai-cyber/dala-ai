-- DalaTech (tenant #0): the founder's decisions of 2026-09-26 on the test set's open items.
--
--  3. QPAY (founder: "DalaTech clients pay by QPay, and the monthly payments will be collected
--     through QPay. Add it to DalaTech's data so Dali can say so."). A knowledge-base document,
--     which the model reads and words itself — not a FAQ answer, which would be served
--     verbatim. It is in the compiled prefix, so it reaches customers at the next PUBLISH.
--  1. A JOKE GETS THE OFF-TOPIC LINE (t02, «2+2 хэд вэ 😂 чи ухаантай юм уу»). An
--     out-of-scope topic that answers straight from the reviewed refusal_off_topic row with no
--     model call: a laugh (the tenant's own comment-rule laughter words) AND a question, with
--     no word of DalaTech's business in it. «хаха» alone is not a question and still goes to
--     the model; «haha Дали хэд вэ?» names the business and still goes to the model.
--  2. COMING-SOON STAFF IN THE REPLY (s04). The approved price_overview sentence is appended
--     whenever the REPLY names Вира, Эхо, Нова or Ора, prices included — the `in_reply`
--     matcher, which the code of the same PR adds. APPLY THIS ROW ONLY AFTER THAT DEPLOYS:
--     the code before it does not know `in_reply` and skips the row as a bad matcher.
--  4. Complaints keeping «Уучлаарай» is code (the tenant's own complaint rows), no data.
begin;

insert into knowledge_documents (tenant_id, title, body, source)
select t.id, 'Төлбөр',
       E'- Төлбөрийг QPay-ээр хийнэ.\n- Сарын төлбөрийг QPay-ээр авна.',
       'founder 2026-09-26'
from tenants t where t.slug = 'dalatech'
  and not exists (select 1 from knowledge_documents k where k.tenant_id = t.id and k.title = 'Төлбөр');

insert into out_of_scope_topics (tenant_id, topic_key, matcher, decision_question, response_kind,
                                 deterministic_shortcircuit, provenance, quote_price, grounded_only)
select t.id, 'joke_offtopic',
       '{"mode": "all_of", "matchers": [
          {"mode": "has_word", "words": ["хаха", "хахаха", "хэхэ", "хихи", "haha", "hahaha", "hehe", "hihi", "xaxa", "lol", "kkk", "😂", "🤣", "😆", "😅", "😹"]},
          {"mode": "has_word", "words": ["?", "вэ", "бэ", "уу", "үү", "юу", "ve", "be", "uu", "yu"]},
          {"mode": "not", "matcher": {"mode": "has_word", "words": [
             "дали", "dali", "ара", "ara", "вира", "vira", "веда", "veda", "эхо", "eho", "echo", "нова", "nova", "ора", "ora",
             "вэбсайт", "website", "vebsait", "сайт", "site", "багц", "bagts", "үнэ", "une", "үнийн", "price", "төлбөр", "tulbur",
             "хямдрал", "hyamdral", "хөнгөлөлт", "демо", "demo", "ai", "бот", "bot", "робот", "robot", "чатбот", "chatbot",
             "ажилтан", "ajiltan", "qpay", "захиалга", "zahialga", "гэрээ", "geree", "dalatech", "далатек"]}}
        ]}'::jsonb,
       'Сүүлийн мессеж манай үйлчилгээтэй холбоогүй хошигнол, наргиан уу?',
       'refusal_off_topic', true, 'tenant_confirmed', false, false
from tenants t where t.slug = 'dalatech'
on conflict do nothing;

commit;

-- AFTER the deploy (see 2. above):
-- insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, matcher, cover_words,
--                                    placement, quote_services, requires_empty_history, provenance)
-- select t.id, 'coming_soon_in_reply', d.body, true, 'matcher', '{}'::text[],
--        '{"mode": "in_reply", "matcher": {"mode": "has_word", "words": [
--           "вира", "вираг", "вирагийн", "вирад", "вираас", "эхо", "эхог", "эхогийн", "эхоор", "эхоос",
--           "нова", "новаг", "новагийн", "новад", "новаас", "ора", "ораг", "орагийн", "ораар", "ораас"]}}'::jsonb,
--        '{}'::text[], 'append', '{}'::text[], false, 'tenant_confirmed'
-- from tenants t join deterministic_replies d on d.tenant_id = t.id and d.intent = 'coming_soon_status'
-- where t.slug = 'dalatech'
--   and not exists (select 1 from deterministic_replies x where x.tenant_id = t.id and x.intent = 'coming_soon_in_reply');
