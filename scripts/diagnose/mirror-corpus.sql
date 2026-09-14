-- The mirror's corpus: what customers asked, and what Ара drafted.
--
-- Read-only. Three SELECTs — a per-turn transcript, a provenance summary, and the quality
-- flags — meant to be run against the project with psql, or one at a time through whatever
-- read-only client is to hand.
--
-- ## Why this is a file rather than a query somebody retypes
--
-- The fourteen-day mirror produces one artefact and it is this corpus. Retyping the join
-- each evening guarantees that the fifth reading is not comparable with the first: a
-- different date window, a forgotten `direction = 'inbound'`, a LEFT JOIN quietly becoming
-- an INNER one and dropping every turn that was never answered — which is the half worth
-- reading. Pinned here so the readings are of the same thing.
--
-- ## The provenance columns are the point of the first query
--
-- `answered_by`, `revision_id` and `prompt_hash` were written by nothing until 2026-09-14
-- (D-064). Before that a draft could not be attributed to the configuration that produced
-- it, so two drafts either side of a republish were indistinguishable. Rows older than that
-- fix carry NULLs and cannot be repaired; they are still shown, because a turn that was
-- answered before the trace existed is evidence about the reply even if not about the
-- config.

-- 1. THE TRANSCRIPT. One row per inbound customer message, with whatever answered it.
--
-- LEFT JOIN on the reply, deliberately: a customer message with no draft is the most
-- interesting row in the table — it is a turn the platform saw and did not answer — and an
-- inner join would hide exactly those.
select
  m.at                                        as asked_at,
  left(c.id::text, 8)                         as conv,
  m.body                                      as customer,
  o.state                                     as reply_state,
  m.answered_by,
  o.refused_reason,
  o.body                                      as draft,
  round(extract(epoch from (o.created_at - m.at))::numeric, 1) as seconds_to_draft,
  left(m.prompt_hash, 8)                      as prompt,
  left(m.revision_id::text, 8)                as revision
from messages m
join conversations c  on c.id = m.conversation_id
join tenants t        on t.id = m.tenant_id
left join outbound_messages o
       on o.conversation_id = m.conversation_id
      and o.kind = 'reply'
      and o.created_at >= m.at
      and o.created_at < m.at + interval '5 minutes'
where t.slug = :'tenant'
  and m.direction = 'inbound'
  and m.at >= now() - (:'hours' || ' hours')::interval
order by m.at;

-- 2. PROVENANCE. How often a row answered without the model, which is the first question
--    anybody asks of this corpus and the reason `deterministic` is not folded into `canned`.
--
--    A NULL `answered_by` on a row newer than 2026-09-14 is a finding, not a gap: it means
--    a customer message was stored and never answered at all.
select
  coalesce(m.answered_by, '(unanswered)') as answered_by,
  count(*)                                as turns,
  min(m.at)                               as first_seen,
  max(m.at)                               as last_seen
from messages m
join tenants t on t.id = m.tenant_id
where t.slug = :'tenant'
  and m.direction = 'inbound'
  and m.at >= now() - (:'hours' || ' hours')::interval
group by 1
order by turns desc;

-- 3. QUALITY FLAGS. Every refusal, handoff and drift the reply path recorded.
--
--    `canned_paraphrased` (D-065) is the one to watch: the model was asked to reproduce an
--    approved line «нэг ч үсэг өөрчлөхгүйгээр» and did not. It is corrected automatically —
--    the row is served instead — so the flag is the ONLY evidence that it happened, and its
--    rate is the only evidence about whether the gate wording works.
select
  q.flag,
  count(*)   as times,
  max(q.at)  as last_seen,
  (array_agg(q.detail order by q.at desc))[1] as newest_detail
from quality_flags q
join tenants t on t.id = q.tenant_id
where t.slug = :'tenant'
  and q.at >= now() - (:'hours' || ' hours')::interval
group by q.flag
order by times desc;

-- Run it:
--
--   psql "$DATABASE_URL" -v tenant=matrix-eco-salon -v hours=24 \
--     -f scripts/diagnose/mirror-corpus.sql
--
-- `hours` rather than a date so a reading is always "the last N hours" and cannot be
-- accidentally scoped to a different window than the one it is compared against.
