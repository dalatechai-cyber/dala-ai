-- An unsigned approved line stops every reply too (founder, 2026-09-30, D-163 addendum).
--
-- `renderCannedSection` (`gate/match.ts`) refuses the whole canned section when ANY row in the
-- tenant's default locale is unreviewed, model-invisible kinds included, so every reply is
-- refused with `canned_response_unreviewed`. 0074 guards what moves the published hash; it
-- lets two writes through that leave a live tenant in exactly that state:
--   * an UPDATE that clears `reviewed_at` (0074 treats it as signing), and
--   * an INSERT of an unsigned row of a model-invisible kind (e.g. `handover_reclaim`).
--
-- This trigger refuses a write that LEAVES a row of a live tenant, in its default locale,
-- unsigned when it was not unsigned before. There is NO escape: 0074's `republish` escape is
-- what an operator types for every live edit, and a republish never repairs an unsigned row,
-- so honouring it here would let the likeliest un-signing through. Sign in the same statement:
--     begin; set local dala.canned_edit = 'republish';
--     update canned_responses set body = '…', reviewed_at = now(), reviewed_by = '…' where …;
--     commit;
-- An already-unsigned row may stay unsigned (fixing its body is not made harder), and signing
-- is always allowed. Tenants with no live revision are not affected.
--
-- Additive: one function and one trigger. No row is read, changed or written by applying it.

create or replace function ops.refuse_unsigning_live_canned() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.reviewed_at is not null then
    return new;
  end if;
  -- Already unsigned before this write: not this write's doing.
  if tg_op = 'UPDATE' and old.reviewed_at is null and old.tenant_id = new.tenant_id and old.locale = new.locale then
    return new;
  end if;
  if exists (select 1 from public.tenants t
             where t.id = new.tenant_id and t.live_revision_id is not null and t.default_locale = new.locale) then
    raise exception 'canned_responses: this write leaves a live tenant''s line unsigned, and every reply would stop (canned_response_unreviewed)'
      using errcode = 'P0001',
            hint = 'Sign it in the same statement (reviewed_at = now(), reviewed_by = ...). A live tenant''s line is never left unsigned; the republish escape does not apply. D-163.';
  end if;
  return new;
end $$;

create trigger canned_responses_refuse_unsigning
  before insert or update on canned_responses
  for each row execute function ops.refuse_unsigning_live_canned();

comment on function ops.refuse_unsigning_live_canned() is
  'D-163 addendum. Refuses a write that leaves a live tenant''s canned_responses row unsigned. No escape.';
