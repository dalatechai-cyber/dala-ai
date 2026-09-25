-- `contact_points.kind` (and the branch copy) gains `demo_url` (D-127 addendum).
--
-- A software tenant's demo page is a link it wants offered, the way a salon's booking page
-- is. `contact_points` is keyed (tenant_id, kind), so a tenant whose `website` row already
-- holds its homepage has nowhere to put a second link; a kind of its own also lets the
-- prefix label it for what it is rather than as another homepage. Every URL kind reaches
-- the outbound guard's allow-list through `URL_CONTACT_KINDS`, so a demo link the model
-- quotes from the prefix is not refused as an unknown link (D-071's shape).
--
-- Widening two CHECKs, so it is additive by construction: every existing row still
-- satisfies the new constraints, and no data is dropped, rewritten or narrowed.

alter table contact_points drop constraint if exists contact_points_kind_check;
alter table contact_points add constraint contact_points_kind_check
  check (kind in ('phone','email','address','maps_url','facebook','instagram','website','demo_url'));

alter table branch_contact_points drop constraint if exists branch_contact_points_kind_check;
alter table branch_contact_points add constraint branch_contact_points_kind_check
  check (kind in ('phone','email','address','maps_url','facebook','instagram','website','demo_url'));
