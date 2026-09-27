-- DalaTech (tenant #0): founder's approvals of 2026-09-27, late evening (D-150).
--
--  1. Role names are lower case after the dash, as «Дали — AI хүлээн авагч» already is:
--     the model copied «Вира — Маркетинг менежер» into «Вира бол Маркетинг менежер».
--     Services and document titles; reaches the model at the next publish.
--  2. FAQ 1–4 reworded exactly as proposed in docs/reports/2026-09-27-faq-tone.md, FAQ 5 in
--     the founder's own wording. A FAQ answer is served verbatim on the model path
--     (`gate/pinned.ts`); the new text reaches it at the next publish.
--  3. «Төлбөрийн нөхцөл ямар вэ?» is answered from a row with FAQ 5's words (no model),
--     pinned by exact cases; FAQ 1–4 get model cases (run with --with-model).
begin;
create temp table dt on commit drop as select id from tenants where slug = 'dalatech';
create temp table ren(old text, new text) on commit drop;
insert into ren values
  ('Вира — Маркетинг менежер', 'Вира — маркетинг менежер'),
  ('Нова — Сануулга, SMS', 'Нова — сануулга, SMS'),
  ('Ора — Хувийн туслах', 'Ора — хувийн туслах'),
  ('Эхо — Утасны оператор', 'Эхо — утасны оператор');
update services s set name = normalize(r.new, NFC) from dt, ren r where s.tenant_id = dt.id and s.name = normalize(r.old, NFC);
update knowledge_documents k set title = normalize(replace(k.title, r.old, r.new), NFC), updated_at = now()
  from dt, ren r where k.tenant_id = dt.id and position(normalize(r.old, NFC) in k.title) = 1;

create temp table fq(q text, a text) on commit drop;
insert into fq values
  ('Ямар бизнест тохиромжтой вэ?', 'Харилцагчаас байнга асуулт ирдэг жижиг, дунд бизнест тохиромжтой: дэлгүүр, салон, эмнэлэг, ресторан, авто үйлчилгээ, сургалтын төв гэх мэт.'),
  ('Техникийн мэдлэг хэрэгтэй юу?', 'Техникийн мэдлэг огт шаардлагагүй. Тохиргоо, нэвтрүүлэлтийг бүгдийг нь бид хийж өгнө.'),
  ('Хүний ажилтныг орлох уу?', 'Хүний ажилтныг орлохгүй, харин тэдэнд туслах болно. Давтан асуулт, захиалга, сануулга, тайлан зэрэг өдөр тутмын ачааллыг хариуцаж, шийдвэр шаардсан асуудлыг танай багт шилжүүлдэг.'),
  ('AI ажилтан хэр хугацаанд ажиллаж эхэлдэг вэ?', 'AI ажилтан ихэвчлэн 1–2 долоо хоногийн дотор ажиллаж эхэлдэг.'),
  ('Төлбөрийн нөхцөл ямар вэ?', 'Вэбсайтын төлбөрийн 50%-ийг гэрээ байгуулахад, үлдсэн 50%-ийг хүлээлгэн өгөхөд төлнө; хостингийн төлбөрийг жил бүр төлдөг. AI ажилтны суурилуулалтыг гэрээ байгуулахад нэг удаа, сарын төлбөрийг сар бүрийн 5-ны дотор QPay эсвэл дансаар төлнө.');
update faqs f set answer = normalize(x.a, NFC), provenance = 'tenant_confirmed'
  from dt, fq x where f.tenant_id = dt.id and f.question = normalize(x.q, NFC);

insert into deterministic_replies (tenant_id, intent, body, match_mode, stems, cover_words, placement, provenance, enabled, requires_empty_history, quote_services)
select dt.id, 'payment_terms', normalize(x.a, NFC), 'covers_message',
       array['нөхцөл','нөхцлөө','nuhtsul','nohtsol']::text[],
       array['төлбөрийн','төлбөр','төлөх','төлдөг','хэрхэн','яаж','ямар','юу','уу','вэ','бэ','байдаг','байна','танай','танайх','нь','tulburiin','tulbur','tuluh','herhen','yaj','yamar','yu','uu','ve','be','baidag','tanai','tanaih','ni','payment','terms','what','are','the','your']::text[],
       'replace', 'tenant_confirmed', true, false, '{}'::text[]
  from dt, fq x where x.q = 'Төлбөрийн нөхцөл ямар вэ?'
   and not exists (select 1 from deterministic_replies d where d.tenant_id = dt.id and d.intent = 'payment_terms');

insert into reply_cases (tenant_id, channel, customer_message, expected_body, must_include, must_not_include, note, active)
select dt.id, 'facebook_page', normalize(c.m, NFC),
       case when c.exact then normalize((select a from fq where q = 'Төлбөрийн нөхцөл ямар вэ?') || E'\n\n🤖 Таны Facebook, Instagram, вэбсайтын зурваст 24/7 хариулна.\n🎁 Үнэгүй демо, 24 цагт бэлэн: https://app.dalatech.online\n👉 Бусад AI ажилтнууд: https://dalatech.online', NFC) end,
       c.inc, c.nots, 'D-150 founder 2026-09-27: ' || c.n, true
  from dt, (values
    ('Төлбөрийн нөхцөл ямар вэ?', true, array[]::text[], array[]::text[], 'payment terms from the row, exact'),
    ('tulburiin nuhtsul yamar ve', true, array[]::text[], array[]::text[], 'payment terms from the row, exact'),
    ('Ямар бизнест тохиромжтой вэ?', false, array['тохиромжтой'], array[]::text[], 'FAQ 1, full sentence (needs the model)'),
    ('Техникийн мэдлэг хэрэгтэй юу?', false, array['шаардлагагүй'], array['Хэрэггүй.'], 'FAQ 2, no bare «Хэрэггүй.» (needs the model)'),
    ('AI ажилтан хүний ажилтныг орлох уу?', false, array['орлохгүй'], array['Орлохгүй.'], 'FAQ 3, no bare «Орлохгүй.» (needs the model)')
  ) c(m, exact, inc, nots, n);

do $$ declare n int; begin
  select count(*) into n from services s join tenants t on t.id = s.tenant_id
   where t.slug = 'dalatech' and s.name ~ ' — (Маркетинг|Сануулга|Хувийн|Утасны)';
  if n <> 0 then raise exception '% role names still capitalised', n; end if;
  select count(*) into n from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'dalatech' and k.title ~ ' — (Маркетинг|Сануулга|Хувийн|Утасны)';
  if n <> 0 then raise exception '% document titles still capitalised', n; end if;
  select count(*) into n from faqs f join tenants t on t.id = f.tenant_id, fq x
   where t.slug = 'dalatech' and f.question = normalize(x.q, NFC) and f.answer = normalize(x.a, NFC);
  if n <> 5 then raise exception 'expected 5 FAQ answers replaced, found %', n; end if;
  if not exists (select 1 from deterministic_replies d join tenants t on t.id = d.tenant_id where t.slug = 'dalatech' and d.intent = 'payment_terms') then
    raise exception 'payment_terms row missing';
  end if;
end $$;
commit;
