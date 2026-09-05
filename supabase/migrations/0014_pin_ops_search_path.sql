-- 0014 — pin `search_path` on the four ops trigger functions.
--
-- Found by Supabase's own database linter against the live project on 2026-09-05, which is
-- a source CI does not have. Four functions carried a mutable search_path:
-- `ops.deny_mutation`, `ops.deny_truncate`, `ops.stamp_went_live`,
-- `ops.stamp_went_live_on_insert` — the last two written the day before, by me, without it.
--
-- ## Why `catalog.sql` V11 did not catch it
--
-- V11 asserts that every **SECURITY DEFINER** function pins `search_path`, and its
-- reasoning is specific to that: a definer function runs as its owner, so a caller who can
-- create objects could shadow a table name and have it resolved with the owner's rights.
-- All four of these are SECURITY INVOKER, so V11 correctly did not apply to them and
-- correctly passed 25/25 while they sat unpinned.
--
-- ## Why pin them anyway, when the exploit is thin
--
-- It is thin. All four are trigger functions, none references a table, and an invoker
-- function shadowing `now()` only fools the caller's own statement. The reason is not this
-- exploit:
--
--  1. **Every `app.*` function already pins**, including the two that are not DEFINER
--     (`app.mn_search_fold`, `app.variant_key`). `ops` was the inconsistent one, and an
--     inconsistent convention is one somebody has to re-derive at the moment they are
--     adding the fifth function.
--  2. **A linter with permanent known-warnings is a linter nobody reads.** Four standing
--     WARNs train the eye to skip the section, which is the same failure `alerts/alert.ts`
--     is built to avoid — an alarm that always fires stops being an alarm. Two of these
--     four are append-only guards; the day one of them genuinely regresses, the warning
--     needs to stand out rather than blend in.
--
-- `set search_path = ''` is Supabase's own remediation and is safe here precisely because
-- none of the four resolves an unqualified table. `pg_catalog` is searched implicitly when
-- it is not named, so `now()` and the `raise` machinery still resolve.
--
-- `catalog.sql` V26 asserts the end state for every function in `app` and `ops`, so the
-- next unpinned one fails a check rather than waiting for somebody to read a linter.
--
-- ADDITIVE ONLY: changes no data, no signature, no behaviour.

alter function ops.deny_mutation() set search_path = '';
alter function ops.deny_truncate() set search_path = '';

do $$
begin
  -- 0012's two, guarded because 0012 creates them and a database rebuilt from an older
  -- checkout would not have them yet.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = 'stamp_went_live') then
    execute 'alter function ops.stamp_went_live() set search_path = ''''';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = 'stamp_went_live_on_insert') then
    execute 'alter function ops.stamp_went_live_on_insert() set search_path = ''''';
  end if;
end $$;
