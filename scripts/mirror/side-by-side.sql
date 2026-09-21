-- The real-turn side-by-side: every customer message, the ANCESTOR's reply, Dala AI's
-- shadow draft, and both reply times.
--
-- Run it against the project (psql or the Supabase SQL editor). It reads only; it writes
-- nothing. As the corpus fills, re-running it is the whole report.
--
--     psql "$SUPABASE_DB_URL" -f scripts/mirror/side-by-side.sql
--
-- ## Where the ancestor's replies come from, and why this is not in `messages`
--
-- `message_echoes` was subscribed on Matrix's Page on 2026-09-21. An echo is an outbound
-- message on the thread delivered back to us, so the ancestor's live replies arrive here
-- as echoes. `meta/extract.ts` skips them (answering one is a billing loop) and the skip
-- carries the `mid`, the customer and the app — but NOT the text. So the ancestor's words
-- exist in exactly one place: `webhook_events.raw_payload`. That is what this reads.
--
-- `raw_payload` holds ONE ENTRY, not the whole webhook body: the messaging array is at
-- `raw_payload->'messaging'`, NOT `raw_payload->'entry'->0->'messaging'`. The wrong path
-- returns zero rows rather than an error, which reads exactly like "no echoes have ever
-- arrived" — the first version of this query said precisely that about a table with an
-- echo in it.
--
-- ## Two defects this query is shaped to avoid, both found by writing it wrong first
--
-- 1. **THE ECHO MUST FALL INSIDE THE WINDOW IT IS EVIDENCE ABOUT.** A naive
--    `order by echo.at limit 1` per customer message attaches the NEAREST LATER echo, and
--    with one echo in the table it attached that one echo to every earlier message on the
--    thread — producing "ancestor reply times" of 39,544s and 41,951s. Absurd values are
--    the only reason it was visible; a day of echoes would have produced plausible ones.
--    This is D-062 exactly (a row read as a present-tense signal, with nobody asking
--    *when*), met again while building the instrument meant to measure it. The pairing is
--    ECHO-DRIVEN — each echo claims its nearest PRECEDING customer message — and bounded
--    by REPLY_WINDOW, so an echo with no plausible cause pairs with nothing.
--
-- 2. **BOTH CLOCKS MUST BE THE SAME CLOCK.** `messages.at` is when WE wrote the row;
--    the echo carries META's timestamp. Measuring the ancestor from Meta's clock and Dala
--    from ours understates Dala by the whole webhook-receipt hop — 1.3–6.4s on measured
--    traffic, which is larger than the gap being measured. Both sides are computed from
--    the CUSTOMER's own `timestamp` in the payload.
--
-- Turns before the subscription existed show a null ancestor column. That is an absence of
-- INSTRUMENT, never an absence of reply, and must not be read as the ancestor staying
-- silent.
\set REPLY_WINDOW '10 minutes'

with inbound_meta as (
  select e.id as event_id,
         m->'message'->>'mid'  as mid,
         m->'message'->>'text' as text,
         m->'sender'->>'id'    as psid,
         to_timestamp((m->>'timestamp')::bigint/1000.0) at time zone 'UTC' as meta_at
  from webhook_events e
  cross join lateral jsonb_array_elements(e.raw_payload->'messaging') m
  where (m->'message'->>'is_echo')::boolean is not true
    and m->'message'->>'text' is not null
),
echoes as (
  select m->'message'->>'text'   as text,
         m->'message'->>'app_id' as app_id,
         m->'recipient'->>'id'   as psid,
         to_timestamp((m->>'timestamp')::bigint/1000.0) at time zone 'UTC' as meta_at
  from webhook_events e
  cross join lateral jsonb_array_elements(e.raw_payload->'messaging') m
  where (m->'message'->>'is_echo')::boolean is true
),
-- Each echo claims its nearest PRECEDING customer message. Echo-driven, so one echo can
-- never be counted as the reply to several turns.
paired as (
  select i.event_id, i.mid, i.meta_at, i.text as customer_text,
         ec.text as ancestor_text, ec.app_id,
         extract(epoch from (ec.meta_at - i.meta_at)) as ancestor_s
  from echoes ec
  join lateral (
    select * from inbound_meta im
    where im.psid = ec.psid
      and im.meta_at <= ec.meta_at
      and im.meta_at >= ec.meta_at - interval :'REPLY_WINDOW'
    order by im.meta_at desc limit 1
  ) i on true
)
select i.event_id,
       i.meta_at                                        as customer_at,
       i.text                                           as customer_text,
       round(p.ancestor_s::numeric, 2)                  as ancestor_s,
       p.ancestor_text,
       round(extract(epoch from (o.created_at - i.meta_at))::numeric, 2) as dala_s,
       o.body                                           as dala_draft,
       o.state, msg.answered_by, p.app_id               as ancestor_app_id
from inbound_meta i
left join paired p on p.mid = i.mid
left join outbound_messages o on o.dedup_key = 'in:' || i.mid
left join messages msg on msg.external_id = i.mid and msg.direction = 'inbound'
order by i.meta_at desc;
