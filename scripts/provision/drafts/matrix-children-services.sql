-- DRAFT — NOT APPLIED, NOT FOR RUNNING. Read this, edit it, then say to insert it.
--
-- Matrix's children's-services rule and the canned lines that answer it. Every Mongolian
-- string below is founder-gated: two of them are sentences a customer reads, and the third
-- is prompt text about a topic the business has decided to withhold. Nothing here has been
-- inserted into any database, and this file lives outside `scripts/provision/` for the same
-- reason `prompt/drafts/` exists — so that running everything in the provision directory
-- cannot run it by accident.
--
-- ===========================================================================
-- 1. The table is `disclosure_rules`, not `out_of_scope_topics`
-- ===========================================================================
--
-- I said `out_of_scope_topics` when I raised this. That was wrong, and the distinction is
-- 0001's own, written into the two tables' comments:
--
--   * `out_of_scope_topics` — "We cannot know." Clinical advice, a customer's job status.
--   * `disclosure_rules`    — "We know and will not say." A deliberate omission.
--
-- Matrix cuts children's hair and «Чёлк тайралт» is a line in their price list. They know
-- the price perfectly well and have decided the bot does not quote it. That is the second
-- table by definition, and three concrete things follow from getting it right:
--
--   * `disclosure_rules.quote_price` exists and `out_of_scope_topics` has no such column.
--     False here means no numeral may be emitted at all in a reply this rule fired on.
--   * `disclosure_rules.approved_by` references `platform_admins` — the column that
--     records WHO decided to withhold. A deliberate omission with no approver is the thing
--     that column exists to make impossible. It stays null below only because
--     `platform_admins` is empty on the project; see the note at the foot.
--   * `canned_response_kinds.refusal_topic` is described, in the database, as "A deliberate
--     omission, bound to a disclosure_rule". The kind already knows which table it belongs
--     to.
--
-- ===========================================================================
-- 2. There is no tenth canned line to write — the platform already has the gate
-- ===========================================================================
--
-- Ш1 (`prompt/platform/sh1_refusal_topics.mn.txt`, signed) is ALREADY the children's rule,
-- ported and native-speaker reviewed. It carries the ancestor's wrong-example verbatim —
-- «Хүүхдийн чёлк тайралт хэд вэ?» answered «Чёлк тайралт 33,000₮» — and it carries the
-- second half of the ancestor's rule that I had listed as missing: «Том хүн үү, хүүхэд үү»
-- гэж БҮҮ асуу. So the port needs no new gate text and no new canned KIND. It needs the
-- tenant row that puts «children_services» into Ш1's «ХОРИОТОЙ СЭДВҮҮД» list, and the
-- `refusal_topic` line for the model to copy.
--
-- `GATE_BY_RESPONSE_KIND` maps `refusal_topic` to Ш1 already. A kind I had invented would
-- have fallen through to `DEFAULT_GATE` = Ш8 and answered the handoff line instead.
--
-- ===========================================================================
-- 3. The stems, and what they deliberately do not match
-- ===========================================================================
--
-- `MIN_STEM_CHARS` is 4 and matching is TOKEN-INITIAL (`containsStem` uses a lookbehind for
-- a non-letter). A single stem «хүүх» would clear the floor and cover every child form —
-- and would also fire on «хүүхэн», a word for a woman. A false positive here is not
-- harmless: `quote_price = false` suppresses every numeral in that reply, so an adult
-- woman asking a price would be refused one. Two stems avoid it exactly:
--
--   хүүхэд  ->  хүүхэд, хүүхэдтэй, хүүхэдгүй
--   хүүхд   ->  хүүхдийн, хүүхдэд, хүүхдүүд, хүүхдүүдийн, хүүхдээ, хүүхдийнхээ
--   neither ->  хүүхэн, хүүхнүүд, хүүхэлдэй, хүү
--
-- Run through the real `containsStem`, not by hand: nine cases, all as designed.
--
-- `deterministic_shortcircuit` stays FALSE. §10's arbitration allows it only "after a
-- measured precision run", and the corpus that run needs is what the mirror phase is for.
-- The matcher therefore selects which rules the reply is held to; it does not silence it.

