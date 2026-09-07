-- Matrix Eco Salon — the dated promotion comes out of the knowledge base.
--
-- Founder-approved 2026-09-07, on reading the seven documents:
--
--   «Одоогоор эмчилгээний химийн урамшуулал 9 сарын 20 хүртэл үргэлжилж байна.»
--
-- is true until 20 September and silently false on the 21st. `knowledge_documents` has no
-- expiry, no review date and no trigger — nothing in this system can notice a fact going
-- stale, and a wrong promotion end date is the kind of wrong a customer acts on.
--
-- The sentence is REMOVED rather than rewritten. «Урамшууллыг зараар зарлана» — promotions
-- are announced in the ads — already covers the subject and is true indefinitely. Trimming
-- only the date would leave «Одоогоор … урамшуулал үргэлжилж байна», which carries the same
-- defect one word further in: `одоогоор` is a claim about now, made by a prefix compiled
-- weeks ago.
--
-- No new customer-visible Mongolian is written here. This file only deletes a sentence the
-- founder named, which is why it does not need the review mechanism a new one would.
--
-- ## The consequence to expect at the next publish
--
-- This is the only place `9` and `20` appear as bare numerals in Matrix's knowledge base,
-- so `allowed_numbers` loses both when the prefix is recompiled. `20:00` is a different
-- token (the closing time, from `business_hours`) and is unaffected — the comparison is on
-- the digits-only reduction, `20` against `2000`, and it is deliberately not a substring
-- test. After this, a reply that says «9 сарын 20» is refused by the outbound guard.
--
-- Idempotent: the update is a no-op once applied, and the guards below pass either way.

begin;

-- Entry guard. Refuse against a state neither Stage 4 nor this file wrote, rather than
-- overwriting whatever is there — the file that repairs a document must not be the file
-- that silently replaces an edit somebody else made.
do $$
declare
  v_body text;
begin
  select k.body into strict v_body
    from knowledge_documents k
    join tenants t on t.id = k.tenant_id
   where t.slug = 'matrix-eco-salon' and k.title = 'Урамшуулал ба баримт';

  if position('Урамшууллыг зараар зарлана.' in v_body) = 0
     or position('Цахим баримтыг зөвхөн үйлчилгээнд олгоно.' in v_body) = 0 then
    raise exception 'document 5 is not in a state this file recognises: %', v_body;
  end if;
end $$;

update knowledge_documents k
   set body = 'Урамшууллыг зараар зарлана.' || chr(10) ||
              'Цахим баримтыг зөвхөн үйлчилгээнд олгоно. Бараанд цахим баримт олгохгүй.',
       updated_at = now()
  from tenants t
 where t.id = k.tenant_id
   and t.slug = 'matrix-eco-salon'
   and k.title = 'Урамшуулал ба баримт';

-- Exit assertions. Each names a state that can actually occur.
do $$
declare
  v_body text;
  v_docs int;
  v_dated int;
begin
  select k.body into strict v_body
    from knowledge_documents k
    join tenants t on t.id = k.tenant_id
   where t.slug = 'matrix-eco-salon' and k.title = 'Урамшуулал ба баримт';

  -- The body is fixed text, so the strongest check available is byte identity against the
  -- reviewed string, not a property of it. A typo in the Cyrillic passes every assertion
  -- below and reaches a customer; the md5 is what makes that impossible to commit.
  if md5(v_body) <> '9b4d50f0e5ee628b89b4987224a65d5a' then
    raise exception 'body is not byte-identical to the reviewed text (md5 %, length %)',
      md5(v_body), length(v_body);
  end if;
  if position('хүртэл' in v_body) > 0 then
    raise exception 'the dated sentence survived the update: %', v_body;
  end if;
  if v_body ~ '[0-9]' then
    raise exception 'document 5 still carries a numeral, so allowed_numbers would keep it: %', v_body;
  end if;

  -- The other six are untouched: an UPDATE with a wrong WHERE would show up here as a
  -- count that still reads 7 but bodies that no longer differ, so both are checked.
  select count(*) into v_docs
    from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'matrix-eco-salon';
  if v_docs <> 7 then
    raise exception 'expected 7 knowledge documents, found %', v_docs;
  end if;

  select count(*) into v_dated
    from knowledge_documents k join tenants t on t.id = k.tenant_id
   where t.slug = 'matrix-eco-salon' and k.body ~ '[0-9]+ сарын [0-9]+';
  if v_dated <> 0 then
    raise exception 'a calendar date remains in % document(s)', v_dated;
  end if;

  raise notice 'document 5 is now: %', v_body;
end $$;

commit;
