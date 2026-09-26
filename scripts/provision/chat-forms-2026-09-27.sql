-- Founder, 2026-09-27. Run AFTER the deploy that carries `mn/chat.ts` (D-147): the reply cases
-- below are answered by it, and the production build's reply-case gate checks them.
--
-- 1. Tara's salesperson stays in SHADOW, with the same kind of greeting/thanks list as
--    DalaTech (sales_playbooks.small_talk): the list is copied from DalaTech's row, so the two
--    cannot drift apart by transcription. It is matcher data, not a sentence a customer reads.
-- 2. Permanent no-model reply cases for the Latin and shorthand greetings the founder named.
--    Each expected reply is READ from the tenant's own greeting / thanks row, never typed here,
--    so a reworded row moves its case with it.
begin;

update sales_playbooks
   set small_talk = (select small_talk from sales_playbooks
                      where tenant_id = (select id from tenants where slug = 'dalatech'))
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
   and mode = 'shadow';

insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, m.msg, d.body, 'D-147: Latin/shorthand greeting answered by the greeting row, no model (founder 2026-09-27; live «bnu» 2026-09-26 18:05 got «ойлгосонгүй»)'
  from tenants t
  join deterministic_replies d on d.tenant_id = t.id and d.intent = 'greeting' and d.enabled
  cross join (values ('bnu'), ('sn bnuu'), ('sain bnu uu'), ('байна уу')) as m(msg)
 where t.slug in ('matrix-eco-salon', 'dalatech')
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = m.msg and r.active);

insert into reply_cases (tenant_id, customer_message, expected_body, note)
select t.id, m.msg, d.body, 'D-147: Latin thanks answered by the thanks row, no model (founder 2026-09-27)'
  from tenants t
  join deterministic_replies d on d.tenant_id = t.id and d.intent = 'thanks' and d.enabled
  cross join (values ('bayrlalaa'), ('ih bayrlalaa')) as m(msg)
 where t.slug = 'dalatech'
   and not exists (select 1 from reply_cases r where r.tenant_id = t.id and r.customer_message = m.msg and r.active);

commit;
