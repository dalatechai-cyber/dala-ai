-- NOT APPLIED. Written 2026-09-30 for D-166; the main session applies it after the merge.
--
-- Public comment replies that timed out at 10 s and were parked `indeterminate`, moved to
-- `sent` ONLY where Meta's stored `feed` notice proves the reply was posted. Measured
-- 2026-09-30: 9 of 13 public replies since 27 Sep, all on one tenant, each with exactly one
-- matching notice. This file names no tenant: it reconciles whatever the notices prove.
--
-- A row moves only when ALL of these hold (the same rule as `src/lib/comments/reconcile.ts`):
--   * outbound_messages.kind = 'comment_reply' and state = 'indeterminate' (nothing else);
--   * a stored webhook_events entry of the SAME tenant, whose `id` is the row's channel's Page
--     (tenant_channels.external_id, provider 'facebook_page');
--   * one of its changes is field 'feed', item 'comment', verb 'add', from.id = that Page,
--     parent_id = the row's dedup_key (the customer comment it answers);
--   * the notice's message equals the row's body, both NFC-normalised, ASCII whitespace
--     trimmed at both ends (stricter than the code's `trim()`, never looser);
--   * the notice's created_time is no more than 60 s before the draft (not an older Page
--     comment with the same words).
-- The first such notice (lowest webhook_events.id) supplies provider_message_id.
--
-- Idempotent: a second run finds no `indeterminate` row with a matching notice (they are
-- `sent`), and changes nothing. It never posts anything and never touches a row whose text
-- does not match.
--
-- unit_cost_nanousd = 0 is MESSENGER_SEND_UNIT_COST (`src/config/platform.ts`), what
-- `markSent` writes for a comment reply; `sent_has_a_cost` requires a value.

begin;

-- Verified 2026-09-30 on a scratch PostgreSQL 16 with every migration applied: an exact
-- match and an NFD-plus-newline match moved; other text, another tenant's event, another
-- author, a notice an hour older than the draft and an already-sent row did not; a second run
-- moved nothing (UPDATE 0).

-- 1. What will move (read-only). Expect one row per parked reply Meta's notice proves.
create temporary table d166_candidates on commit drop as
with notices as (
  select e.id as event_id, e.tenant_id, e.raw_payload->>'id' as page_id, ch.value->'value' as v
    from webhook_events e
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(e.raw_payload->'changes') = 'array' then e.raw_payload->'changes' else '[]'::jsonb end
         ) as ch(value)
   where e.raw_payload is not null
     and e.tenant_id is not null
     and ch.value->>'field' = 'feed'
     and ch.value->'value'->>'item' = 'comment'
     and ch.value->'value'->>'verb' = 'add'
     and jsonb_typeof(ch.value->'value'->'message') = 'string'
     and coalesce(ch.value->'value'->>'comment_id', '') <> ''
)
select distinct on (o.id)
       o.id,
       o.tenant_id,
       o.dedup_key,
       n.event_id,
       n.v->>'comment_id' as comment_id,
       case when jsonb_typeof(n.v->'created_time') = 'number'
            then to_timestamp((n.v->>'created_time')::double precision) end as created_at_meta
  from outbound_messages o
  join tenant_channels c
    on c.tenant_id = o.tenant_id and c.id = o.channel_id and c.provider = 'facebook_page'
  join notices n
    on n.tenant_id = o.tenant_id
   and n.page_id = c.external_id
   and n.v->'from'->>'id' = c.external_id
   and n.v->>'parent_id' = o.dedup_key
 where o.kind = 'comment_reply'
   and o.state = 'indeterminate'
   and btrim(normalize(n.v->>'message', NFC), E' \t\n\r') = btrim(normalize(o.body, NFC), E' \t\n\r')
   and (jsonb_typeof(n.v->'created_time') <> 'number'
        or to_timestamp((n.v->>'created_time')::double precision) >= o.created_at - interval '60 seconds')
 order by o.id, n.event_id;

select id, tenant_id, dedup_key, event_id, comment_id, created_at_meta from d166_candidates order by created_at_meta;

-- 2. For the record: parked replies with a Page notice under the same comment that did NOT
--    qualify (other text, or stamped over a minute before the draft). NOT touched; a person
--    looks at them.
select o.id, o.tenant_id, o.dedup_key
  from outbound_messages o
  join tenant_channels c on c.tenant_id = o.tenant_id and c.id = o.channel_id and c.provider = 'facebook_page'
 where o.kind = 'comment_reply' and o.state = 'indeterminate'
   and not exists (select 1 from d166_candidates d where d.id = o.id)
   and exists (
     select 1 from webhook_events e
      where e.tenant_id = o.tenant_id and e.raw_payload is not null
        and e.raw_payload @> jsonb_build_object('id', c.external_id, 'changes', jsonb_build_array(
              jsonb_build_object('field', 'feed', 'value', jsonb_build_object(
                'item', 'comment', 'verb', 'add', 'parent_id', o.dedup_key, 'from', jsonb_build_object('id', c.external_id))))));

-- 3. The move. The WHERE clause re-checks the state, so a row changed since step 1 is left alone.
update outbound_messages o
   set state = 'sent',
       provider_message_id = d.comment_id,
       unit_cost_nanousd = 0,
       sent_at = coalesce(d.created_at_meta, now()),
       lease_until = null,
       refused_reason = 'reconciled from Meta''s feed notice ' || d.comment_id
                        || ' (was indeterminate' || coalesce(': ' || o.refused_reason, '') || ')'
  from d166_candidates d
 where o.id = d.id
   and o.tenant_id = d.tenant_id
   and o.kind = 'comment_reply'
   and o.state = 'indeterminate'
returning o.id, o.tenant_id, o.provider_message_id, o.sent_at;

commit;
