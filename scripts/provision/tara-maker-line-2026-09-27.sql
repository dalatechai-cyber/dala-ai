-- Tara's maker line drops «.ai» (founder, 2026-09-27): the company is DalaTech now.
--
--   «Намайг DalaTech.ai бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.»
--   → «Намайг DalaTech бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.»
--
-- The line is the `assistant_maker` deterministic reply, and reply case 5 («cmg hen hiisen
-- be») expects it byte for byte, so both change in one transaction: the flaw-loop gate in the
-- production build and in every publish must never see one without the other.
--
-- No republish: deterministic replies are read at request time and are not compiled into the
-- prefix, so `content_hash` and `canned_hash` do not move.
begin;

update deterministic_replies
   set body = 'Намайг DalaTech бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.'
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
   and intent = 'assistant_maker'
   and body = 'Намайг DalaTech.ai бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.';

update reply_cases
   set expected_body = 'Намайг DalaTech бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.'
 where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
   and expected_body = 'Намайг DalaTech.ai бүтээсэн. Салоны талаар хүссэн зүйлээ асуугаарай.';

-- Both or neither.
do $$
begin
  if (select count(*) from deterministic_replies
       where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
         and body like '%DalaTech.ai%') > 0
     or (select count(*) from reply_cases
          where tenant_id = (select id from tenants where slug = 'matrix-eco-salon')
            and expected_body like '%DalaTech.ai%') > 0 then
    raise exception 'a DalaTech.ai maker line is still there; nothing was changed';
  end if;
end $$;

commit;
