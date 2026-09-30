-- Which surface reads a comment rule: DM, public comment, or both (founder, 2026-09-30).
--
-- `comment_rules` escalate rows are read by the comment worker (no public reply + alert,
-- D-122) AND by the DM path (the complaint reminder, no emoji, no sales line, and the
-- needs-person alert, D-158). The founder approved DM-only rows for "I want a person"
-- («ажилтантай ярих», «оператор», …) that must not change comment handling, and moving a few
-- comment complaint stems («үс муудсан» is often a treatment question in a DM) to the wall
-- only (docs/proposals/dm-needs-person-rules.md).
--
-- NULL means both, which is every existing row: nothing changes when this is applied. The
-- readers filter with `ruleAppliesTo` (`comments/classify.ts`); this column is read by code
-- deployed in the same PR, so it must be applied BEFORE that deploy (D-058).
--
-- Additive: one nullable column and a CHECK every existing row satisfies.

alter table comment_rules
  add column if not exists surfaces text[];

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.comment_rules'::regclass and conname = 'comment_rule_surfaces_known') then
    alter table comment_rules
      add constraint comment_rule_surfaces_known check (
        surfaces is null
        or (cardinality(surfaces) > 0 and surfaces <@ array['direct_message', 'public_comment']::text[])
      );
  end if;
end $$;

comment on column comment_rules.surfaces is
  'Which surfaces read this rule: {direct_message}, {public_comment} or both. NULL means both (every row before 0073).';
