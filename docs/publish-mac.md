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

## Migrations: never `supabase db push` on this project

The project's ledger (`supabase_migrations.schema_migrations`) records `0001`–`0034` under their
numbers and `0035` onward under the timestamp versions the sessions' Supabase tool gave them
(`20260921031832` … for `0035`–`0075`, `20261001061736` for `0076`). Checked 2026-10-01: the 41
timestamp rows are exactly `0035`–`0075` by name, one each (`0038` was applied after `0039`). So
`supabase migration list` shows `0035` onward as local-only, and `supabase db push` would try to
re-apply all of them. Do not run it. A new migration is applied by a session with read-back
(the way `0035`–`0076` were). To check it yourself, run in the SQL editor:
`select version, name from supabase_migrations.schema_migrations order by version desc limit 3;`
The newest row names the migration (today: `20261001061736 | 0076_prompt_blocks_seed`).

## Tara's price list and the founder's decisions of 2026-10-01 (D-167, D-168, D-169)

`0076` (the approved salon Ш1 text) is **already applied** (2026-10-01, `20261001061736`, read
back: the live row matches the signed file byte for byte; nothing a customer sees changes until
Tara's publish).

1. Wait until the PR carrying D-169 is merged and Vercel shows the production deploy as Ready.
   Then `git pull && npm ci`.
2. At a quiet hour (between this SQL and the publish, Tara's replies refuse): Supabase dashboard
   → SQL editor → paste all of `scripts/provision/tara-price-list-2026-10-01.sql` → Run. It ends
   with `COMMIT`, or raises and writes nothing.
3. **Only if you approve the SPECIAL wording** (`prompt/drafts/tara_stylist_levels.mn.txt`): in
   the same editor, run `scripts/provision/tara-stylist-levels-2026-10-01.sql`. Not approved yet:
   skip it; the reply keeps today's line and the deposit is already in step 2.
4. At once, the dry run with `--slug matrix-eco-salon --with-model` (the command above). Expect:
   - `platform blocks: 100 live, matching the signed set.`
   - `allowed_numbers` adds the new prices and `91005498` and removes `80905498`;
   - `branches: … no other branch's details, and the shared facts agree.`;
   - every reply case passes: 30 with step 3, 29 without. Among them the two like cases, «SPECIAL
     үсчин» (step 3 only), and the model cases «8 настай хүүгийн…» (33,000), «Охины үс тайралт…»
     (44,000), «15 настай хүүгийн…» (44,000) and «SPECIAL үсчинд урьдчилгаа хэд вэ?» (20,000);
   - `facts: … every copy agrees with the rows.`;
   - the diff shows the new prices, the Ш1 text, the knowledge edits, SPECIAL's deposit and the
     prompt trim (C1).
5. If it is clean: the same command with `--publish` in place of `--with-model`. If anything
   refuses: run `scripts/provision/tara-price-list-2026-10-01-revert.sql` in the SQL editor at
   once (it also undoes step 3; replies resume with no publish; `0076` stays) and send the dry
   run's output.
6. Check on Messenger from your own account: send «Сайн байна уу», a like right after the answer
   (expect «Өөр асуух зүйл байвал бичээрэй.»), then a second like (expect no reply, and no
   «typing…»). A like as the very first message of a conversation (or after 24 hours of silence)
   gets the welcome line.
