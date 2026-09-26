# Page tokens from a Business Manager system user

**Status: planned, nothing switched.** Founder, 2026-09-26: *"Plan the move to Business
Manager system-user tokens for both Pages … Don't switch anything until I've created the
tokens."*

## Why

Both Page tokens have died this week, and both were minted from the founder's personal
Facebook login:

| Page | Died | Graph error | What it means |
|---|---|---|---|
| DalaTech `863503883522801` | 2026-09-25 18:53 UTC | 190 / 467 | The token was invalidated. A logout, or the login session behind it ending, does this |
| Tara `1520409424715591` | 2026-09-26 01:09 UTC | 190 / 460 | The password changed, or Facebook ended the session for security |

A Page token derived from a person's login lives only as long as that person's session:
- a password change ends it;
- so does "log out of all sessions";
- so does a security checkpoint;
- so does losing the Page role.

A **system user** belongs to the business, not a person, so none of those events touch it.
A Page token derived from a system-user token with **Token expiration: Never** does not
expire. It dies only if:
- the system user is deleted;
- its access to the Page or the app is removed;
- the app loses a permission.

## What is true today (read from `tenant_channels` / `tenant_secrets`, 2026-09-26)

| | DalaTech | Tara |
|---|---|---|
| Page id | `863503883522801` | `1520409424715591` |
| `meta_app_id` (the app the token is for) | `1562862634970492` (DALA_AI) | `1562862634970492` (DALA_AI) |
| Sealed under | KEK v2 | KEK v2 |
| `data_access_expires_at` | 2026-12-24 | 2026-12-25 |

Both tokens are for **the same app, DALA_AI**. So one system user and one app cover both
Pages. **Keep DALA_AI**: echo attribution (`meta_app_id`) and the webhook subscription both
assume it, and changing the app would be a second migration on top of this one.

## Your steps in Business Manager (business.facebook.com → Settings)

### 1. The app belongs to your business
- Go to **Accounts → Apps**. DALA_AI (`1562862634970492`) must be listed as owned by
  DalaTech's business.
- If it is not, add it: **Add → Connect an app ID** with `1562862634970492`. Alternatively,
  in the App Dashboard go to **App settings → Advanced → Business Manager** and choose your
  business.

### 2. DalaTech's Page belongs to your business
- Go to **Accounts → Pages**. `863503883522801` should be there.
- If it is not, add it: **Add → Add a Page**.

### 3. Tara's Page, which belongs to the salon's business
You cannot add it yourself. **The salon does this, in THEIR Business Manager:**
1. They go to **Accounts → Pages → Tara → Assign partners → Business ID**.
2. They paste DalaTech's Business ID, from your **Business info** page.
3. They grant:
   - **Messaging** (needed to send and receive DMs);
   - **Community activity / Moderate** (needed for comment replies);
   - **Content** (needed to manage the Page's webhook subscription).
   - "Full control" works but is more than needed.

The Page then appears under your **Accounts → Pages** as shared by a partner.

**What this changes:** the salon keeps ownership, and Tara's token now depends on that
partner assignment instead of your login. If they remove it, the token dies. It then fails
the same way it did today: a 190, a halt, and the page to you.

### 4. Create the system user
1. Go to **Users → System users → Add**.
2. Name it `dala-ai`.
3. Choose the role **Employee**. Employee is enough, and it keeps the user out of your
   business settings.
4. Meta may ask you to verify the business before it allows system users. If it does,
   tell me what it asks for.

### 5. Give it the assets
Open the system user and go to **Assign assets**:
- **Apps → DALA_AI**: Develop app (or Manage app).
- **Pages → DalaTech**: Messaging, Community activity, Content.
- **Pages → Tara** (after step 3): Messaging, Community activity, Content.

### 6. Generate the system-user token
1. On the system user, click **Generate new token**.
2. Choose the app **DALA_AI**.
3. Set **Token expiration** to **Never**.
4. Tick these permissions, which are the ones the platform uses today:
   - `pages_messaging`
   - `pages_manage_metadata`
   - `pages_read_engagement`
   - `pages_read_user_content`
   - `pages_manage_engagement`
   - `pages_show_list`
5. Copy the token somewhere safe. **Do not paste it into chat or into this repository.**

### 7. Derive each Page's token
In the Graph API Explorer, or with curl, call:

    GET https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&access_token=<SYSTEM USER TOKEN>

Each assigned Page comes back with its own `access_token`. **That Page token is what gets
sealed**, not the system-user token itself.

### 8. Check each Page token before sealing
Paste it into the **Access Token Debugger** (developers.facebook.com/tools/debug/accesstoken).
Confirm:
- **Type: Page**;
- **App ID: 1562862634970492**;
- **Page ID** is the right Page;
- **Expires: Never**;
- the scopes above are present.

Note what it says for **Data Access Expires**. It may read "Never" for a system user; if it
shows a date, write it down.

### 9. Stop there and tell me
Tell me that both tokens exist and what the debugger showed. **Nothing is switched until
you say so.**

## What I do, after you tell me

1. **Nothing in the code changes.** A Page token from a system user is still a Page token.
   The send path, `POST /{page-id}/messages` with `loadTenantSecret`, cannot tell the
   difference. That is also why the switch is reversible: re-sealing the old token restores
   the old behaviour.
2. **You seal each Page token** with the same command as today, run by you, because it is a
   credential (CLAUDE.md):

       printf %s "$PAGE_TOKEN" | node scripts/kek/seal.ts --tenant <uuid> --channel <uuid> --kind page_token \
         --expires-at never --data-access-expires-at <date or never>

   Then run the SQL it prints.
3. **I verify each one without sending anything:**
   - the row opens under the active KEK;
   - `scripts/diagnose/meta-subscription.ts`, which only reads, shows the Page still
     subscribed to DALA_AI;
   - `meta_app_id` stays `1562862634970492`.
4. **The first real reply after each switch** is the proof: `tenant_secrets.last_ok_at`
   advances and the credential episode stays closed. I read it and report.
5. **The expiry watch** (`health/secretExpiry.ts`) then reads `never` for both clocks, so
   its 2026-12 data-access alerts stop. That is correct, not a gap, because a system user
   has no 90-day data-access clock.
6. **Your personal login** then carries no production token. Changing your password or
   logging out everywhere can no longer take a Page offline.

## Risks, stated

- **Advanced Access on a Page your business does not own.**
  - `pages_messaging` is at Advanced Access, so Tara is fine for DMs.
  - The comment permissions were granted "with no review required" (D-106) while the Page
    was reached through your own login.
  - Through a partner assignment Meta may insist on Advanced Access for them. If the token
    generation or a comment reply refuses on a permission, that is the cause. Send me the
    exact error before changing anything.
- **Business verification.** Meta may require it before system users can be created, or
  before they can be given certain permissions.
- **One token per app per Page.** Generating a new system-user token does not invalidate
  the old personal-login token. Both work until the old one dies on its own, so there is no
  outage window during the switch.
