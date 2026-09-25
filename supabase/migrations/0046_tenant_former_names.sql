-- The names a tenant no longer uses (D-123).
--
-- The morning flaw report reads what a reply SAYS for the first time: a reply that calls the
-- business by a former name is flagged. Matrix Eco Salon became Tara Salon, and a live reply
-- to «ci henbe» named it «Матрикс». Which names are former is a fact about the business, so
-- it is a column, not a literal in `quality/leaks.ts`.
--
-- Additive. Empty for every tenant until a row is edited.
alter table tenants
  add column if not exists former_names text[] not null default '{}';

comment on column tenants.former_names is
  'D-123. Names the business no longer uses. A sent reply using one is flagged in the morning report. Links are ignored.';
