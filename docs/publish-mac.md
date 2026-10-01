# Publishing a tenant from the founder's Mac

Only the founder can publish: `SUPABASE_SECRET_PUBLISH` is absent from every cloud session on
purpose (CLAUDE.md). This page is the one-time setup and the command. Keys live in the macOS
Keychain and reach the command for that one run only: never in a file, a flag, or the shell
history.

## One-time setup

1. **Node 22.18 or newer** (the scripts are TypeScript run directly by Node). Check with
   `node --version`; if it is older: `brew install node@22` (or `nvm install 22`).
2. **Folder layout.** Two checkouts side by side, because the fact gate reads DalaTech's website
   copies from the sibling (`config/external-fact-copies.json`); a Tara publish does not need it,
   a DalaTech publish refuses without it.

       ~/dalatech/
         dala-ai/            git clone https://github.com/dalatechai-cyber/dala-ai.git
         dalatech-chatbot/   your existing dalatech-chatbot repository, cloned here

3. **The Supabase key `publish-mac`.** Supabase dashboard → project `tlggenaatnopnxzbkbuf` →
   Project Settings → API Keys → Secret keys → *Add new secret key*, name it `publish-mac`.
   Copy it once, then store it (the command asks for the value; paste it there, not on the
   command line):

       security add-generic-password -a "$USER" -s dala-supabase-publish-mac -w

   It is a service-role key for this one machine. If the Mac is lost, delete `publish-mac` in
   the dashboard; nothing else uses it.
4. **The Anthropic key**, only for `--with-model` (it spends). A key of its own, named
   `publish-mac` in the Anthropic console, keeps this spend apart from the live replies:

       security add-generic-password -a "$USER" -s dala-anthropic-publish-mac -w

## Each publish

    cd ~/dalatech/dala-ai && git checkout main && git pull && npm ci

Deploy first, then `git pull`, then publish: the publish renders with this checkout.

**Dry run with the model cases** (writes nothing; spends a few cents, once per change, D-151):

    NEXT_PUBLIC_SUPABASE_URL=https://tlggenaatnopnxzbkbuf.supabase.co \
    SUPABASE_SECRET_PUBLISH="$(security find-generic-password -s dala-supabase-publish-mac -w)" \
    ANTHROPIC_API_KEY="$(security find-generic-password -s dala-anthropic-publish-mac -w)" \
      node scripts/publish/tenant.ts --slug <slug> --with-model

Read it. It must end with every reply case passing, `facts: … every copy agrees`, a clean
`branches:` line and `Dry run. Nothing was written.` **Publish** is the same command with
`--publish` in place of `--with-model` and without the Anthropic line.

The first time, macOS asks whether `security` may read each item: choose *Always Allow*.

## Tara's price list of 2026-10-01 (D-167)

1. Wait until the PR carrying D-167 is merged and Vercel shows the production deploy as Ready.
2. At a quiet hour (between the SQL and the publish, Tara's replies refuse): Supabase dashboard
   → SQL editor → paste all of `scripts/provision/tara-price-list-2026-10-01.sql` → Run. It ends
   with `COMMIT`, or raises and writes nothing.
3. At once, the dry run above with `--slug matrix-eco-salon`. Expect: `allowed_numbers` adds the
   new prices and `91005498` and removes `80905498`; `branches: … no other branch's details`;
   every reply case passes, including «8 настай хүүгийн үс тайралт хэд вэ?» (must say 33,000);
   `facts: … every copy agrees`. The diff also carries the prompt trim (C1, PR #257): the nine
   suitability topics folded into one line.
4. If it is clean: the publish command. If anything refuses: run
   `scripts/provision/tara-price-list-2026-10-01-revert.sql` in the SQL editor at once (replies
   resume with no publish) and send the dry run's output.
   If the **only** failure is the children's case, the cause is the signed Ш1 example, and the
   fix is approving `prompt/drafts/sh1_refusal_topics_children.salon.mn.txt` (then this publish
   again). Recommended: revert and approve the draft first. Publishing anyway is your call: prices
   and phones are right, but a child's price may be withheld until the draft is live.
