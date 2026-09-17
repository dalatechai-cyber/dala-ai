-- Who is holding this conversation — the bot, or a person in the salon's inbox?
--
-- Nothing has ever asked. `conversations.state` has allowed `awaiting_human` and
-- `human_handled` since `0001` and NOTHING WRITES EITHER — they appear in exactly one
-- place, `persist.ts`'s `OPEN_STATES`, where they are read as "this conversation is still
-- open". That is D-064's shape: a value that reads as a safety signal for as long as
-- nobody tests it.
--
-- The product bug underneath is §3.7.3's: when a receptionist answers from Business Suite,
-- the bot does not know and keeps answering the same customer in parallel. The customer
-- gets two voices, and one of them is a machine contradicting a person about their own
-- salon.
--
-- ## The default is `unknown`, and that is the whole point of this migration
--
-- `bot` would be the convenient default and it is a claim this platform cannot support:
-- nobody has ever read the far side of a Meta thread, and D-062 is eleven days of exactly
-- that mistake. Every conversation that already exists has an unestablished owner, so it
-- is recorded as unestablished.
--
-- D-063's addendum is the rule being followed here: a migration adding a discriminator
-- with a default is retroactively deciding the semantics of every row already there, and
-- those rows are the ones that motivated the change. So the default must be the honest
-- value rather than the useful one — and the gate above is built to match, refusing ONLY
-- on a positively-established `human`. `unknown` is therefore never load-bearing: it
-- cannot silence a tenant, and it cannot claim an owner nobody checked.
alter table conversations
  add column if not exists thread_control text not null default 'unknown';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_thread_control_known') then
    alter table conversations add constraint conversations_thread_control_known
      check (thread_control in ('bot', 'human', 'unknown'));
  end if;
end $$;

-- When control last changed hands. The cooldown measures from HERE and not from
-- `last_message_at`: a customer writing again does not mean the receptionist let go.
alter table conversations
  add column if not exists thread_control_at timestamptz;

-- HOW we learned it, because the two sources have different strength and a single column
-- would flatten them. `handover` is Meta telling us outright. `echo` is inference — an
-- outbound message on this thread whose `mid` is not one of ours — and it is the only
-- detector that works while another app owns the thread. `reclaim` is this platform
-- taking control back, and nothing writes it yet: the outbound half is not built.
alter table conversations
  add column if not exists thread_control_source text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_thread_control_source_known') then
    alter table conversations add constraint conversations_thread_control_source_known
      check (thread_control_source is null
             or thread_control_source in ('handover', 'echo', 'reclaim'));
  end if;
end $$;

-- How long the bot stays quiet after a person takes the thread, per tenant, as data.
--
-- A salon that answers in ninety seconds and one that answers on Monday want different
-- numbers, and neither is a constant in `src/`. 30 minutes is §3.7.3's default; the bound
-- is one day because a cooldown longer than that is not a cooldown, it is an off switch,
-- and an off switch should be `roles` rather than a number nobody remembers setting.
alter table tenants
  add column if not exists human_takeover_cooldown_minutes integer not null default 30;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_human_cooldown_bounded') then
    alter table tenants add constraint tenants_human_cooldown_bounded
      check (human_takeover_cooldown_minutes between 0 and 1440);
  end if;
end $$;

comment on column conversations.thread_control is
  'Who holds this Messenger thread: bot | human | unknown. DEFAULT unknown because the far '
  'side of a Meta thread has never been read and a convenient default would be a claim '
  'without evidence (D-062). H11 check 4 refuses ONLY on human, so unknown never silences '
  'a tenant.';
comment on column conversations.thread_control_at is
  'When control last changed hands. The human-takeover cooldown measures from here, never '
  'from last_message_at — a customer writing again is not the receptionist letting go.';
comment on column conversations.thread_control_source is
  'How control was learned: handover (Meta said so) | echo (inferred from an outbound '
  'message that is not ours) | reclaim (this platform took it back; UNWRITTEN — the '
  'outbound half is not built).';
comment on column tenants.human_takeover_cooldown_minutes is
  'Minutes the bot stays silent after a person takes a thread. Per tenant, as data. Read '
  'by H11 check 4.';

-- Meta's OWN numeric id for the app serving this channel.
--
-- Nothing stored it, and D-041 is why that is not an oversight to shrug at: `app_slug` is
-- this platform's name for a CALLBACK PATH, never Meta's name for an app — tenant #0's
-- slug says `dalatech` while its Page lives in `DALA_AI`. So the slug cannot stand in for
-- the app id, and §3.3's cross-check has never been able to fail.
--
-- A handover event names apps by this id and nothing else. Without it `controlAfter`
-- cannot answer the only question that matters — is the new owner US? — so it answers
-- `unknown` and changes no state, which is correct and useless. Nullable, because it is a
-- fact about a Meta app that only the console can supply, and a wrong value here would
-- silently invert every handover verdict.
alter table tenant_channels
  add column if not exists meta_app_id text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_channels_meta_app_id_numeric') then
    -- ascii-safe: a Meta app id is a decimal integer, never customer text.
    alter table tenant_channels add constraint tenant_channels_meta_app_id_numeric
      check (meta_app_id is null or meta_app_id ~ '^[0-9]{1,32}$');
  end if;
end $$;

comment on column tenant_channels.meta_app_id is
  'Meta''s numeric app id for the app serving this channel (e.g. 1380702870025418). NOT '
  'app_slug, which names a callback path on this platform and not an app at Meta (D-041). '
  'Handover events identify apps by this id; NULL makes every handover verdict `unknown`, '
  'which changes no state.';
