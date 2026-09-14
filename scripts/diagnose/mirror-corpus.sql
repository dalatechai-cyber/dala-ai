-- The mirror's corpus: what customers asked, and what Ара drafted.
--
-- Read-only. Six SELECTs — a per-turn transcript, a provenance summary, the quality flags,
-- a sentence-by-sentence read of whose words each draft is, and two on the SCRIPT the
-- customer wrote in — meant to be run against the project with psql, or one at a time
-- through whatever read-only client is to hand.
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

-- 4. WHOSE SENTENCE IS IT? Every sentence of every draft, against the prefix that
--    produced it — so "the model composed this" and "the model repeated an approved line"
--    stop looking the same in a transcript.
--
--    This is the question the first corpus reading actually needed and had to answer by
--    hand, with four ad-hoc queries, on 2026-09-14. Run against that morning's three drafts
--    it reports in one pass what those four established:
--
--      the greeting      3 of 4 sentences NOVEL — there is no deterministic greeting row
--                        for this tenant, so «hello» costs a full model call and returns
--                        unreviewed Mongolian
--      the handoff       3 of 3 approved — the guard refused the model and served the row
--      the second one    «Уучлаарай, энэ асуултад хариулж чадахгүй байна» NOVEL, sitting
--                        between two approved sentences: D-065's dropped «би», visible as a
--                        novel sentence inside an otherwise approved reply, WITHOUT needing
--                        the flag. An independent read on the same defect.
--
--    NOVEL is not a synonym for wrong. Composing an answer out of the knowledge base is the
--    job; only pinned lines must be verbatim. What NOVEL means is "this sentence is the
--    model's own Mongolian and nobody has read it" — which is the thing to read.
--
--    Pinned to the draft's OWN revision when `messages.revision_id` is set (D-064), and only
--    falling back to whatever is published now when it is not — that is what the
--    `compared_against` column says. Without that, the first republish would re-date every
--    older draft against a prefix it never saw and report a screenful of false NOVELs, which
--    is precisely the comparison D-064 exists to make possible.
--
--    Two limitations, stated rather than discovered later. The split is on `[.!?]`, so a URL
--    («https://www.matrixecosalon.org/») splits into fragments and each is judged separately;
--    read a fragment result as noise. And `like` is a substring test on the compiled prefix,
--    so a sentence that appears there inside a DIFFERENT sentence counts as approved.
with answered as (
  select o.id as draft_id, o.created_at, o.body, m.revision_id
  from messages m
  join tenants t on t.id = m.tenant_id
  join outbound_messages o
    on o.conversation_id = m.conversation_id and o.kind = 'reply'
   and o.created_at >= m.at and o.created_at < m.at + interval '5 minutes'
  where t.slug = :'tenant' and m.direction = 'inbound'
    and m.at >= now() - (:'hours' || ' hours')::interval
),
prefixed as (
  select a.draft_id, a.created_at, a.body, a.revision_id is not null as pinned,
    coalesce(
      -- A revision carries one snapshot per channel; they have matched so far, and the
      -- newest is taken rather than a channel being hardcoded here.
      (select cs.prompt_stable from config_snapshots cs
        where cs.revision_id = a.revision_id order by cs.compiled_at desc limit 1),
      (select cs.prompt_stable from config_snapshots cs
         join config_revisions r on r.id = cs.revision_id
         join tenants t2 on t2.id = cs.tenant_id
        where t2.slug = :'tenant' and r.status = 'published'
        order by cs.compiled_at desc limit 1)
    ) as prompt_stable
  from answered a
)
select
  left(p.draft_id::text, 8)                as draft,
  to_char(p.created_at, 'MM-DD HH24:MI')   as at,
  case when p.pinned then 'own revision' else 'published (assumed)' end as compared_against,
  case when p.prompt_stable like '%' || trim(s) || '%' then 'approved' else 'NOVEL' end as origin,
  trim(s)                                  as sentence
from prefixed p, lateral regexp_split_to_table(p.body, '[.!?]') as s
where trim(s) <> ''
order by p.created_at, origin, sentence;


-- 5. WHICH SCRIPT DID THE CUSTOMER WRITE IN? (D-067)
--
--    Two queries, and together they answer the one question D-067 leaves with the founder:
--    WHICH LATIN SPELLINGS DO THIS TENANT'S CUSTOMERS ACTUALLY USE? That is a data question
--    with a data answer, and the corpus is the only place the answer exists.
--
--    Why it matters: a Cyrillic stem cannot match Latin text, so for a Latin-script message
--    no disclosure rule and no out-of-scope topic fires and the model answers unrefused —
--    including the children's-services rule the founder approved by hand. The fix needs no
--    code (`containsStem` is a Unicode token-prefix match and does not care which script a
--    stem is in), so a tenant that stores `huuhd` beside `хүүхд` is covered. These queries
--    say which spellings are worth storing.
--
--    On the first reading, 2026-09-14: two of three inbound messages were Latin — 66.7%.
--    Three messages is not a rate. Re-read it as the corpus grows; that number is the whole
--    argument for doing anything about this at all.
--
--    NOTE on `[A-Za-z]`, which CLAUDE.md rule 6 would normally forbid: rule 6 is about
--    matchers over user text that DRIVE BEHAVIOUR, where an ASCII class silently mis-handles
--    Cyrillic. Here detecting Latin is the entire purpose and nothing downstream acts on it —
--    it is a report for a person to read. Do not copy this class into `src/`.

-- 5a. The proportion.
with scripted as (
  select case
    when m.body ~ '[А-Яа-яЁёӨөҮү]' and m.body ~ '[A-Za-z]' then 'mixed'
    when m.body ~ '[А-Яа-яЁёӨөҮү]'                          then 'cyrillic'
    when m.body ~ '[A-Za-z]'                                then 'latin'
    else 'neither' end as script
  from messages m
  join tenants t on t.id = m.tenant_id
  where t.slug = :'tenant' and m.direction = 'inbound'
    and m.at >= now() - (:'hours' || ' hours')::interval
)
select
  script,
  count(*)                                                  as messages,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1) as pct
from scripted
group by script
order by messages desc;

-- 5b. The messages themselves — the candidate spellings, in the customer's own words.
--     Read this to decide what goes in `stems`. A Latin message that a gate SHOULD have
--     refused is the highest-value row in the whole corpus.
select
  to_char(m.at, 'MM-DD HH24:MI')      as at,
  case
    when m.body ~ '[А-Яа-яЁёӨөҮү]' and m.body ~ '[A-Za-z]' then 'MIXED'
    when m.body ~ '[A-Za-z]'                                then 'LATIN'
    else 'cyrillic' end               as script,
  coalesce(m.answered_by, '(unanswered)') as answered_by,
  m.body                              as customer
from messages m
join tenants t on t.id = m.tenant_id
where t.slug = :'tenant' and m.direction = 'inbound'
  and m.at >= now() - (:'hours' || ' hours')::interval
  and m.body ~ '[A-Za-z]'
order by m.at;


-- Run it:
--
--   psql "$DATABASE_URL" -v tenant=matrix-eco-salon -v hours=24 \
--     -f scripts/diagnose/mirror-corpus.sql
--
-- `hours` rather than a date so a reading is always "the last N hours" and cannot be
-- accidentally scoped to a different window than the one it is compared against.
