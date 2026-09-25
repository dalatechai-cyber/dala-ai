-- The founder approved the sales next-step wording (D-127), exactly as drafted in
-- prompt/drafts/sales_next_step_{dalatech,tara}.mn.txt. Everything stays in SHADOW: the mode
-- has no live value, so these bodies are recorded as `reviewed` by the shadow and sent by
-- nothing.
--
--  DalaTech: demo A, callback A, lead_thanks A.
--  Tara: booking B («Цаг захиалах бол: » + the approved booking_line, read from its row so
--        the two cannot drift), callback A and lead_thanks A approved but DISABLED until the
--        founder confirms the salon calls back from the inbox label, so Tara's next step is
--        booking only. The related-service step and every service pairing are removed: Tara
--        does not recommend specific services.
begin;

update sales_next_steps set body = 'Өөрийн бизнест зориулсан демог https://app.dalatech.online хаягаар захиалж болно. Эсвэл нэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.', reviewed_at = now()
 where tenant_id = (select id from tenants where slug = 'dalatech') and kind = 'demo';
update sales_next_steps set body = 'Нэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.', reviewed_at = now()
 where tenant_id = (select id from tenants where slug = 'dalatech') and kind = 'callback';
update sales_next_steps set body = 'Баярлалаа! Мэдээллийг тань хүлээн авлаа. Хамт олон маань тантай холбогдоно.', reviewed_at = now()
 where tenant_id = (select id from tenants where slug = 'dalatech') and kind = 'lead_thanks';

update sales_next_steps s set body = 'Цаг захиалах бол: ' || c.body, reviewed_at = now()
  from canned_responses c
 where s.tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and s.kind = 'booking'
   and c.tenant_id = s.tenant_id and c.kind = 'booking_line' and c.reviewed_at is not null;
update sales_next_steps set body = 'Утасны дугаараа энд үлдээвэл салоноос Тан руу залгана.', reviewed_at = now(), enabled = false
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and kind = 'callback';
update sales_next_steps set body = 'Баярлалаа! Дугаарыг тань салонд дамжууллаа. Манай ажилтан Тан руу залгана.', reviewed_at = now(), enabled = false
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and kind = 'lead_thanks';
delete from sales_next_steps
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon') and kind = 'related_service';
delete from service_pairings
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon');

commit;
