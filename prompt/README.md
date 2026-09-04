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
4. The guard passes. The seed loads the file into `prompt_blocks` with that `reviewed_at`.

Step 3 cannot be skipped by editing the JSON alone, because the hash is over the file.
It can of course be skipped by someone pasting a hash they did not earn — this is a
process gate, not a cryptographic one. What it makes impossible is the *accidental* case:
a block edited in a hurry, shipped without review, and read by customers.

**This directory is empty on purpose.** The gate is built before the thing it gates, on
the same principle as the meter and the outbound guard. The blocks themselves are a
separate change, because reviewing Mongolian prose and reviewing a build gate are
different jobs for different people.
