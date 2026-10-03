-- A photo and «how much?» is answered by Дали, not left to staff (founder, 2026-10-04, D-176).
-- (A `price_page` contact kind was drafted here and dropped the same day, D-177: the two prices it
-- would have pointed to are not services Tara offers.)
--
-- 1. `photo_price_question`, a canned kind: the reviewed question a customer who sends a photo
--    is asked (which service, the hair length). Served whole by the platform, never by the
--    model (`reception/photoPrice.ts`, the reception worker), so it is model-invisible. NO ROW
--    IS INSERTED here; a tenant's row is its own provision file, and the whole D-176 path is
--    inert for a tenant without a reviewed one. The kind is in `MODEL_INVISIBLE_KINDS`
--    (`gate/match.ts`) and that code must be DEPLOYED before any tenant has a row of it (0033's
--    order, 0072's note): a row the compiled prefix does not expect moves `canned_hash` on one
--    side only and refuses every DM reply until a republish.
--    `reel_price_question`, the same for a video, a reel or a link to one (founder, 2026-10-04:
--    the photo line says «зураг», so a video has its own reviewed line). Same rules, same order.
-- 2. `ops.refuse_unpublished_canned_edit` (0074, D-163) redefined with the same function body
--    and `photo_price_question` and `reel_price_question` added to its invisible list, so adding
--    or editing those rows never needs a republish. `check-gate-keys` holds the list equal to
--    MODEL_INVISIBLE_KINDS.
--
-- Additive: two lookup rows and a function redefined with two more skipped kinds (an edit it
-- skips is one that never moved the hash). Nothing is dropped, rewritten or narrowed.

insert into canned_response_kinds (kind, description) values
  ('photo_price_question',
   'D-176. Sent when a customer sends a photo with no words or with a price question: asks which service and the hair length, so the price comes from the rows. Served whole by the platform, never by the model.'),
  ('reel_price_question',
   'D-176. Sent when a customer sends a video, a reel or a link to one with no words or with a price question: asks which service and the hair length, so the price comes from the rows. Served whole by the platform, never by the model.')
on conflict (kind) do nothing;

create or replace function ops.refuse_unpublished_canned_edit() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
declare
  -- Model-invisible canned kinds: they are filtered out of the compiled prefix and the
  -- hash, so editing them never makes a tenant stale. Same list as MODEL_INVISIBLE_KINDS.
  invisible constant text[] := array['image_received', 'comment_public_reply', 'comment_private_reply',
    'handover_notice', 'handover_reclaim', 'clarify_branch', 'comment_cta_public_reply',
    'comment_cta_private_reply', 'voice_received', 'photo_price_question', 'reel_price_question'];
  old_counts boolean := false;
  new_counts boolean := false;
begin
  if coalesce(current_setting('dala.canned_edit', true), '') = 'republish' then
    return coalesce(new, old);
  end if;
  -- Signing, or a body that differs only in surrounding spaces: the hash reads the kind and
  -- the TRIMMED body, so neither moves it. `btrim` trims spaces only, fewer characters than
  -- JavaScript's `trim()`, so any other difference is still refused (the safe direction).
  if tg_op = 'UPDATE'
     and btrim(new.body) is not distinct from btrim(old.body) and new.kind = old.kind
     and new.locale = old.locale and new.tenant_id = old.tenant_id then
    return new;
  end if;

  -- A row is in the published hash when its kind is model-visible, its locale is its
  -- tenant's default locale (the only one compiled), and that tenant has a live revision.
  if tg_op in ('UPDATE', 'DELETE') and not (old.kind = any(invisible)) then
    select exists (select 1 from public.tenants t
                   where t.id = old.tenant_id and t.live_revision_id is not null
                     and t.default_locale = old.locale) into old_counts;
  end if;
  if tg_op in ('UPDATE', 'INSERT') and not (new.kind = any(invisible)) then
    select exists (select 1 from public.tenants t
                   where t.id = new.tenant_id and t.live_revision_id is not null
                     and t.default_locale = new.locale) into new_counts;
  end if;
  if not (old_counts or new_counts) then
    return coalesce(new, old);
  end if;

  raise exception 'canned_responses: this edit changes a live tenant''s published lines, and every reply would stop (canned_stale) until a republish'
    using errcode = 'P0001',
          hint = 'In one SQL transaction: begin; set local dala.canned_edit = ''republish''; <edit>; commit; then publish the tenant at once (scripts/publish/tenant.ts). PostgREST and scripts/provision cannot set this; edit through SQL. D-163.';
end $$;
