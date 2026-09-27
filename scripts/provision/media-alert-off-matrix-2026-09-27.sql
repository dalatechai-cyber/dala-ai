-- Founder, 2026-09-27 (D-153): Tara (matrix-eco-salon) gets no Telegram alert for a media
-- hand-off. The media line and the 30-minute silence are unchanged, and every other Tara alert
-- (leads, errors, token problems) is untouched. DalaTech keeps the default (alert on).
-- Needs 0062 applied.
begin;
update tenants set media_handoff_alert = false where slug = 'matrix-eco-salon';
do $$ declare n int; begin
  select count(*) into n from tenants where slug = 'matrix-eco-salon' and media_handoff_alert = false;
  if n <> 1 then raise exception 'matrix-eco-salon not switched off (% rows)', n; end if;
  select count(*) into n from tenants where slug = 'dalatech' and media_handoff_alert = true;
  if n <> 1 then raise exception 'dalatech alert not on (% rows)', n; end if;
end $$;
commit;
