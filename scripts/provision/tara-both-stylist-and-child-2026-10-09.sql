-- NOT APPLIED. Both Tara branches (matrix-eco-salon = Яармаг, tara-park-od = Парк Од): reply cases
-- for the pull request «A hairdresser named, a child's cut, a deposit for her level» (D-184).
-- Run AFTER that pull request is deployed, and after runbook 2026-10-09's steps 5–9 (it changes
-- the case counts that runbook expects). Without the code the six new cases reach the model and are
-- only listed as «need the model» (checked on a replica). No wording changes, no publish needed.
--
-- Expected (replica equal to Production after Яармаг seq 22 and Парк Од seq 2, 2026-10-09 15:25 UTC):
--   before:  `node scripts/replycases/gate.ts --slug matrix-eco-salon` → 66/66 · 16 need the model;
--            tara-park-od → 67/67 · 52 need the model (82 and 119 active cases).
--   after this file: 69/69 · 16 and 70/70 · 52 (85 and 122 active cases). Publish dry runs:
--            «byte-identical … Nothing to publish» on both (ecaf14d1…, 49fd77f4…).
--   after tara-both-nearest-branch-2026-10-09.sql as well: 73/73 · 19 and 74/74 · 55 (92 and 129):
--            case 197 / 264 («Аль салбар нь ойр вэ» after the deposits) is then answered by the row.
--
-- 1. A hairdresser named alone or with a booking ask is answered from the rows: her name and level,
--    (alone) her level's services, her level's deposit, the booking line. Яармаг with Oyunaa
--    (Cyrillic «Оюунаа» through her spelling row, and Latin); Парк Од with Boloroo (Latin only:
--    her hairdressers have no Cyrillic spellings yet, never guessed). Checked by what must and
--    must not be in the reply, never the whole text, so the cases survive the tarasalon.org move.
-- 2. The child's-cut cases (129/134 Яармаг, 289/291 Парк Од, model cases) must not list
--    «Үс оношлогоо, зөвлөгөө» (it shares 33,000₮ with the boy's cut; the fix is in guard/facts.ts).
--
-- 3. Switches the hairdresser answer ON for both branches (`tenants.reply_style.stylist_named`,
--    D-184). RUN ONLY AFTER the founder has signed prompt/drafts/tara_stylist_named_2026-10-09.mn.txt:
--    the answers on that sheet reach customers from this file's COMMIT, no publish.
--
-- Arrays are written ARRAY['…'], never '{…}': '{20,000₮}' would be two items (2026-10-05 review).
-- Refuses a second run. Undo: the -revert.sql beside it.
begin;

do $$
begin
  if exists (select 1 from reply_cases r join tenants t on t.id = r.tenant_id
             where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'stylist named 2026-10-09%') then
    raise exception 'tara-both-stylist-and-child-2026-10-09.sql is already applied';
  end if;
  if (select count(*) from reply_cases r join tenants t on t.id = r.tenant_id
      where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.active
        and r.customer_message in ('8 настай хүүгийн үс тайралт хэд вэ?', '15 настай хүүгийн үс тайралт хэд вэ?')
        and cardinality(r.must_not_include) = 0) <> 4 then
    raise exception 'expected the four child''s-cut cases with no must_not_include (read 2026-10-09)';
  end if;
  if (select count(*) from tenants where slug in ('matrix-eco-salon', 'tara-park-od')
      and reply_style = '{"max_emoji": 1}'::jsonb) <> 2 then
    raise exception 'expected reply_style {"max_emoji": 1} on both branches (read 2026-10-09)';
  end if;
end $$;

update tenants set reply_style = reply_style || '{"stylist_named": true}'::jsonb
 where slug in ('matrix-eco-salon', 'tara-park-od');

insert into reply_cases (tenant_id, customer_message, must_include, must_not_include, note, active, channel)
select t.id, c.msg, c.inc, c.exc, 'stylist named 2026-10-09 (exact): ' || c.why, true, 'facebook_page'
  from tenants t
  join (values
    ('matrix-eco-salon', 'Оюунаа',
      ARRAY['Oyunaa — SPECIAL үсчин', 'Эмэгтэй тайралт (SPECIAL): 120,000₮', 'Урьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮', 'QPay'],
      ARRAY['тодруулж', '10,000₮'], 'Яармаг 2026-10-04 05:49, the model asked «тодруулж бичнэ үү»'),
    ('matrix-eco-salon', 'Oyunaa',
      ARRAY['Oyunaa — SPECIAL үсчин', 'Эмэгтэй тайралт (SPECIAL): 120,000₮', 'Урьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮', 'QPay'],
      ARRAY['тодруулж', '10,000₮'], 'the Latin name'),
    ('matrix-eco-salon', 'Оюунаад цаг авч болох уу?',
      ARRAY['Oyunaa — SPECIAL үсчин', 'Урьдчилгаа төлбөр — SPECIAL үсчин: 20,000₮', 'QPay'],
      ARRAY['10,000₮', 'Мастер үсчин: 20,000₮'], 'Яармаг 2026-10-04 05:51 and 06:45, served all three deposit rows'),
    ('tara-park-od', 'Boloroo',
      ARRAY['Boloroo — SPECIAL үсчин', 'Эмэгтэй тайралт (SPECIAL): 120,000₮', 'Урьдчилгаа төлбөр: SPECIAL болон Мастер үсчин: 20,000₮', 'QPay'],
      ARRAY['тодруулж'], 'Парк Од, mirroring Яармаг''s «Оюунаа»'),
    ('tara-park-od', 'boloroo',
      ARRAY['Boloroo — SPECIAL үсчин', 'Эмэгтэй тайралт (SPECIAL): 120,000₮', 'Урьдчилгаа төлбөр: SPECIAL болон Мастер үсчин: 20,000₮', 'QPay'],
      ARRAY['тодруулж'], 'Парк Од, lower case, mirroring Яармаг''s «Oyunaa»'),
    ('tara-park-od', 'Boloroo-d tsag avch boloh uu?',
      ARRAY['Boloroo — SPECIAL үсчин', 'Урьдчилгаа төлбөр: SPECIAL болон Мастер үсчин: 20,000₮', 'QPay'],
      ARRAY['тодруулж'], 'Парк Од, mirroring Яармаг''s «Оюунаад цаг авч болох уу?» (Latin: no Cyrillic spelling for her names yet)')
  ) as c(slug, msg, inc, exc, why) on c.slug = t.slug;

update reply_cases r set must_not_include = ARRAY['оношлогоо']
  from tenants t
 where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od') and r.active
   and r.customer_message in ('8 настай хүүгийн үс тайралт хэд вэ?', '15 настай хүүгийн үс тайралт хэд вэ?')
   and cardinality(r.must_not_include) = 0;

do $$
begin
  if (select count(*) from reply_cases r join tenants t on t.id = r.tenant_id
      where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.note like 'stylist named 2026-10-09%' and r.active) <> 6
     or (select count(*) from reply_cases r join tenants t on t.id = r.tenant_id
         where t.slug in ('matrix-eco-salon', 'tara-park-od') and r.active
           and r.customer_message in ('8 настай хүүгийн үс тайралт хэд вэ?', '15 настай хүүгийн үс тайралт хэд вэ?')
           and r.must_not_include = ARRAY['оношлогоо']) <> 4
     or (select count(*) from tenants where slug in ('matrix-eco-salon', 'tara-park-od')
         and reply_style = '{"max_emoji": 1, "stylist_named": true}'::jsonb) <> 2 then
    raise exception 'read-back failed';
  end if;
end $$;

commit;
