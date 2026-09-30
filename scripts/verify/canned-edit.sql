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
    -- A kind the live tenant has no row of, so only the trigger can refuse the move.
    insert into canned_responses (tenant_id, kind, body) values (onboard, 'greeting', 'Сайн байна уу.');
    update canned_responses set tenant_id = live where tenant_id = onboard and kind = 'greeting';
    raise exception 'CE5 FAILED: moving a row onto a live tenant went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE5 PASS: row moved onto a live tenant refused'; n := n + 1;
  end;

  -- CE6-CE9: what stays allowed.
  update canned_responses set reviewed_at = now(), reviewed_by = 'founder'
    where tenant_id = live and kind = 'handoff';
  raise notice 'CE6 PASS: signing (reviewed_at only) allowed'; n := n + 1;
  update canned_responses set body = 'Зураг хүлээж авлаа.' where tenant_id = live and kind = 'image_received';
  -- Signed as it goes in: an unsigned row of any kind stops every reply (0075, CE14).
  insert into canned_responses (tenant_id, kind, body, reviewed_at, reviewed_by) values (live, 'voice_received', 'Дуут зурвас.', now(), 'founder');
  delete from canned_responses where tenant_id = live and kind = 'voice_received';
  raise notice 'CE7 PASS: model-invisible kinds editable'; n := n + 1;
  update canned_responses set body = 'Өөр.' where tenant_id = onboard;
  insert into canned_responses (tenant_id, kind, body) values (onboard, 'closing', 'Баярлалаа.');
  delete from canned_responses where tenant_id = onboard and kind = 'closing';
  raise notice 'CE8 PASS: tenant with no live revision editable'; n := n + 1;

  -- CE10-CE11: edits that cannot move the hash.
  update canned_responses set body = body || '  ' where tenant_id = live and kind = 'handoff';
  raise notice 'CE10 PASS: trailing-space-only change allowed'; n := n + 1;
  insert into canned_responses (tenant_id, kind, locale, body) values (live, 'closing', 'en-US', 'Thanks.');
  update canned_responses set body = 'Thank you.' where tenant_id = live and locale = 'en-US';
  delete from canned_responses where tenant_id = live and locale = 'en-US';
  raise notice 'CE11 PASS: rows outside the default locale editable'; n := n + 1;
  begin
    insert into canned_responses (tenant_id, kind, locale, body) values (live, 'closing', 'en-US', 'Bye.');
    update canned_responses set locale = 'mn-MN' where tenant_id = live and locale = 'en-US';
    raise exception 'CE12 FAILED: moving a row into the default locale went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE12 PASS: moving a row into the default locale refused'; n := n + 1;
  end;

  -- CE13-CE14 (0075): a write that leaves a live tenant's line unsigned stops every reply
  -- (canned_response_unreviewed), so it is refused too.
  begin
    update canned_responses set reviewed_at = null, reviewed_by = null where tenant_id = live and kind = 'handoff';
    raise exception 'CE13 FAILED: un-signing a live row went through';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE13 PASS: un-signing refused'; n := n + 1;
  end;
  begin
    insert into canned_responses (tenant_id, kind, body) values (live, 'handover_reclaim', 'Үргэлжлүүлье.');
    raise exception 'CE14 FAILED: an unsigned model-invisible row went into a live tenant';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE14 PASS: unsigned insert of an invisible kind refused'; n := n + 1;
  end;

  -- CE15: the republish escape does NOT let a live row be un-signed (a republish never
  -- repairs an unsigned row, so nothing is gained and every reply would stop).
  perform set_config('dala.canned_edit', 'republish', true);
  begin
    update canned_responses set body = 'Шинэ.', reviewed_at = null where tenant_id = live and kind = 'handoff';
    raise exception 'CE15 FAILED: the escape let a live row be un-signed';
  exception when raise_exception then
    if sqlerrm not like 'canned_responses:%' then raise; end if;
    raise notice 'CE15 PASS: un-signing refused even with the escape'; n := n + 1;
  end;
  perform set_config('dala.canned_edit', '', true);

  -- The declared republish path.
  perform set_config('dala.canned_edit', 'republish', true);
  update canned_responses set body = 'Шинэ мөр.' where tenant_id = live and kind = 'booking_line';
  perform set_config('dala.canned_edit', '', true);
  select body = 'Шинэ мөр.' into procedure_ok from canned_responses where tenant_id = live and kind = 'booking_line';
  if not procedure_ok then raise exception 'CE9 FAILED: republish-declared edit did not land'; end if;
  raise notice 'CE9 PASS: edit with dala.canned_edit = republish allowed'; n := n + 1;

  if n <> 15 then raise exception 'CANNED EDIT SUITE: % of 15 checks ran', n; end if;
end $$;

do $$ begin raise notice 'CANNED EDIT SUITE PASSED: 15 checks'; end $$;

rollback;
