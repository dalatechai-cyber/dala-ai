-- DalaTech (tenant #0): the founder's decisions of 2026-09-26 (third set).
--
--  3. QPay, in the founder's words (replacing the wording of 2026-09-26b). A knowledge-base
--     document, so it reaches customers at the next PUBLISH.
--  4. l04: a pre-registration request («Эхог урьдчилан бүртгүүлье, яах вэ?») is answered with
--     the approved callback line — «leave your name and number» — and no model call. The
--     coming-soon rows still append the status line when Вира, Эхо, Нова or Ора is named.
--     v05: paying without an advance, or in instalments, is the team's decision, never «not
--     possible»: the same approved callback line, no model call.
--     Both bodies are read from the reviewed sales callback row, so the two cannot drift.
--     Both rows are read per request: live on commit, no publish needed.
begin;

update knowledge_documents k set body = 'Бүх төлбөрийг, үүнд сарын төлбөр багтана, QPay-ээр төлөх боломжтой.',
       source = 'founder 2026-09-26'
  from tenants t where t.id = k.tenant_id and t.slug = 'dalatech' and k.title = 'Төлбөр';

insert into deterministic_replies (tenant_id, intent, body, enabled, match_mode, stems, cover_words,
                                   placement, quote_services, requires_empty_history, provenance)
select t.id, x.intent, s.body, true, 'contains_stem', x.stems, '{}'::text[], 'replace', '{}'::text[], false, 'tenant_confirmed'
from tenants t
join sales_next_steps s on s.tenant_id = t.id and s.kind = 'callback' and s.enabled and s.reviewed_at is not null
cross join (values
  ('preregister_callback', array['бүртгүүл', 'burtguul', 'burtgvvl']::text[]),
  ('terms_callback', array['урьдчилгаагүй', 'uridchilgaagui', 'urdchilgaagui', 'хувааж', 'huvaaj', 'зээлээр', 'zeeleer']::text[])
) as x(intent, stems)
where t.slug = 'dalatech'
  and not exists (select 1 from deterministic_replies d where d.tenant_id = t.id and d.intent = x.intent);

commit;
