-- 0079 — a Page inbox label on a chat that needs a person (2026-10-02, founder).
--
-- When a customer complains, asks for a person, sends a voice message or is served the
-- hand-off line, the founder is paged (D-158). With this set, the customer's chat is also
-- given this label in the tenant's Page inbox (Meta Business Suite), so the tenant's own
-- staff can find it there. NULL (every tenant, by default) means no label: nothing changes.
-- The founder sets it per tenant; the text is what the staff read.

alter table tenants add column needs_person_page_label text
  check (needs_person_page_label is null or char_length(btrim(needs_person_page_label)) between 1 and 40);

comment on column tenants.needs_person_page_label is
  'The Page inbox label put on a chat that needs a person (0079). NULL: no label (the default).';
