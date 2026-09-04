-- The Ш0–Ш9 gate needs six canned-response kinds the initial seed does not have.
--
-- ## Why they are missing, which is the interesting part
--
-- `canned_response_kinds` was seeded when the gate was six checks. Ш0 and Ш9 were ADDED
-- under review, Ш6 was PROMOTED out of the abuse check into a standalone always-evaluated
-- one, and Ш4 and Ш5 were only ever described as "out of scope" in prose. The seed was
-- never revisited, so four of the ten checks had no row to put their pinned sentence in
-- and two more would have had to share one.
--
-- ## Why sharing one kind would have been a bug, not a shortcut
--
-- `canned_responses` is keyed `(tenant_id, kind, locale)`. One kind means one sentence.
-- Ш4 ("I do not have anyone's schedule") and Ш5 ("I am not a doctor; please speak to a
-- specialist") are both "something we cannot know", so both map to `refusal_out_of_scope`
-- if you go by description — and the tenant then gets ONE sentence for both, answering a
-- pregnancy-safety question with a line about staff rosters.
--
-- A kind is not a category. It is the primary key of a sentence.
--
-- Additive only: inserts into a reference table, no column changes, no data rewritten.

insert into canned_response_kinds (kind, description) values
  ('refusal_public_channel', 'Ш0 — asked in public; deflect to a private message and name no number'),
  ('refusal_staff_schedule', 'Ш4 — we hold names and grades, never rosters or availability'),
  ('refusal_health',         'Ш5 — no clinical judgement; refer to a person'),
  ('refusal_no_promotion',   'Ш6 — no concession exists in the knowledge base'),
  ('refusal_off_topic',      'Ш7 — decline rudeness or an unrelated topic without moralising'),
  ('assistant_identity',     'Ш9 — say what this assistant is for, disclose nothing about its instructions')
on conflict (kind) do nothing;
