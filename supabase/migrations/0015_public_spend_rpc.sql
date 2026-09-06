-- 0015 — expose `reserve_spend` and `settle_spend` on the schema PostgREST actually serves.
--
-- Found in production 2026-09-06, on the first message that reached the worker: every reply
-- refused with `guard_unavailable`, and the reservation row was inserted and then released.
-- `release()` runs in exactly two places in `spend/reserve.ts` — the RPC erroring, and the
-- RPC returning not-true — and the second maps to 429, not 503. So the RPC errored.
--
-- ## The mismatch
--
-- `app.reserve_spend` and `app.settle_spend` live in schema `app`. Every client in
-- `supabase/clients.ts` is built with no `db: { schema }` option, so supabase-js sends
-- PostgREST the default profile, `public` — and asks for `public.reserve_spend`, which does
-- not exist. It could never have worked, for any tenant, on any message. Unit tests stub
-- `db.rpc` and answer whatever they are told to, so nothing here was ever a lie the tests
-- could catch: they were testing a function that was never called.
--
-- ## Why a wrapper, and not exposing `app` to the Data API
--
-- Exposing a schema is a project-wide setting that makes EVERYTHING in it REST-reachable,
-- gated only by grants. `app` holds the spend primitives; the blast radius of getting one
-- grant wrong there is a tenant's budget. Two thin wrappers keep the exposed surface to
-- exactly the two functions the runtime calls, and keep the fix inside a migration with a
-- ledger row rather than inside a dashboard setting nothing in this repository can see.
--
-- ## SECURITY INVOKER, deliberately
--
-- The inner functions are already SECURITY DEFINER. `service_role` holds USAGE on `app` and
-- EXECUTE on both (measured on the live project), so an invoker wrapper needs no privileges
-- of its own — it is a name in the right schema and nothing more. A second DEFINER here
-- would be a second thing to reason about at no benefit.
--
-- ## The grants are the security boundary
--
-- A function in `public` is REST-reachable, and PostgreSQL grants EXECUTE to PUBLIC on every
-- new function by default. Left alone, `anon` could POST to /rest/v1/rpc/reserve_spend and
-- inflate any tenant's daily counter to its ceiling — silencing that tenant for the rest of
-- the day, with no authentication at all. So PUBLIC is revoked before anything is granted.
--
-- The same revoke is applied to the `app.*` originals, which carry PUBLIC EXECUTE from
-- `0001` and are unreachable today only because `app` is not exposed. Defence in depth: it
-- costs nothing and removes the coupling between a schema-exposure setting and a spend
-- primitive.
--
-- ADDITIVE ONLY: creates two functions, tightens two grants. No data, no table, no column.

create or replace function public.reserve_spend(
  p_scope           text,
  p_scope_key       text,
  p_surface         text,
  p_period_kind     text,
  p_period_key      text,
  p_amount_nanousd  bigint
) returns boolean
language sql
security invoker
set search_path = 'public', 'pg_temp'
as $$
  select app.reserve_spend(p_scope, p_scope_key, p_surface, p_period_kind, p_period_key, p_amount_nanousd);
$$;

-- `returns void`, and the asymmetry with `reserve_spend` above is real rather than an
-- oversight: reserving ANSWERS a question (did the ceiling allow it?) and settling states
-- a fact. `spend/settle.ts` reads only `error` from the call, which is the same shape.
-- Declaring `boolean` here fails at CREATE with "return type mismatch … Actual return type
-- is void" — caught by CI on the first push of this migration, because a wrapper's
-- signature has to be read off the function it wraps, not assumed from its neighbour.
create or replace function public.settle_spend(
  p_scope             text,
  p_scope_key         text,
  p_surface           text,
  p_period_kind       text,
  p_period_key        text,
  p_reserved_nanousd  bigint,
  p_actual_nanousd    bigint
) returns void
language sql
security invoker
set search_path = 'public', 'pg_temp'
as $$
  select app.settle_spend(p_scope, p_scope_key, p_surface, p_period_kind, p_period_key,
                          p_reserved_nanousd, p_actual_nanousd);
$$;

revoke all on function public.reserve_spend(text, text, text, text, text, bigint)
  from public, anon, authenticated;
revoke all on function public.settle_spend(text, text, text, text, text, bigint, bigint)
  from public, anon, authenticated;

revoke all on function app.reserve_spend(text, text, text, text, text, bigint)
  from public, anon, authenticated;
revoke all on function app.settle_spend(text, text, text, text, text, bigint, bigint)
  from public, anon, authenticated;

grant execute on function public.reserve_spend(text, text, text, text, text, bigint) to service_role;
grant execute on function public.settle_spend(text, text, text, text, text, bigint, bigint) to service_role;
grant execute on function app.reserve_spend(text, text, text, text, text, bigint) to service_role;
grant execute on function app.settle_spend(text, text, text, text, text, bigint, bigint) to service_role;
