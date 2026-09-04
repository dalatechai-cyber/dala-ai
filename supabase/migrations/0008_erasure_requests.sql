-- 0008 — Meta's Data Deletion Request callback, and the row it writes (§2.4F, §10.5).
--
-- App Review requires a Data Deletion Request callback URL. `10-completeness.md` §5 lists
-- it as one of the deliverables that bounces a submission on its own, and records that
-- nothing had designed it. This is that design's storage half.
--
-- ADDITIVE ONLY. Columns, constraints and indexes on a table that exists and is empty.
-- Nothing is dropped, rewritten or narrowed.
--
-- ## Why 0001's version is not enough
--
-- 0001 has `(id, tenant_id, provider, external_id, requested_at, completed_at,
-- confirmation_code)`. Three things it cannot say, each of which is load-bearing:
--
--  1. **WHAT KIND of id `external_id` is.** Meta's callback sends an **app-scoped id
--     (ASID)**. Every `contacts.external_id` in this database is a **page-scoped id
--     (PSID)** or an IGSID. They are different namespaces for the same human. A lookup
--     that treats them as one finds nothing, deletes nothing, and returns a confirmation
--     code — a privacy promise silently unhonoured, which is the exact shape of failure
--     this codebase exists to refuse. So the kind is recorded, and it is NOT NULL for a
--     callback row.
--  2. **WHERE the request came from.** §2.4F designs three sources and 0001 dropped the
--     column. `tenant_request` and `customer_direct` have different obligations and
--     different evidence trails from `meta_callback`.
--  3. **HOW FAR IT GOT.** `completed_at is null` conflates "just arrived", "we could not
--     find this person", and "the job failed". Those are three different things for an
--     operator holding a legal clock, so `status` says which.
--
-- ## `tenant_id` stays NULLABLE, and that is the correction 0001 already made
--
-- §2.4F's draft DDL has `tenant_id uuid not null`. It cannot be. The callback is
-- APP-scoped: one Meta app serves every tenant, and an ASID names a person's relationship
-- with the APP, not with a salon. At the moment the request arrives we do not know whose
-- customer this is — that is the whole content of the matching problem above. A NOT NULL
-- here would have forced a guess on the one path where guessing is least acceptable.

alter table contact_erasure_requests
  -- 'asid' is what Meta's callback sends; 'psid'/'igsid' are what we store. Naming the
  -- namespace is what stops a future join pretending they are interchangeable.
  add column if not exists id_kind text,
  -- §2.4F's three sources, restored.
  add column if not exists source text,
  -- Which app secret verified the signed_request. An ASID is meaningless outside the app
  -- that issued it, so resolving one later requires knowing which app that was.
  add column if not exists app_slug text,
  -- Meta's own `issued_at` from the signed request, for the audit trail. Recorded, never
  -- compared against a window: a privacy request is not dropped over a timestamp.
  add column if not exists issued_at timestamptz,
  add column if not exists status text not null default 'received',
  -- Set once the ASID has been mapped to a contact we actually hold.
  add column if not exists contact_id uuid,
  -- "The job said it worked" is not evidence. Per-table counts are.
  add column if not exists rows_deleted jsonb,
  -- Why a request is in `no_match` or `failed`, in words, for the person who has to act.
  add column if not exists detail text;

-- Existing rows (there are none — no Supabase project exists) are labelled, then the
-- default is dropped so a future writer has to say which source it is rather than
-- inheriting 'meta_callback' by accident.
update contact_erasure_requests set source = 'meta_callback' where source is null;
alter table contact_erasure_requests alter column source set not null;
alter table contact_erasure_requests alter column source drop default;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'contact_erasure_requests'::regclass and conname = 'erasure_source_known') then
    alter table contact_erasure_requests add constraint erasure_source_known
      check (source in ('meta_callback', 'tenant_request', 'customer_direct'));
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'contact_erasure_requests'::regclass and conname = 'erasure_id_kind_known') then
    alter table contact_erasure_requests add constraint erasure_id_kind_known
      check (id_kind is null or id_kind in ('asid', 'psid', 'igsid'));
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'contact_erasure_requests'::regclass and conname = 'erasure_status_known') then
    alter table contact_erasure_requests add constraint erasure_status_known
      check (status in ('received', 'matched', 'no_match', 'completed', 'failed'));
  end if;

  -- A callback row that cannot say which app, which namespace, or which id is a row
  -- nobody can act on later. Refuse it at write time rather than discovering it during
  -- an erasure audit.
  if not exists (select 1 from pg_constraint
                 where conrelid = 'contact_erasure_requests'::regclass and conname = 'erasure_callback_is_identified') then
    alter table contact_erasure_requests add constraint erasure_callback_is_identified
      check (source <> 'meta_callback'
             or (provider is not null and external_id is not null
                 and id_kind is not null and app_slug is not null));
  end if;

  -- `completed` means the deletion ran and counted what it removed. Without this, a
  -- status column is a label somebody sets rather than a fact the row carries.
  if not exists (select 1 from pg_constraint
                 where conrelid = 'contact_erasure_requests'::regclass and conname = 'erasure_completed_has_evidence') then
    alter table contact_erasure_requests add constraint erasure_completed_has_evidence
      check (status <> 'completed' or (completed_at is not null and rows_deleted is not null));
  end if;
end $$;

-- The confirmation code is the status page's ONLY lookup key and the only thing the
-- person was given. Two rows sharing one is two people reading one status.
create unique index if not exists contact_erasure_requests_code
  on contact_erasure_requests (confirmation_code);

-- One OPEN request per person per app. A redelivery of the same signed_request then
-- returns the code already issued instead of minting a second one, and a genuinely new
-- request after completion is a new row with a new code.
create unique index if not exists contact_erasure_requests_open
  on contact_erasure_requests (app_slug, external_id)
  where completed_at is null and source = 'meta_callback';

-- What an operator reads: everything still owed to somebody, oldest first.
create index if not exists contact_erasure_requests_outstanding
  on contact_erasure_requests (requested_at)
  where completed_at is null;

comment on column contact_erasure_requests.id_kind is
  'asid | psid | igsid. Meta''s deletion callback sends an ASID; contacts.external_id holds '
  'a PSID or IGSID. They are different namespaces for the same person and must never be '
  'joined without a mapping.';

comment on column contact_erasure_requests.status is
  'received | matched | no_match | completed | failed. `completed` requires completed_at '
  'and rows_deleted — "the job said it worked" is not evidence.';
