-- The founder's decisions of 2026-09-25 (evening), as rows. Applied the same evening.
--
--  2. Only Дали is built. Вира, Эхо, Нова and Ора are coming soon with pre-registration.
--     The live data had marked Вира ИДЭВХТЭЙ in two places; both are corrected here with the
--     wording the rows already use for the other three — no new sentence. The price_overview
--     row goes live at once (deterministic rows are read per request), so reply case 9,
--     which expects it exactly, moves in the same transaction; the knowledge documents reach
--     the model at the next republish of tenant #0.
--  3. app.dalatech.online is a contact point (`demo_url`, 0052).
--  4. Tara's leads go to a Page inbox label (the salon does not use Telegram).
--  5. The Pages' Meta automation texts, confirmed by the founder, so none counts as a person.
--     Tara has no Instagram channel row, so its Instagram away message is stored on the
--     Messenger channel; copy it to an Instagram channel when one is connected.
begin;

-- 2. Вира is coming soon, not active.
update knowledge_documents
   set title = 'Вира — Бизнес аналитик (УДАХГҮЙ, урьдчилан бүртгэл авч байна)', updated_at = now()
 where tenant_id = (select id from tenants where slug = 'dalatech')
   and title = 'Вира — Бизнес аналитик (ИДЭВХТЭЙ)';

update knowledge_documents
   set body = replace(body, '- Эхо, Нова, Ора хараахан ажиллаж эхлээгүй; урьдчилан бүртгүүлж болно.',
                            '- Вира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй; урьдчилан бүртгүүлж болно.'),
       updated_at = now()
 where tenant_id = (select id from tenants where slug = 'dalatech')
   and title = 'Таван AI ажилтан — нийтлэг'
   and strpos(body, '- Эхо, Нова, Ора хараахан ажиллаж эхлээгүй; урьдчилан бүртгүүлж болно.') > 0;

update deterministic_replies
   set body = replace(body, 'Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд', 'Вира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд')
 where tenant_id = (select id from tenants where slug = 'dalatech')
   and intent = 'price_overview'
   and strpos(body, 'Вира, Эхо, Нова, Ора') = 0;

update reply_cases
   set expected_body = replace(expected_body, 'Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд', 'Вира, Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд')
 where tenant_id = (select id from tenants where slug = 'dalatech')
   and strpos(expected_body, 'Эхо, Нова, Ора хараахан ажиллаж эхлээгүй бөгөөд') > 0
   and strpos(expected_body, 'Вира, Эхо, Нова, Ора') = 0;

-- 2b. A question about a coming-soon staff member gets the pre-registration step (leave a
--     name and number: the call-back row), never the demo — a demo would sell as available
--     what is not built. The names are DalaTech's products, so this is DalaTech's row, not the
--     software template. «Эхо» and «Ора» are shorter than MIN_STEM_CHARS, so they are whole
--     words with their common case forms; «Вира», «Нова» and the Latin spellings are stems.
update sales_next_steps
   set intent_matcher = intent_matcher || $m$[
     {"mode":"contains_stem","stems":["вира","vira","веда","veda","нова","nova","echo"]},
     {"mode":"has_word","words":["эхо","эхог","эхогийн","эхоор","eho","ehog","ehogiin","ehoor","ора","ораг","орагийн","ораар","ora","orag","oragiin","oraar"]}
   ]$m$::jsonb
 where tenant_id = (select id from tenants where slug = 'dalatech') and kind = 'callback'
   and not intent_matcher @> '[{"mode":"contains_stem","stems":["вира"]}]'::jsonb;

-- 3. The demo page.
insert into contact_points (tenant_id, kind, value, is_escalation)
select id, 'demo_url', 'https://app.dalatech.online', false from tenants where slug = 'dalatech'
on conflict (tenant_id, kind) do update set value = excluded.value;

-- 4. Tara's leads: a Page inbox label.
update sales_playbooks set lead_route = 'page_label', updated_at = now()
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon');

-- 5. Automation texts, exactly as the founder confirmed them.
update tenant_channels
   set automation_texts = array[
     'sn bnuu',
     'chat bicnuu',
     'Sent you a message!',
     'Сайн байна уу? DalaTech.ai-тэй холбогдсонд баярлалаа. Бид таны зурвасыг хүлээн авлаа. Танд ямар тусламж хэрэгтэй байна вэ? Бид удахгүй хариулах болно.'
   ]
 where tenant_id = (select id from tenants where slug = 'dalatech') and provider = 'facebook_page';

update tenant_channels
   set automation_texts = array[
     -- Meta's default away message, as the founder pasted it and with the typographic
     -- apostrophe Meta may deliver instead: the match is exact, so both spellings are rows.
     'Thanks for your message. We''re away and can''t respond right now. We appreciate you reaching out.',
     'Thanks for your message. We’re away and can’t respond right now. We appreciate you reaching out.'
   ]
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and provider = 'facebook_page';

commit;
