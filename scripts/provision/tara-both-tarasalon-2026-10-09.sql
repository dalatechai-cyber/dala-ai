-- NOT APPLIED. Both Tara branches (matrix-eco-salon = Яармаг, tara-park-od = Парк Од): every
-- address Дали gives customers becomes https://www.tarasalon.org/ (founder, 2026-10-09: «both Tara
-- domains are attached to the matrix-website project; the booking page works there»).
--
-- RUN ONLY AFTER the founder has signed BOTH sheets:
--   prompt/drafts/tara_tarasalon_yarmag_2026-10-09.mn.txt
--   prompt/drafts/tara_tarasalon_park_od_2026-10-09.mn.txt
-- They list every line this file changes, before and after. The only change in each is the
-- address «https://www.matrixecosalon.org/» → «https://www.tarasalon.org/» (same path after it).
--
-- What changes, per branch (read from Production 2026-10-09):
--   tenant_booking.booking_url; contact_points.website (products.html); canned booking_line
--   (signed here, in the same statement: D-163, a live row is never left unsigned); fixed replies
--   booking and deposit_required; FAQs «Заавал эхлээд урьдчилгаа төлөх үү?» and «Шампунь, маск …»;
--   Яармаг's sales_next_steps booking line and link; and the reply cases that expect the address
--   (Яармаг 185–190, Парк Од 232, 252–257), so the cases test the new lines.
--
-- Both branches in ONE transaction: the branch gate refuses a publish when the two booking links
-- differ, so they move together. Live rows: the transaction declares the republish (0074), and
-- BOTH tenants are published at once after COMMIT (runbook: docs/runbooks/tara-2026-10-09.md).
-- Refuses unless every row is exactly the text read on 2026-10-09; refuses a second run.
-- Undo: tara-both-tarasalon-2026-10-09-revert.sql (also a republish of both).
begin;

set local dala.canned_edit = 'republish';

do $$
declare n int;
begin
  -- Every place the old address lives, counted per table across both tenants; anything else
  -- (a row added since, or already changed) stops the file before it writes.
  select count(*) into n from tenant_booking b join tenants t on t.id = b.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and b.booking_url = 'https://www.matrixecosalon.org/';
  if n <> 2 then raise exception 'tenant_booking: expected 2 rows on the old address, found % (already applied?)', n; end if;
  select count(*) into n from contact_points c join tenants t on t.id = c.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and c.kind = 'website' and c.value = 'https://www.matrixecosalon.org/products.html';
  if n <> 2 then raise exception 'contact_points: expected 2 website rows, found %', n; end if;
  select count(*) into n from canned_responses c join tenants t on t.id = c.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and c.kind = 'booking_line'
     and c.body = 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
  if n <> 2 then raise exception 'canned booking_line: expected 2 rows with the read text, found %', n; end if;
  select count(*) into n from deterministic_replies d join tenants t on t.id = d.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and d.body like '%matrixecosalon%';
  if n <> 4 then raise exception 'deterministic_replies: expected 4 rows (booking, deposit_required x2), found %', n; end if;
  select count(*) into n from faqs f join tenants t on t.id = f.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and f.answer like '%matrixecosalon%';
  if n <> 4 then raise exception 'faqs: expected 4 rows, found %', n; end if;
  select count(*) into n from sales_next_steps s join tenants t on t.id = s.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and (s.body like '%matrixecosalon%' or s.link like '%matrixecosalon%');
  if n <> 1 then raise exception 'sales_next_steps: expected Яармаг''s booking row only, found %', n; end if;
  select count(*) into n from reply_cases r join tenants t on t.id = r.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od')
     and (r.expected_body like '%matrixecosalon%' or array_to_string(r.must_include, '|') like '%matrixecosalon%'
          or array_to_string(r.must_not_include, '|') like '%matrixecosalon%');
  if n <> 13 then raise exception 'reply_cases: expected 13 cases on the old address, found %', n; end if;
  -- Nothing names the new address yet, so the revert can return exactly what this file wrote.
  select count(*) into n from (
    select b.tenant_id from tenant_booking b where b.booking_url like '%tarasalon.org%'
    union all select c.tenant_id from contact_points c where c.value like '%tarasalon.org%'
    union all select c.tenant_id from canned_responses c where c.body like '%tarasalon.org%'
    union all select d.tenant_id from deterministic_replies d where d.body like '%tarasalon.org%'
    union all select f.tenant_id from faqs f where f.answer like '%tarasalon.org%'
    union all select s.tenant_id from sales_next_steps s where s.body like '%tarasalon.org%' or s.link like '%tarasalon.org%'
    union all select r.tenant_id from reply_cases r where r.expected_body like '%tarasalon.org%'
      or array_to_string(r.must_include, '|') like '%tarasalon.org%' or array_to_string(r.must_not_include, '|') like '%tarasalon.org%'
  ) x where x.tenant_id in (select id from tenants where slug in ('matrix-eco-salon', 'tara-park-od'));
  if n <> 0 then raise exception '% row(s) already name tarasalon.org: read them before applying', n; end if;
