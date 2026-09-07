-- Matrix Eco Salon — Stage 3b: the children's rule and the last two canned lines.
--
-- Approved by the founder on 2026-09-07, as drafted and unedited. Every Mongolian string
-- below was pasted to them for review first; nothing here was written after approval.
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
-- 2. There is no new gate to write — the platform already has one
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
--
-- ===========================================================================
-- 4. ONE reviewed_at across all eleven
-- ===========================================================================
--
-- The founder asked for these two to carry the same `reviewed_at` as the other nine, so
-- the tenant's pinned lines are one act of review rather than two. The timestamp is READ
-- from the existing rows rather than written fresh: a literal would be a second copy of a
-- fact the database already holds, and `now()` would silently produce two review instants
-- for one review. The run refuses unless exactly nine rows are already there to read it
-- from, because "insert these two alongside the nine" is false if the nine are not.
--
-- Idempotent: inserted only where absent, with assertions that fail loudly on divergence.

begin;

do $$
declare
  v_tenant   uuid;
  v_reviewed timestamptz;
  v_rows     int;
  v_stamps   int;
begin
  select id into strict v_tenant from tenants where slug = 'matrix-eco-salon';

  -- Read the shared instant off whatever is already there. The entry guard asks only
  -- what it actually needs — that there IS one reviewed instant and only one — and
  -- deliberately does not assert a row count.
  --
  -- It used to assert exactly nine, and a mutation test caught what that costs: delete a
  -- single line and the file refuses at the door, so the one file that could repair a
  -- half-provisioned tenant is the one file that will not run against it. A precondition
  -- has to be about what the work needs, not about the state the author happened to see.
  select count(*), count(distinct reviewed_at) into v_rows, v_stamps
    from canned_responses where tenant_id = v_tenant and locale = 'mn-MN';

  if v_rows = 0 then
    raise exception 'stage 3b: no canned lines exist yet — run matrix-stage3-canned.sql first';
  end if;
  if v_stamps <> 1 then
    raise exception 'stage 3b: the existing lines carry % distinct reviewed_at values, not one', v_stamps;
  end if;

  select min(reviewed_at) into strict v_reviewed
    from canned_responses where tenant_id = v_tenant and locale = 'mn-MN';
  if v_reviewed is null then
    raise exception 'stage 3b: the existing lines are unreviewed; there is no instant to share';
  end if;

  -- ------------------------------------------------------------------------
  -- The line the children's rule fires into. VERBATIM from the ancestor's
  -- CHILDREN_REPLY (`Matrix-Chatbot/lib/salonBrain.js:70`), phone number and all.
  -- 114 characters, 100% Cyrillic over letters, NFC, no "lower_snake" token.
  -- ------------------------------------------------------------------------
  insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
  select v_tenant, 'refusal_topic', 'mn-MN',
         'Уучлаарай, хүүхдийн үйлчилгээний мэдээллийг би өгөх боломжгүй. Та салоны 7741-7777 дугаараар холбогдож лавлана уу.',
         'founder', v_reviewed
  where not exists (
    select 1 from canned_responses c
     where c.tenant_id = v_tenant and c.kind = 'refusal_topic' and c.locale = 'mn-MN');

  -- ------------------------------------------------------------------------
  -- The ELEVENTH line, which is not about children at all.
  --
  -- `matrix-stage4-kb.sql` wrote an `out_of_scope_topics` row for `photo_consultation`
  -- pointing at `refusal_out_of_scope`, and Matrix had no such canned row. Nothing caught
  -- it, because a `response_kind` is never rendered into the compiled prefix — so
  -- `kindsReferencedBy` could not see it, the gate would have fired, the model would have
  -- been told to copy a sentence letter for letter, and the sentence would not have been
  -- there. `kindsRequiredByRules` (D-050) now refuses that state before the model is
  -- called. This is the data half of the same fix.
  -- 110 characters, 100% Cyrillic, NFC.
  -- ------------------------------------------------------------------------
  insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
  select v_tenant, 'refusal_out_of_scope', 'mn-MN',
         'Зураг харж зөвлөгөө өгөх боломжгүй. Манай мэргэжилтэн Танд туслах болно. Та 7741-7777 дугаараар холбогдоно уу.',
         'founder', v_reviewed
  where not exists (
    select 1 from canned_responses c
     where c.tenant_id = v_tenant and c.kind = 'refusal_out_of_scope' and c.locale = 'mn-MN');

  -- ------------------------------------------------------------------------
  -- The rule. `decision_question` renders into Ш1's list as
  -- «- children_services: <question>» and is read by the model, not sent to a customer.
  -- ------------------------------------------------------------------------
  insert into disclosure_rules
    (tenant_id, topic_key, matcher, decision_question, response_kind,
     quote_price, forbidden_outputs, deterministic_shortcircuit, provenance)
  select v_tenant, 'children_services',
         '{"mode":"contains_stem","stems":["хүүхэд","хүүхд"]}'::jsonb,
         'Хүүхдийн үйлчилгээ, хүүхдийн үнийн тухай асууж байна уу?',
         'refusal_topic',
         false,          -- no numeral at all in a reply this fired on
         '{}',           -- see the note at the foot: nothing reads this column yet
         false,          -- no precision run has been done
         'tenant_confirmed'
  where not exists (
    select 1 from disclosure_rules d
     where d.tenant_id = v_tenant and d.topic_key = 'children_services');

  -- ------------------------------------------------------------------------
  -- End state, asserted rather than assumed.
  -- ------------------------------------------------------------------------
  select count(*), count(distinct reviewed_at) into v_rows, v_stamps
    from canned_responses where tenant_id = v_tenant and locale = 'mn-MN';
  if v_rows <> 11 then
    raise exception 'stage 3b: expected 11 canned rows, found %', v_rows;
  end if;
  if v_stamps <> 1 then
    raise exception 'stage 3b: the eleven carry % distinct reviewed_at values, not one', v_stamps;
  end if;

  -- Every kind a rule points at must have a reviewed line, which is D-050's rule read
  -- back out of the data instead of out of the code that enforces it.
  if exists (
    select 1 from (
      select response_kind from disclosure_rules where tenant_id = v_tenant
      union select response_kind from out_of_scope_topics where tenant_id = v_tenant
    ) r
    where not exists (
      select 1 from canned_responses c
       where c.tenant_id = v_tenant and c.kind = r.response_kind
         and c.locale = 'mn-MN' and c.reviewed_at is not null)
  ) then
    raise exception 'stage 3b: a rule points at a kind with no reviewed line';
  end if;
end $$;

commit;

-- ===========================================================================
-- Two things this file does NOT do, deliberately
-- ===========================================================================
--
-- `approved_by` is null. It references `platform_admins(user_id)`, and that table is empty
-- on the project — there is no admin row to point at. Seeding one is credential-adjacent
-- and the founder's. Until it exists, the record of who approved a deliberate omission
-- lives in this file's git history rather than in the column built for it, which is worse
-- and worth fixing before the next tenant.
--
-- `forbidden_outputs` is `{}`. The column looks like the right home for «33,000» — the
-- exact fabrication Ш1 exists to prevent — but `reception/load.ts` does not select it, so
-- nothing reads it. Writing a value there would look like a control and be inert, which is
-- the `purge_after` mistake (D-044). The suppression is done by `quote_price = false`,
-- which IS read.
