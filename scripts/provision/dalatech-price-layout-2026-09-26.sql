-- DalaTech (tenant #0): the general price answer in the founder's approved layout (D-139).
--
-- Founder, 2026-09-26: *"The general price answer («үнэ хэд вэ») is one long paragraph with
-- 10 prices. Replace it with this approved layout"* — the four lines below, verbatim. A
-- question about one coming-soon agent's price is not this row's (it does not cover
-- «вирагийн» etc.) and still gets that agent's price plus the pre-registration line.
--
--  1. `price_overview`'s body becomes the approved layout. Live on write: the row is read per
--     request and is not compiled into the prompt, so no republish.
--  2. The active reply cases that expect the old paragraph expect the new layout in its
--     place — found by their expected body, not by id, and with the follow-up after it kept
--     exactly as it was.
--
-- Run AFTER the code that stops the reply-matched coming-soon row appending to a set answer
-- is deployed (D-139): before it, the old code would add «Вира, Эхо, Нова, Ора хараахан
-- ажиллаж эхлээгүй…» under a layout that already says so.
begin;

with old as (
  select d.tenant_id, d.body as old_body
    from deterministic_replies d join tenants t on t.id = d.tenant_id
   where t.slug = 'dalatech' and d.intent = 'price_overview'
), new as (
  select normalize(E'💬 Дали — AI хүлээн авагч: сард 250,000₮ (суурилуулалт 150,000₮)\n🌐 Ухаалаг вэбсайт: 750,000₮\n🎁 Вэбсайт + Дали багц: 800,000₮\n⏳ Удахгүй: Вира, Эхо, Нова, Ора — урьдчилан бүртгэл авч байна', NFC) as body
), cases as (
  update reply_cases r
     set expected_body = replace(r.expected_body, old.old_body, new.body)
    from old, new
   where r.tenant_id = old.tenant_id and r.active and position(old.old_body in r.expected_body) = 1
  returning r.id
)
update deterministic_replies d
   set body = new.body
  from old, new
 where d.tenant_id = old.tenant_id and d.intent = 'price_overview';

-- Read back before committing: the row, and every case that still quotes the old paragraph (expect none).
select intent, body from deterministic_replies d join tenants t on t.id = d.tenant_id
 where t.slug = 'dalatech' and intent = 'price_overview';
select r.id, left(r.expected_body, 80) from reply_cases r join tenants t on t.id = r.tenant_id
 where t.slug = 'dalatech' and r.active and r.expected_body like 'Сарын төлбөр: Дали%';

commit;
