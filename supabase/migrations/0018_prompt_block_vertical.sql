-- 0018 — a platform block may be written for one vertical.
--
-- The gate blocks are shared by every tenant and five of them are written in salon
-- language: Ш1 «үсчний зэрэглэл», Ш3 «салонд шууд хохирол», Ш5 «үс будуулж», Ш6 «салоны
-- мөнгө», Ш8 «ийм салонуудад» and its gift-card example. On 2026-09-06 that was the only
-- business-type vocabulary in tenant #0's compiled prompt — its `vertical` is `software`
-- and nothing rendered it — and the first reply the platform ever sent greeted a customer
-- on behalf of a beauty salon (D-033).
--
-- ## Why not simply neutralise the wording
--
-- For the two RATIONALES, that is exactly the fix and it costs nothing: «салоны мөнгө»
-- becomes «байгууллагын мөнгө» with no loss. For the WORKED EXAMPLES it is the wrong
-- trade. D-011's finding is that hardening works by naming the forbidden wrong answer, and
-- Ш8's «ийм салонууд ихэвчлэн бэлгийн карт зардаг» is the most load-bearing sentence in
-- its block precisely because it is concrete. A generic example teaches less.
--
-- So the examples stay concrete and become per-vertical. `tenants.vertical` has existed
-- since 0001 and is read by nothing; 0001's own comment on `out_of_scope_topics` already
-- says platform defaults are "copied into a new tenant's draft by vertical". This column
-- is the missing half of that.
--
-- ## Null means EVERY vertical, and that is why it is nullable with no default
--
-- A block with no vertical applies to all tenants — which is every block that exists
-- today, so this migration changes no compiled prompt. A block with a vertical applies
-- only to tenants whose `tenants.vertical` matches it. The selection happens in
-- `loadPromptSections`, in JavaScript rather than in the PostgREST filter, because
-- `tenants.vertical` is free-form text and interpolating it into an `.or()` string is an
-- injection surface for a value an operator types.
--
-- ## No CHECK on the values
--
-- `tenants.vertical` itself has no CHECK, so a constraint here would be tighter than the
-- column it must agree with, and the first new vertical would fail this instead of the
-- place that defines it. `catalog.sql` V29 asserts the useful property instead: every
-- vertical a tenant actually has must have coverage for every block that is per-vertical
-- at all — which is a question about rows, not about a vocabulary.
--
-- ADDITIVE ONLY: one nullable column. No existing row changes, nothing is dropped, and
-- with no vertical-bearing rows the compiled prompt is byte-identical.

alter table prompt_blocks add column if not exists vertical text;

-- The uniqueness rule moves with the column, and this is the one line in this migration
-- that is not purely additive.
--
-- `0010` created `prompt_blocks_platform_key` unique on `(block_key)` for platform rows,
-- and its comment gives the reason: two rows sharing a key reach the renderer as
-- `ambiguous_order` — a non-deterministic prefix, a cache miss on every request, and a
-- different prompt depending on which row sorted first. That reason survives; its scope
-- changes. Two rows may now share a key when they are written for different verticals,
-- because `loadPromptSections` selects at most one of them for any given tenant.
--
-- `coalesce(vertical, '')` so the generic row participates: a key may have one generic row
-- and one row per vertical, and never two of either. It is a RELAXATION — every row the
-- old index permitted, this one permits — so it cannot fail on existing data.
drop index if exists prompt_blocks_platform_key;
create unique index if not exists prompt_blocks_platform_key
  on prompt_blocks (block_key, coalesce(vertical, ''))
  where scope = 'platform' and tenant_id is null;

comment on column prompt_blocks.vertical is
  'Null means the block applies to every tenant. A value means it applies only to tenants '
  'whose tenants.vertical matches — the examples in Ш5 and Ш8 are per-vertical because a '
  'concrete wrong answer teaches more than a generic one (D-011), and a salon''s wrong '
  'answer is not a garage''s. Selection lives in loadPromptSections.';
