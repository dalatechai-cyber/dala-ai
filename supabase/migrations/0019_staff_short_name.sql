-- 0019 — what customers actually call a staff member, as an attribute of the person.
--
-- ## Why this is a column and not a table
--
-- The obvious build is `staff_aliases`, mirroring `service_aliases`: customer phrasing →
-- canonical person. It was refused deliberately. An alias table answers exactly the names
-- somebody thought to type into it, and the case that actually happens is the one it
-- cannot hold — a customer who half-remembers a name. Matrix Eco Salon has nine staff and
-- ONE short form between them; a table seeded with a single row would look like a
-- mechanism and behave like a constant.
--
-- The behaviour that covers the real case belongs in the gate, not in the data: a name
-- that does not match the roster is not resolved by guessing the nearest one, it is asked
-- about, and the roster is already rendered in the prompt so the model has the answer to
-- offer. That is Ш10, drafted in `prompt/drafts/` and unsigned.
--
-- What remains for the data layer is small and true: some people are commonly called
-- something shorter than their name. That is one nullable column on the person.
--
-- ## Deliberately NOT unique
--
-- Two stylists could both be called «Оюунаа», and a unique constraint would make the
-- schema assert that they cannot be. It would also be defending the wrong thing: under
-- Ш10 a duplicate short name is not an ambiguity the database must prevent, it is an
-- ambiguity the reply resolves by asking — the same path as a name that matches nothing.
-- The constraint would block a true fact in order to protect a guess nobody makes.
--
-- Additive and nullable: no existing row changes, and no INSERT written against the
-- pre-0019 schema breaks.
alter table staff_members
  add column if not exists short_name text
    constraint staff_members_short_name_normalized
    check (short_name is null or short_name is normalized);

comment on column staff_members.short_name is
  'What customers commonly call this person, when that differs from `name`. Rendered in '
  'БАГИЙН ЖАГСААЛТ beside the full name. Not a resolver: a name matching neither column '
  'is handled by asking, per Ш10.';
