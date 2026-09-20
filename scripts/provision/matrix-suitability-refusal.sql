-- Item A, 2026-09-20: a suitability question about a chemical process goes to a person.
--
-- THE FOUNDER RUNS THIS FILE. That act is the signature on the sentence — `reviewed_at`
-- is set below because the body is his own wording, given verbatim on 2026-09-20, and
-- because no script in this repository may set that column on its own behalf.
--
-- REQUIRES `0034_refusal_suitability.sql` to be pushed first: it adds the
-- `refusal_suitability` kind to `canned_response_kinds`, and this INSERT is refused by the
-- foreign key until it is. That ordering is D-058 stated forwards — CI applies every
-- migration in the repo, so nothing here can tell you whether the project has this one.
-- Read `supabase_migrations.schema_migrations`, not `ls supabase/migrations/`.
--
-- WHY A ROW AND NOT A GUARD. The failure is composition: the model bridged two true
-- knowledge rows with an invented relationship (D-099). An input filter cannot see that —
-- D-033's lesson — because the parts are individually true and individually approved. What
-- CAN see it is the question's SHAPE: "will this chemical process work on MY hair" is a
-- judgement about hair the model cannot examine, whatever the chemistry attached to it.
--
-- THE MATCHERS ARE MEASURED AGAINST THE REAL CORPUS — all 164 inbound messages Matrix
-- has received, not a set written here. That distinction is the whole history of this
-- block, so read it before adding a pair.
--
-- The first version was measured against 5 suitability questions somebody TYPED INTO THE
-- TEST, and scored 5/5. Re-run against the real corpus the same six pairs scored **3 of
-- 6** — they missed half the genuine suitability questions Matrix's customers have
-- actually sent. An invented corpus measures the matcher against the author's idea of
-- how customers write, which is the thing being tested.
--
-- Two pairs were CUT on the invented corpus and the reason still holds:
--
--   [хими, болох] fired on «Шулуун хими хэд болох вэ» and «Афро хими хэд болох вэ» —
--   every hit a PRICE question, because «хэд болох вэ» is *how much will it be*. A
--   suitability refusal served to a price question is the regression this ends.
--
--   [himi, bold] scored clean only because «bolh» is not a prefix of «bold». Spelling
--   luck, not design, and its Cyrillic twin is known-unsafe. Cut.
--
-- THREE THINGS THE REAL CORPUS TAUGHT that no amount of reasoning would have:
--
--   * **Customers write «ү» as `v`.** «Tas har vsend ene ungu garalt blhu», «Hi vsnii
--     ongo…». Every Latin pair keyed on `usend` alone misses them.
--   * **`ungu` AND `ongo` both occur** for «өнгө» — «ungu garalt» and «ongo gargabal»
--     in the same corpus. Neither romanisation is the right one; both are.
--   * **[буда, хими] is UNSAFE and its narrow form is useless.** Widened, it fires on
--     «тайралт будалт хими» — a customer LISTING services, not asking about suitability.
--     Narrow [будаг, хими] fires on nothing at all. So the Cyrillic twin of [buda, himi]
--     is deliberately absent: measured, not forgotten.
--
-- PROVENANCE OF EACH PAIR IS MARKED BELOW. `attested` means it fires on a real message
-- in the corpus; `twin` means it is the same stems in the other script, firing on nothing
-- yet, kept because that script is 41% of traffic and the concept will arrive in it. A
-- `twin` has zero measured false positives but is NOT evidence — it is a bet, and the
-- ancestor's alias warning is about exactly this kind of bet. Revisit them against the
-- corpus rather than leaving them for ever.
--
-- CURRENT SCORE: 7 fires across 164 real messages, **6/6 genuine suitability questions
-- caught, 0 false positives** — including the four suitability-flavoured PRICE questions
-- («Өөрт тохирох үсний өнгөө олж будуулах д үнэ хэд вэ», «Iim ongo gargabal une bogino
-- usend», «будагтай үсний уг цайруулалт хэд вэ», «Yg iim urtta usend hed bolh be»),
-- every one of which must NOT refuse and does not.
--
-- `contains_stem` was never a candidate: «болох», «үсэнд» and «тохирох» all occur in
-- ordinary price questions, so the ANY-of mode would refuse a large share of them.
-- `stem_sequence` requires both stems IN ORDER inside a 40-codepoint window.

begin;

