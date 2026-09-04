# Platform prompt blocks, and the sign-off that gates them

`platform/*.mn.txt` holds the platform's own Mongolian: L0 (identity, the ten-check gate
scaffold, the Mongolian quality rule, the reference-data declaration) and L1 (the
Reception role prompt). One file per block; the filename without `.mn.txt` is the
`block_key`.

`platform-mn-review.json` carries a native-speaker sign-off for each: `sha256`,
`reviewed_by`, `reviewed_at`. `scripts/guards/check-mn-review.mjs` fails the build when a
file has no signature, or when its hash has moved since one was given.

## Why the platform's Mongolian needs the same gate as the tenant's

The schema already refuses to render a `canned_responses` row whose `reviewed_at` is null.
The draft of §6.5 put that gate on tenant rows only and left the platform blocks covered
by code review — **by people who do not read Mongolian.**

Three errors were already present in the draft's own platform text and were caught only by
an adversarial read:

| written | should be | where |
|---|---|---|
| `зааврааас` | `заавраас` | the gate preamble |
| `ДООРМЖЛОЛ` | `ДООРОМЖЛОЛ` | Ш7's heading |
| `дага БҮҮ дага` | `бүү дага` | the anti-injection declaration |

The third is the one that matters most: it is a duplicated verb in the single sentence
whose entire job is to stop the model following instructions pasted into a tenant's
knowledge base. The platform's Mongolian is read by exactly the same customers as the
tenant's, so it gets exactly the same gate.

## The workflow

1. Add or edit `platform/<block_key>.mn.txt`.
2. The guard fails: the hash no longer matches the signature.
3. A native speaker reads the file and signs it — `sha256`, their name, the date.
4. `node scripts/prompt/generate-seed.ts` regenerates the seed migration from the signed
   files. `scripts/prompt/generate-seed.test.ts` fails if you forget, so the database can
   never hold text that differs from the text somebody signed.
5. The guard passes.

Step 3 cannot be skipped by editing the JSON alone, because the hash is over the file.
It can of course be skipped by someone pasting a hash they did not earn — this is a
process gate, not a cryptographic one. What it makes impossible is the *accidental* case:
a block edited in a hurry, shipped without review, and read by customers.

## Signed 2026-09-04 — twenty-one blocks, three families

`platform/` was empty until the founder signed off. It now holds three families, and they
are not the same kind of thing:

| Family | Blocks | Rendered by | `layer` |
|---|---|---|---|
| The boundary gate | `00_gate_preamble`, `01_data_marker`, `sh0`–`sh9` | The prompt compiler, ahead of every tenant section | `L0` |
| The data-deletion status page | `data_deletion_*` (8) | `src/lib/privacy/statusPage.ts` | `null` |
| The public comment reply | `comment_public_reply` | Nothing at runtime — it is the TEMPLATE a tenant's `canned_responses` row is copied from at onboarding | `null` |

`layer is null` means **customer-visible Mongolian that the prompt compiler does not
render.** The distinction matters in one direction especially: a status-page string given
a layer by mistake would be pasted into every tenant's system prompt.

**The comment template is not a runtime fallback and must never become one.**
`comments/eligibility.ts` refuses to post when a tenant has no reviewed line of their own,
and that refusal is the only thing stopping a salon from posting a sentence Dalatech wrote
in the salon's voice. Onboarding copies the template explicitly; nothing reads it at
request time, and a test asserts no file on the comment path so much as mentions
`prompt_blocks`.

## What is signed, and what that still does not prove

The signature covers the **file**, and the seed carries the attribution into
`prompt_blocks.reviewed_at` so every reader's `reviewed_at is not null` gate passes.

**The chain is now closed.** `src/lib/prompt/sections.ts` reads these rows into
`PromptSection[]`, `renderStablePrefix` compiles them, and `publishRevision` freezes the
result into `config_snapshots`. The twelve L0 blocks compile into a 9,265-character prefix.

Two things a signature still cannot cover:

- **The compile has never run through PostgREST**, because no Supabase project exists.
  Every query here is exercised against a stub.
- **A gate-only prompt is not a working prompt.** `01_data_marker` declares that everything
  below the «=== ТУХАЙН БАЙГУУЛЛАГЫН МЭДЭЭЛЭЛ ===» marker is reference data, and nothing
  renders that marker yet — it comes with the tenant L2/L3 sections, which no code writes.
  What compiles today is the boundary gate and nothing else.
