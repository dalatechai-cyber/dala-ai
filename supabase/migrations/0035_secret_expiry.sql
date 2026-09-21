-- 0035 — when a stored credential dies, recorded rather than discovered
--
-- `tenant_secrets` has carried no expiry since `0001`, and `secrets/tenantSecret.ts` says
-- so in as many words: §3.4's draft DDL named `expires_at` and the schema deliberately does
-- not have it. The consequence was measured on 2026-09-21 (D-109). Matrix went live on a
-- short-lived Graph API Explorer Page token; it sealed cleanly, opened cleanly through the
-- runtime loader, and died about forty minutes later. The platform learned about it as a
-- `graph 401 code=190 subcode=463` at send time, which tripped the credential breaker and
-- halted the channel. Nothing could have warned, because nothing knew.
--
-- TWO columns, because Meta has two clocks and they expire different things:
--
--   * `expires_at`           — the token stops working. A Page token derived from a
--                              long-lived user token reports `expires_at: 0` from
--                              `debug_token`, meaning never; that is stored as NULL here.
--   * `data_access_expires_at` — the token still authenticates and the DATA stops coming,
--                              about ninety days after the last authorization unless the
--                              person re-authorizes. A credential can be "never expires"
--                              and still go dark on this clock, so recording only the
--                              first would reproduce the same surprise on a longer fuse.
--
-- Both NULLABLE and both meaning "not known", never "never". An absent value is the state
-- of every row written before this migration, and the reader must not read silence as
-- safety — `health/secretExpiry.ts` reports unknown as unknown and warns on neither.
--
-- WARN ONLY. Nothing in this platform may renew or re-authorize a credential from these
-- columns (founder, 2026-09-21). The product is a human being told early enough to act.

alter table tenant_secrets
  add column if not exists expires_at timestamptz,
  add column if not exists data_access_expires_at timestamptz;

comment on column tenant_secrets.expires_at is
  'When the credential stops authenticating. NULL = not known, or never (Meta reports expires_at 0 for a Page token from a long-lived user token). Warn-only; nothing refreshes from this.';

comment on column tenant_secrets.data_access_expires_at is
  'When data access lapses without re-authorization — about 90 days for Meta, and independent of expires_at. NULL = not known. Warn-only.';
