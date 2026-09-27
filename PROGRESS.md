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
- [ ] 3. Tests for the reader, plan, cases and gates.
- [ ] 4. Salon-language gate blocks: neutral drafts for the founder, live tenants unchanged.
- [ ] 5. End-to-end proof: gates, dry-run publish, delete the test tenant; docs, review, PR.