-- COLUMN LIST READ OFF THE LIVE DATABASE, 2026-09-20, not off docs/schema.md.
-- The first version of this INSERT was written from the doc and would have failed three
-- ways against the project. All three are recorded because they are one mistake:
--
--   1. `provenance` — canned_responses HAS NO SUCH COLUMN. out_of_scope_topics does, which
--      is what made it plausible; the two tables differ and the doc did not say so.
--   2. `on conflict (tenant_id, kind)` — the primary key is (tenant_id, kind, LOCALE), so
--      that clause matches no constraint and errors before a row is considered.
--   3. `locale` omitted. This one would NOT have failed (the column defaults to 'mn-MN'),
--      and it is named anyway: a value this file depends on should be visible in it.
--
-- `reviewed_by = 'founder'` matches the twelve rows already reviewed for this tenant.
-- `body` satisfies CHECK (body IS NORMALIZED) — verified against the live database rather
-- than assumed, because rule 6 makes NFC a property of the bytes, not of the intent.
insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'refusal_suitability', 'mn-MN',
  'Уучлаарай, энэ таны үсэнд тохирох эсэхийг би шийдэж өгөх боломжгүй. Манай мэргэжилтэн үсийг тань харж хэлнэ. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.',
  'founder', now()
from tenants t where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, kind, locale) do nothing;

-- Nine rows rather than one: `out_of_scope_topics.matcher` holds a single matcher, and a
-- stem_sequence carries exactly one ordered pair.
--
-- This INSERT was checked against the live database too and is correct as written: the
-- primary key IS (tenant_id, topic_key) so the ON CONFLICT matches, `provenance` exists and
-- is NOT NULL here, and 'tenant_confirmed' satisfies its CHECK (tenant_confirmed | seeded |
-- inferred). `decision_question` satisfies CHECK (IS NORMALIZED).
--
-- On `tenant_confirmed` rather than `seeded` (D-020): the founder wrote the refusal sentence
-- and approved routing suitability questions to a person, and the stems are measured from
-- this salon's own customer messages. If you would rather the STEMS carried their own
-- weaker provenance, change it here — a `seeded` rule still fires and is still counted, it
-- just reports as unconfirmed.
insert into out_of_scope_topics
  (tenant_id, topic_key, matcher, decision_question, response_kind, deterministic_shortcircuit, provenance)
select t.id, v.key, v.matcher::jsonb,
  'Сүүлийн мессеж тухайн үйлчилгээ энэ хүний үсэнд тохирох эсэхийг асууж байна уу?',
  'refusal_suitability', false, 'tenant_confirmed'
from tenants t, (values
  -- attested: «Хар өнгөтэй үсэнд орох уу»
  ('suitability_mn_orh',   '{"mode":"stem_sequence","stems":["үсэнд","орох"],"windowCp":40}'),
  -- attested: «Office color ungu har usni ungute usend orohu» (twice)
  ('suitability_lat_orh',  '{"mode":"stem_sequence","stems":["usend","oroh"],"windowCp":40}'),
  -- attested: «Budagtai usend himi hiidegv»
  ('suitability_lat_himi', '{"mode":"stem_sequence","stems":["usend","himi"],"windowCp":40}'),
  -- attested: «Budagtai usend himi…» AND «Yag ingej budaad dolgiontoi himi hij boldoguu».
  -- `buda` not `budag`: «budaad» is a different inflection and the narrow stem misses it.
  ('suitability_lat_buda', '{"mode":"stem_sequence","stems":["buda","himi"],"windowCp":40}'),
  -- attested: «Tas har vsend ene ungu garalt blhu» — the Latin «өнгө гарах», which the
  -- first version had no pair for at all. `gara` covers «garalt» and «gargabal».
  ('suitability_lat_ungu', '{"mode":"stem_sequence","stems":["ungu","gara"],"windowCp":40}'),
  -- attested: same message, keyed on the `v`-for-«ү» spelling instead of the colour verb.
  ('suitability_lat_vsend','{"mode":"stem_sequence","stems":["vsend","ungu"],"windowCp":40}'),
  -- attested: «Hi vsnii ongo oorchlowol zohih ongiin songoj ogohvv» — asking US to choose
  -- a colour that suits them, which is the same judgement in a politer shape.
  ('suitability_lat_songo','{"mode":"stem_sequence","stems":["ongo","songo"],"windowCp":40}'),
  -- twin (fires on nothing yet): Cyrillic of suitability_lat_himi.
  ('suitability_mn_himi',  '{"mode":"stem_sequence","stems":["үсэнд","хими"],"windowCp":40}'),
  -- twin (fires on nothing yet): Cyrillic of suitability_lat_ungu.
  ('suitability_mn_ungu',  '{"mode":"stem_sequence","stems":["өнгө","гарах"],"windowCp":40}')
) as v(key, matcher)
where t.slug = 'matrix-eco-salon'
on conflict (tenant_id, topic_key) do nothing;

-- Read these back before committing. Expect 1 and 9.
select count(*) as canned_rows from canned_responses
  where kind = 'refusal_suitability'
    and tenant_id = (select id from tenants where slug = 'matrix-eco-salon');
select count(*) as topic_rows from out_of_scope_topics
  where response_kind = 'refusal_suitability'
    and tenant_id = (select id from tenants where slug = 'matrix-eco-salon');

commit;

-- AFTER THIS: republish. The canned section is inside the cached prefix (D-058), so a new
-- row moves `canned_hash`, and a request compiled against the old snapshot 503s with
-- `canned_stale`. Deploy, `git pull`, then publish — three steps, in that order (D-074).