end $$;

update tenant_booking b set booking_url = 'https://www.tarasalon.org/'
  from tenants t where t.id = b.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and b.booking_url = 'https://www.matrixecosalon.org/';

update contact_points c set value = 'https://www.tarasalon.org/products.html'
  from tenants t where t.id = c.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and c.kind = 'website' and c.value = 'https://www.matrixecosalon.org/products.html';

-- Signed in the same statement: the founder signed the sheets before this file was run.
update canned_responses c
   set body = replace(c.body, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/'),
       reviewed_by = 'founder', reviewed_at = now()
  from tenants t where t.id = c.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and c.kind = 'booking_line' and c.body like '%https://www.matrixecosalon.org/%';

update deterministic_replies d
   set body = replace(d.body, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/')
  from tenants t where t.id = d.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and d.body like '%https://www.matrixecosalon.org/%';

update faqs f
   set answer = replace(f.answer, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/')
  from tenants t where t.id = f.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and f.answer like '%https://www.matrixecosalon.org/%';

update sales_next_steps s
   set body = replace(s.body, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/'),
       link = replace(s.link, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/'),
       reviewed_at = now()
  from tenants t where t.id = s.tenant_id and t.slug = 'matrix-eco-salon'
   and (s.body like '%https://www.matrixecosalon.org/%' or s.link like '%https://www.matrixecosalon.org/%');

update reply_cases r
   set expected_body = replace(r.expected_body, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/'),
       must_include = array(select replace(x, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/') from unnest(r.must_include) with ordinality u(x, i) order by i),
       must_not_include = array(select replace(x, 'https://www.matrixecosalon.org/', 'https://www.tarasalon.org/') from unnest(r.must_not_include) with ordinality u(x, i) order by i)
  from tenants t where t.id = r.tenant_id and t.slug in ('matrix-eco-salon', 'tara-park-od')
   and (r.expected_body like '%https://www.matrixecosalon.org/%' or array_to_string(r.must_include, '|') like '%https://www.matrixecosalon.org/%'
        or array_to_string(r.must_not_include, '|') like '%https://www.matrixecosalon.org/%');

-- Read back: no row of either branch names the old address in any table Дали reads, and the
-- new address is where the old one was.
do $$
declare n int;
begin
  select count(*) into n from (
    select b.tenant_id from tenant_booking b where b.booking_url like '%matrixecosalon%'
    union all select c.tenant_id from contact_points c where c.value like '%matrixecosalon%'
    union all select c.tenant_id from canned_responses c where c.body like '%matrixecosalon%'
    union all select d.tenant_id from deterministic_replies d where d.body like '%matrixecosalon%' or d.web_body like '%matrixecosalon%'
    union all select f.tenant_id from faqs f where f.answer like '%matrixecosalon%' or f.question like '%matrixecosalon%'
    union all select k.tenant_id from knowledge_documents k where k.body like '%matrixecosalon%'
    union all select s.tenant_id from sales_next_steps s where s.body like '%matrixecosalon%' or s.link like '%matrixecosalon%' or s.web_body like '%matrixecosalon%'
    union all select r.tenant_id from reply_cases r where r.expected_body like '%matrixecosalon%' or array_to_string(r.must_include, '|') like '%matrixecosalon%'
      or array_to_string(r.must_not_include, '|') like '%matrixecosalon%'
  ) x where x.tenant_id in (select id from tenants where slug in ('matrix-eco-salon', 'tara-park-od'));
  if n <> 0 then raise exception 'read-back: % row(s) still name matrixecosalon.org', n; end if;
  select count(*) into n from canned_responses c join tenants t on t.id = c.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and c.kind = 'booking_line' and c.reviewed_at is not null
     and c.body = 'Та манай вэбсайтаар (https://www.tarasalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
  if n <> 2 then raise exception 'read-back: the signed booking line is not on both branches (found %)', n; end if;
  select count(*) into n from tenant_booking b join tenants t on t.id = b.tenant_id
   where t.slug in ('matrix-eco-salon', 'tara-park-od') and b.booking_url = 'https://www.tarasalon.org/';
  if n <> 2 then raise exception 'read-back: booking links (found %)', n; end if;
end $$;

commit;
-- NOW publish BOTH (runbook): the booking line and the contact lines moved both prefixes.