begin;

-- ---------------------------------------------------------------------------
-- The rule.
-- ---------------------------------------------------------------------------
-- `decision_question` renders into Ш1's list as «- children_services: <question>» and is
-- read by the model, not sent to a customer. It is still yours to approve: it is Mongolian
-- that decides whether a refusal fires.
insert into disclosure_rules
  (tenant_id, topic_key, matcher, decision_question, response_kind,
   quote_price, forbidden_outputs, deterministic_shortcircuit, provenance)
select t.id, 'children_services',
       '{"mode":"contains_stem","stems":["хүүхэд","хүүхд"]}'::jsonb,
       'Хүүхдийн үйлчилгээ, хүүхдийн үнийн тухай асууж байна уу?',
       'refusal_topic',
       false,          -- no numeral at all in a reply this fired on
       '{}',           -- see the note at the foot: nothing reads this column yet
       false,          -- no precision run has been done
       'tenant_confirmed'
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from disclosure_rules d
     where d.tenant_id = t.id and d.topic_key = 'children_services'
  );

-- ---------------------------------------------------------------------------
-- The line the rule fires into. VERBATIM from the ancestor's CHILDREN_REPLY
-- (`Matrix-Chatbot/lib/salonBrain.js:70`), phone number and all.
-- 114 characters, 100% Cyrillic over letters, NFC, no "lower_snake" token.
-- ---------------------------------------------------------------------------
insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'refusal_topic', 'mn-MN',
       'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 7741-7777 дугаараар холбогдож лавлана уу.',
       'founder', now()
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from canned_responses c
     where c.tenant_id = t.id and c.kind = 'refusal_topic' and c.locale = 'mn-MN'
  );

-- ---------------------------------------------------------------------------
-- The ELEVENTH line, which is not about children at all — and is why this file
-- has two inserts rather than one.
-- ---------------------------------------------------------------------------
--
-- `matrix-stage4-kb.sql` wrote an `out_of_scope_topics` row for `photo_consultation`
-- pointing at `refusal_out_of_scope`, and Matrix has no such canned row. I wrote that row
-- and did not notice. Nothing caught it, because a `response_kind` is never rendered into
-- the compiled prefix, so `kindsReferencedBy` cannot see it — the gate would have fired,
-- told the model to copy a sentence letter for letter, and the sentence would not have
-- been there.
--
-- The code half of that is fixed and merged (`kindsRequiredByRules`): the missing row now
-- refuses with `canned_response_missing` before the model is called. This is the data half.
-- Until this line exists, Matrix cannot publish — which is the correct direction, and is
-- exactly what the code change was for.
--
-- Draft, from the salon's own answer that photo consultations are done by a person:
insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, 'refusal_out_of_scope', 'mn-MN',
       'Зураг харж зөвлөгөө өгөх боломжгүй. Манай мэргэжилтэн Танд туслах болно. Та 7741-7777 дугаараар холбогдоно уу.',
       'founder', now()
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from canned_responses c
     where c.tenant_id = t.id and c.kind = 'refusal_out_of_scope' and c.locale = 'mn-MN'
  );

commit;

-- ===========================================================================
-- Two things this draft does NOT do, deliberately
-- ===========================================================================
--
-- `approved_by` is null. It references `platform_admins(user_id)`, and that table is empty
-- on the project — there is no admin row to point at. Seeding one is credential-adjacent
-- and yours. Until it exists, the record of who approved a deliberate omission lives in
-- this file's git history rather than in the column built for it, which is worse and worth
-- fixing before the next tenant.
--
-- `forbidden_outputs` is `{}`. The column looks like the right home for «33,000» — the
-- exact fabrication Ш1 exists to prevent — but `reception/load.ts` does not select it, so
-- nothing reads it. Writing a value there would look like a control and be inert, which is
-- the `purge_after` mistake (D-044). The suppression is done by `quote_price = false`,
-- which IS read.
