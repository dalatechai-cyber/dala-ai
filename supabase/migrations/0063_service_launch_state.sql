-- 0063 — a service's launch switch (D-154, founder 2026-09-27).
--
-- Founder: *"When a staff member is ready I flip ITS switch, and the website AND Дали's chat
-- answers change to live together, with no code or copy edits. While a switch is off, that
-- staff member appears exactly as today («Удахгүй», pre-registration)."*
--
-- ## The switch is one column, and it reaches customers only through a publish
--
-- `services.launch_state` is the switch. It is read at COMPILE time, and the states the
-- compile used are frozen into the snapshot (`config_snapshots.launch_states`). Everything
-- that says whether a service is live reads the SNAPSHOT, never the column:
--
--  - the knowledge base, compiled into the prefix (`knowledge_documents` rows carrying a
--    condition are compiled only when it holds);
--  - the fixed replies, read per request (`deterministic_replies` rows and their `items`
--    carrying a condition answer only when it holds under the snapshot's states);
--  - the reply cases, which judge a publish against the states it is about to freeze;
--  - the website, which reads the web channel's live snapshot over `/api/web/launch/…`.
--
-- So flipping the column alone changes nothing anywhere, and a publish changes all of it at
-- the same pointer move. That is the "together" the founder asked for, by construction: the
-- prefix, the fixed replies and the website cannot disagree about a service, because they
-- read one frozen record of it (D-058's lesson, one fact with one source).
--
-- ## Conditions, not copies of rows per combination
--
-- A row may carry ONE condition: `when_service_id` + `when_launch_state`, both or neither.
-- A fixed reply that lists several services (a price overview, «X, Y хараахан ажиллаж
-- эхлээгүй…») cannot be one row per combination of switches — four switches are sixteen
-- rows. Its body is instead a template with `{{slot}}` markers, and `items` holds the
-- pieces, each with its own condition; the reply path fills the slots with the pieces that
-- hold (`src/lib/launch/launch.ts`). `items` is jsonb, not a table, because it is part of
-- one reviewed reply and never read on its own; its service references are checked at
-- publish (`scripts/publish/tenant.ts`), and a piece naming a service the tenant does not
-- have never holds.
--
-- ## Additive. Every existing row keeps today's behaviour.
--
-- `launch_state` defaults to 'live', which is what every service has meant until now. Every
-- other column is nullable, and null means "no condition" — the row answers as it always
-- did. `config_snapshots.launch_states` is a FORMAT marker like `canned_hash` (0024): null
-- means the snapshot predates this migration, and then a conditioned row or piece never
-- holds (it cannot be shown to), while every unconditioned row is untouched. The first
-- republish after the tenant's rows gain conditions fills it in. Never backfilled:
-- `config_snapshots` is append-only by an ENABLE ALWAYS trigger.

set lock_timeout = '5s';

alter table services
  add column if not exists launch_state text not null default 'live'
    constraint services_launch_state_known check (launch_state in ('live', 'preregistration'));

comment on column services.launch_state is
  'D-154. The launch switch: live, or preregistration (taking sign-ups, not yet working). '
  'Reaches customers only through a publish, which freezes it into config_snapshots.launch_states; '
  'nothing on the reply path or the website reads this column directly.';

-- One condition per row: both columns or neither. The foreign key is composite so a row can
-- only ever name one of its OWN tenant's services, even written by service_role.
alter table knowledge_documents
  add column if not exists when_service_id uuid,
  add column if not exists when_launch_state text;
alter table knowledge_documents
  add constraint knowledge_documents_launch_condition_whole
    check ((when_service_id is null) = (when_launch_state is null)),
  add constraint knowledge_documents_launch_state_known
    check (when_launch_state is null or when_launch_state in ('live', 'preregistration')),
  add constraint knowledge_documents_launch_service_fk
    foreign key (tenant_id, when_service_id) references services (tenant_id, id);

alter table deterministic_replies
  add column if not exists when_service_id uuid,
  add column if not exists when_launch_state text,
  add column if not exists items jsonb;
alter table deterministic_replies
  add constraint deterministic_replies_launch_condition_whole
    check ((when_service_id is null) = (when_launch_state is null)),
  add constraint deterministic_replies_launch_state_known
    check (when_launch_state is null or when_launch_state in ('live', 'preregistration')),
  add constraint deterministic_replies_launch_service_fk
    foreign key (tenant_id, when_service_id) references services (tenant_id, id),
  add constraint deterministic_replies_items_is_array
    check (items is null or jsonb_typeof(items) = 'array');

alter table reply_cases
  add column if not exists when_service_id uuid,
  add column if not exists when_launch_state text;
alter table reply_cases
  add constraint reply_cases_launch_condition_whole
    check ((when_service_id is null) = (when_launch_state is null)),
  add constraint reply_cases_launch_state_known
    check (when_launch_state is null or when_launch_state in ('live', 'preregistration')),
  add constraint reply_cases_launch_service_fk
    foreign key (tenant_id, when_service_id) references services (tenant_id, id);

-- The foreign keys above are NO ACTION, checked at the end of the statement, so deleting a
-- tenant (which cascades to both sides) still works, and deleting a service a row still names
-- is refused. They are checked on every delete of a service; index their columns so
-- that check is not a scan.
create index if not exists knowledge_documents_when_service_idx
  on knowledge_documents (tenant_id, when_service_id) where when_service_id is not null;
create index if not exists deterministic_replies_when_service_idx
  on deterministic_replies (tenant_id, when_service_id) where when_service_id is not null;
create index if not exists reply_cases_when_service_idx
  on reply_cases (tenant_id, when_service_id) where when_service_id is not null;

alter table config_snapshots add column if not exists launch_states jsonb;
alter table config_snapshots
  add constraint config_snapshots_launch_states_is_array
    check (launch_states is null or jsonb_typeof(launch_states) = 'array');

comment on column knowledge_documents.when_service_id is
  'D-154. With when_launch_state: compile this document only while that service is in that state. Both null: always.';
comment on column deterministic_replies.when_service_id is
  'D-154. With when_launch_state: this row answers only while that service is in that state, as the live snapshot records it. Both null: always.';
comment on column deterministic_replies.items is
  'D-154. The pieces a {{slot}} in body/web_body is filled with: [{slot, body, service_id?, state?, words?}]. '
  'A piece holds when its condition holds under the live snapshot''s launch_states. Parsed by src/lib/launch/launch.ts; '
  'a row whose slots are left empty, or whose items do not parse, does not answer.';
comment on column reply_cases.when_service_id is
  'D-154. With when_launch_state: the case is judged only against a configuration in which that service is in that state.';
comment on column config_snapshots.launch_states is
  'D-154. [{service_id, name, state}] for every active service, as compiled. The one record of which services are live: '
  'the fixed replies, the reply cases and the website read this, never services.launch_state. '
  'NULL: the snapshot predates 0063 (a format marker); a conditioned row then never holds.';
