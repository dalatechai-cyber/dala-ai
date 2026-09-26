-- Instagram DMs as a channel of their own (D-141, founder 2026-09-26).
--
-- An Instagram professional account connected to a Facebook Page is messaged through the
-- Page: Meta routes the webhook by the Instagram account id (`entry.id`, held in
-- `channel_identity` as provider `instagram`), and the reply is a Page send, made with the
-- PAGE's access token. So an `instagram` channel needs to name the Page channel it sends
-- through, and that is also where its credential lives: one token, sealed once, rotated once.
--
-- `via_channel_id` is that link. The composite foreign key keeps it inside one tenant — a
-- channel can never send through another tenant's Page — and NULL (every existing row)
-- means "this channel sends as itself with its own token", which is today's behaviour.
--
-- `test_sender_ids` lets a channel be tried before it is live: in `shadow`, a sender listed
-- here is answered for real, including the handover, and everybody else is drafted and not
-- sent. Empty (the default) changes nothing. It is ignored outside `shadow`: `off` answers
-- nobody and `live` answers everybody.
--
-- Additive. Every existing channel reads NULL and '{}'.

alter table tenant_channels
  add column if not exists via_channel_id uuid,
  add column if not exists test_sender_ids text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.tenant_channels'::regclass and conname = 'via_channel_same_tenant') then
    alter table tenant_channels
      add constraint via_channel_same_tenant
      foreign key (tenant_id, via_channel_id) references tenant_channels (tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.tenant_channels'::regclass and conname = 'via_channel_not_self') then
    alter table tenant_channels
      add constraint via_channel_not_self check (via_channel_id is null or via_channel_id <> id);
  end if;
end $$;

comment on column tenant_channels.via_channel_id is
  'D-141. The Page channel this channel sends through and whose page_token it uses (an Instagram account messaged via its connected Page). NULL: sends as itself.';
comment on column tenant_channels.test_sender_ids is
  'D-141. In shadow, these sender ids (PSID/IGSID) are answered live, handover included; everyone else is drafted only. Ignored in off and live.';

-- The reference row said `graph.instagram.com`, which is the Instagram-LOGIN flavour of the
-- API and a different token. This platform uses the Facebook-login flavour: the send is a
-- Page send on graph.facebook.com (`meta/send.ts`). Nothing reads these two columns; they are
-- corrected so the next reader of the table is not sent the wrong way. Only the seeded value
-- is rewritten, so a row somebody has changed deliberately is left alone.
update channel_providers
   set send_host = 'graph.facebook.com',
       send_path_tmpl = '/{version}/{page_id}/messages',
       note = 'D-141: an Instagram account connected to a Page is messaged through the Page, with the Page token (auth_flavour facebook_login). Routed by the Instagram account id in channel_identity.'
 where provider = 'instagram' and send_host = 'graph.instagram.com';
