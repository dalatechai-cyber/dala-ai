-- 0011 — where did this row come from? (D-020.)
--
-- Placeholder `service_aliases` were generated to give the matcher something to chew on:
-- plausible Mongolian phrasings, invented rather than observed. The analysis that was
-- supposed to VALIDATE those aliases then read them as if they were tenant data, and its
-- output was corrupted by its own fixtures.
--
-- The failure is not that a guess was made. It is that **the guess became
-- indistinguishable from a fact the moment it was written to a row.** Same shape as
-- `supabase_migrations.schema_migrations` looking identical whether a migration ran or
-- not, and as `unaccent` mapping Ё→Е while leaving Ө and Ү alone: a source answering
-- plausibly instead of admitting it cannot.
--
-- So: a column, and readers that honour it.
--
-- ## There is deliberately NO DEFAULT
--
-- A default is the whole bug in miniature. `default 'tenant_confirmed'` blesses every
-- placeholder somebody forgets to label — the exact failure. `default 'seeded'` mislabels
-- real tenant data and trains people to ignore the column. **No default means an INSERT
-- that does not say where the row came from is refused by the database**, which is the
-- only version of this rule that survives somebody in a hurry.
--
-- Existing rows are backfilled `'seeded'` rather than `'tenant_confirmed'`: there are none
-- today, and if that assumption is ever wrong, under-trusting real data costs a re-label
-- while over-trusting a placeholder costs another corrupted analysis.
--
-- ## The fifth table
--
-- D-020 names four: `service_aliases`, `deterministic_replies`, `out_of_scope_topics`,
-- `faqs`. `disclosure_rules` is added because it is the same row in every respect that
-- matters — a `topic_key` plus a `matcher`, read by the same loader, seedable by the same
-- hand. Leaving it out would be a gap shaped exactly like the one this closes.
--
-- ADDITIVE ONLY: one column per table, and a CHECK.

do $$
declare t text;
begin
  foreach t in array array[
    'service_aliases', 'deterministic_replies', 'out_of_scope_topics', 'faqs', 'disclosure_rules'
  ] loop
    execute format('alter table %I add column if not exists provenance text', t);
    -- Conservative direction. See the note above.
    execute format('update %I set provenance = ''seeded'' where provenance is null', t);
    execute format('alter table %I alter column provenance set not null', t);
    -- Explicitly no default: state it or be refused.
    execute format('alter table %I alter column provenance drop default', t);

    if not exists (
      select 1 from pg_constraint
       where conrelid = t::regclass and conname = format('%s_provenance_known', t)
    ) then
      execute format(
        'alter table %I add constraint %I check (provenance in (''tenant_confirmed'', ''seeded'', ''inferred''))',
        t, format('%s_provenance_known', t));
    end if;

    execute format(
      'comment on column %I.provenance is %L', t,
      'tenant_confirmed | seeded | inferred. NO DEFAULT: an insert that does not say where '
      'the row came from is refused. Anything but tenant_confirmed is kept OUT of the '
      'compiled prompt (prompt/tenant.ts) — a guess must never be stated to a customer as '
      'the salon''s own fact.');
  end loop;
end $$;
