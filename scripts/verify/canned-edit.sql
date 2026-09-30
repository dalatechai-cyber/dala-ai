-- D-163 / migration 0074: an edit to a live tenant's approved lines outside the publish
-- flow is refused, so it cannot silently stop every reply (canned_stale).
-- Runs as the migration owner; each check raises on failure. Leaves nothing behind.
\set ON_ERROR_STOP 1

begin;

insert into tenants (id, slug, display_name, vertical, timezone) values
  ('c0000000-0000-0000-0000-00000000000a', 'ce-live',    'Амьд',     'salon', 'Asia/Ulaanbaatar'),
  ('c0000000-0000-0000-0000-00000000000b', 'ce-onboard', 'Шинэ',     'salon', 'Asia/Ulaanbaatar');
-- Rows go in before the tenant is live: onboarding writes freely.
insert into canned_responses (tenant_id, kind, body) values
  ('c0000000-0000-0000-0000-00000000000a', 'handoff',      'Ажилтан холбогдоно.'),
  ('c0000000-0000-0000-0000-00000000000a', 'booking_line', 'Цаг захиална уу.'),
  ('c0000000-0000-0000-0000-00000000000a', 'image_received', 'Зураг ирлээ.'),
  ('c0000000-0000-0000-0000-00000000000b', 'handoff',      'Ажилтан холбогдоно.');
insert into config_revisions (id, tenant_id, seq, status, published_at) values
  ('c0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a', 1, 'published', now());
update tenants set live_revision_id = 'c0000000-0000-0000-0000-0000000000a1'
  where id = 'c0000000-0000-0000-0000-00000000000a';

do $$
declare
  n int := 0;
  live constant uuid := 'c0000000-0000-0000-0000-00000000000a';
  onboard constant uuid := 'c0000000-0000-0000-0000-00000000000b';
  procedure_ok boolean;
begin
  -- CE1-CE4: every hash-moving edit on a live tenant is refused.
  begin
    update canned_responses set body = 'Өөр.' where tenant_id = live and kind = 'handoff';
    raise exception 'CE1 FAILED: body edit on a live tenant went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE1 PASS: body edit refused'; n := n + 1;
  end;
  begin
    insert into canned_responses (tenant_id, kind, body) values (live, 'closing', 'Баярлалаа.');
    raise exception 'CE2 FAILED: insert on a live tenant went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE2 PASS: insert refused'; n := n + 1;
  end;
  begin
    delete from canned_responses where tenant_id = live and kind = 'booking_line';
    raise exception 'CE3 FAILED: delete on a live tenant went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE3 PASS: delete refused'; n := n + 1;
  end;
  begin
    update canned_responses set kind = 'image_received' where tenant_id = live and kind = 'booking_line';
    raise exception 'CE4 FAILED: moving a visible row to an invisible kind went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE4 PASS: kind change out of the prefix refused'; n := n + 1;
  end;
  begin
    update canned_responses set tenant_id = live where tenant_id = onboard and kind = 'handoff';
    raise exception 'CE5 FAILED: moving a row onto a live tenant went through';
  exception when raise_exception or unique_violation then
    if sqlstate = 'P0001' and sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE5 PASS: row moved onto a live tenant refused'; n := n + 1;
  end;

  -- CE6-CE9: what stays allowed.
  update canned_responses set reviewed_at = now(), reviewed_by = 'founder'
    where tenant_id = live and kind = 'handoff';
  raise notice 'CE6 PASS: signing (reviewed_at only) allowed'; n := n + 1;
  update canned_responses set body = 'Зураг хүлээж авлаа.' where tenant_id = live and kind = 'image_received';
  insert into canned_responses (tenant_id, kind, body) values (live, 'voice_received', 'Дуут зурвас.');
  delete from canned_responses where tenant_id = live and kind = 'voice_received';
  raise notice 'CE7 PASS: model-invisible kinds editable'; n := n + 1;
  update canned_responses set body = 'Өөр.' where tenant_id = onboard;
  insert into canned_responses (tenant_id, kind, body) values (onboard, 'closing', 'Баярлалаа.');
  delete from canned_responses where tenant_id = onboard and kind = 'closing';
  raise notice 'CE8 PASS: tenant with no live revision editable'; n := n + 1;

  -- The declared republish path.
  perform set_config('dala.canned_edit', 'republish', true);
  update canned_responses set body = 'Шинэ мөр.' where tenant_id = live and kind = 'booking_line';
  perform set_config('dala.canned_edit', '', true);
  select body = 'Шинэ мөр.' into procedure_ok from canned_responses where tenant_id = live and kind = 'booking_line';
  if not procedure_ok then raise exception 'CE9 FAILED: republish-declared edit did not land'; end if;
  raise notice 'CE9 PASS: edit with dala.canned_edit = republish allowed'; n := n + 1;

  if n <> 9 then raise exception 'CANNED EDIT SUITE: % of 9 checks ran', n; end if;
end $$;

do $$ begin raise notice 'CANNED EDIT SUITE PASSED: 9 checks'; end $$;

rollback;
