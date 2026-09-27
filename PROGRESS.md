# PROGRESS — one-command onboarding (2026-09-27)

Brief: a filled «Дали — Мэдээлэл цуглуулах маягт» becomes a tenant with one command, in
shadow, behind two gates (founder signs the wording; client confirms the facts). Proven on a
local replica with a fictional salon branch; nothing touches the live project.

## Checkpoints

- [x] **1. Read the form.** `src/lib/provision/formFile.ts` reads .docx (Word / Google Docs
  download) and .md/.txt exports. `questionnaire.ts` knows the form's layout and refuses a
  form whose numbering changed. Verified on the founder's real blank template (downloaded
  from Drive as .docx, kept as `scripts/onboard/fixtures/dali-form-blank.docx`).
- [x] **2. Plan and write.** `plan.ts` maps answers to rows, sentences (from
  `scripts/provision/templates/onboarding.mn.json`), knowledge documents and a MISSING list.
  `cases.ts` generates reply cases. `onboardWrite.ts` / `write.ts` write them;
  `onboardGates.ts` holds the two gates, the client summary and the wording sheet.
  `scripts/onboard/tenant.ts` is the one command. Dry run and `--apply` run clean on the
  local replica; a second `--apply` changes nothing.
- [x] **3. Tests** for the reader (real template, .docx and text export), plan, cases, gates, and the tenant guard; loader and deploy-gate tests.
- [x] **4. Salon-language gate blocks.** `prompt/drafts/vertical-neutral/`: neutral drafts of
  the eight blocks that carry salon examples, plus byte-frozen `salon` / `software` copies so
  the live tenants do not move. Measured on the replica: both live verticals compile
  byte-identical, a new vertical gets no salon words. Unsigned; for the founder.
- [x] **First-publish gate.** The reply-case gate could not judge a tenant that was never
  published (`not_provisioned`). It now judges it against the snapshot the publish is about
  to write (`reception/load.ts` `firstPublish`, used only when no live snapshot exists).
- [x] **5. End-to-end proof** on the local replica (`docs/reports/2026-09-27-onboarding-proof/`), test tenant deleted; D-155, provisioning §8, STATUS.
- [x] **6. Review (Opus reviewer) and fixes:** deploy gate no longer blocked by a never-published tenant (cases and facts); onboarding refuses any tenant it did not create (Tara sits in shadow and was not protected by the never-live test alone); both gates bound to stored ids so any later change re-opens them; interrupted channel write repaired on re-run; deposits keyed by text; rows no longer in the form named and held; exact-bytes wording sheet.
