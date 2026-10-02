# Draft bug report for Meta developer support (founder sends; not sent)

Where: Meta for Developers ▸ Support ▸ Report a bug (developers.facebook.com/support/bugs),
product **Messenger Platform**, logged in as the admin of app DALA_AI and Page DalaTech.
Fill the one placeholder in [brackets] before sending.

---

**Title:** Page Contact Terms acceptance link from error 2018344 is broken ("Cannot convert page_contact_tos to a BigInt")

**App:** DALA_AI (app ID 1562862634970492)
**Page:** DalaTech (Page ID 863503883522801)
**API:** `GET /v21.0/863503883522801/custom_labels` (Page access token, Messenger custom labels)

**What happens**

1. The call returns HTTP 400:
   `code 2, error_subcode 2018344, type OAuthException, message "Service temporarily unavailable",
   is_transient false, error_user_title "Privacy ToS not accepted",
   error_user_msg "To use the inbox label API, you need to accept the privacy ToS. Click the link to accept. https://www.facebook.com/863503883522801/inbox/page_contact_tos/"`,
   fbtrace_id **A0K3GdmK-j1yb_g7imf8NCX** (2026-10-02 19:35 UTC). An earlier call at
   2026-10-02 18:51 UTC returned the same code 2.
2. Opening `https://www.facebook.com/863503883522801/inbox/page_contact_tos/` as the Page's admin
   redirects to the Meta Business Suite inbox:
   `[paste the exact URL the browser ends on]`
   The inbox shows a blank pane with the error **"Cannot convert page_contact_tos to a BigInt"**.
3. Same result when opened while acting as the Page and while on my personal profile.

**Expected:** the link opens the Page Contact Terms so the Page admin can accept them, after
which the custom labels API works for this Page.

**Asks:** (a) a working place to accept the Page Contact Terms for Page 863503883522801, or
(b) confirmation that the terms can be accepted another way (Page settings path), or (c) that
Meta accept them on the Page's behalf if the flow is down.

---

Repo note: the full error is logged by `src/lib/handover/pageLabel.ts` since #276. The label
feature is switched off for every tenant until this is resolved.
