-- The salesperson's shadow, for one tenant, since a date: what it would have done, turn by
-- turn, beside the customer's message and the reply it would have been added to. Read-only.
--   \set slug 'matrix-eco-salon'  \set since '2026-09-27'
select q.at, q.detail->>'verdict' as verdict, coalesce(q.detail->>'kind', q.detail->>'reason') as kind_or_reason,
       m.body as customer, left(o.body, 160) as reply, o.state
  from quality_flags q
  left join messages m on m.id = q.message_id
  left join outbound_messages o on o.id::text = q.detail->>'outbound_id'
 where q.tenant_id = (select id from tenants where slug = :'slug')
   and q.flag = 'sales_next_step_shadow' and q.at >= :'since'::timestamptz
 order by q.at;

select q.detail->>'verdict' as verdict, coalesce(q.detail->>'kind', q.detail->>'reason') as kind_or_reason,
       count(*) as turns, count(distinct q.conversation_id) as conversations
  from quality_flags q
 where q.tenant_id = (select id from tenants where slug = :'slug')
   and q.flag = 'sales_next_step_shadow' and q.at >= :'since'::timestamptz
 group by 1, 2 order by 3 desc;
