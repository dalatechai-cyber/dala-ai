-- `tenant_secrets.kind` gains `web_mint_secret` (D-086).
--
-- The website channel derives its tenant from WHICH per-tenant secret verified the mint
-- request's HMAC. That secret is per-TENANT data, not platform property, so rule 7 puts it
-- in `tenant_secrets` under the KEK rather than in an environment variable — the same place
-- and the same reasoning as `page_token`. `META_APP_SECRETS` is an env map because a Meta
-- app secret belongs to the app, which is ours; a mint secret belongs to the client.
--
-- Widening a CHECK, so it is additive by construction: every existing row still satisfies
-- the new constraint, and no data is dropped, rewritten or narrowed.
--
-- ## This value has no reader yet, and that is stated rather than hidden
--
-- D-064's rule is "when you find a column, ask who writes it", and D-083 adds the inverse.
-- Asked of this: nothing in `src/` loads a `web_mint_secret` today, because the mint route
-- is not built. It is here because sealing the secret is the FOUNDER's step (credentials)
-- and `scripts/kek/seal.ts` takes a kind — so without this the preparation cannot start in
-- parallel with the route being written. When the route lands, this stops being a value
-- nothing reads; until then, do not cite it as evidence the channel works.

alter table tenant_secrets drop constraint if exists tenant_secrets_kind_check;

alter table tenant_secrets add constraint tenant_secrets_kind_check
  check (kind in (
    'page_token',
    'ig_token',
    'app_secret',
    'sip_password',
    'booking_webhook_secret',
    -- The tenant server's HMAC key for POST /api/web/session. Scoped per CHANNEL as well as
    -- per tenant (`tenant_secrets` is keyed on `channel_key`), so a tenant running two
    -- widgets can rotate one without the other going dark.
    'web_mint_secret'
  ));
