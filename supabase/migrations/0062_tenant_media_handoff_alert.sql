-- Whether a media hand-off pages the founder on Telegram, per tenant (D-153, founder
-- 2026-09-27). A photo, a video or a link to one still gets the tenant's reviewed notice and
-- the takeover silence either way (`handover/media.ts`); this decides only the alert.
--
-- Additive. Default TRUE, so every existing tenant keeps today's behaviour and a new tenant
-- is alerted until someone decides otherwise: a quiet default would hide the hand-off from
-- the one person who can act on it.

-- Fail fast rather than queue behind a long transaction: every reply reads `tenants`.
set lock_timeout = '5s';

alter table tenants
  add column if not exists media_handoff_alert boolean not null default true;

comment on column tenants.media_handoff_alert is
  'D-153. false: a media hand-off (photo, video or media link) sends no Telegram alert. The notice and the takeover silence are unchanged. Read by handover/media.ts raiseMediaHandoff.';
