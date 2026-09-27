# Onboarding, proven end to end on a local replica (2026-09-27, D-155)

**Nothing here touched the project.** A local PostgreSQL 16 + PostgREST 12.2.3 replica with
every migration to `0063` applied, and a FICTIONAL salon branch, «Цэцэглэг Салон» (slug
`tsetsegleg-demo`, Page id `990000000000001`, every name, number and link invented).

The form: the founder's real blank «Дали — Мэдээлэл цуглуулах маягт», downloaded from Drive
as Word, filled by `scripts/onboard/fixtures/fill.ts` with
`scripts/onboard/fixtures/sample-salon-branch.answers.json` → `sample-salon-branch.docx`.
On purpose: two stylists of each gender, a deposit, one missing answer (no price for
«Сормуус суулгалт»), and two confusable names («Хумс будалт» / «Гель хумс будалт»).

| File | What it shows |
|---|---|
| `run.log` | Every command and its output, in order: dry run → apply → idempotent re-run → the daily-report row → dry-run publish before the gates (0 active cases) → a wrong sheet id refused → wording signed → facts confirmed → reply cases switched on → the production deploy gate reports the tenant as «not published yet» (exit 0) → dry-run publish (1/1 exact case passes, 16 model cases not run) → the client corrects Monday's hours: the client gate re-opens and the cases switch off → back to the confirmed form: gate closed, cases on → a Tara-like shadow tenant onboarding did not create is refused → a once-live tenant refused → the test tenant deleted, 0 rows left in 79 tenant-scoped tables |
| `report.md` | The operator report after `--apply` |
| `wording-sheet.md` | The 13 lines for the founder, with their origin |
| `client-summary.md` | The one page the client confirms |

**The signatures in `run.log` are SIMULATED** («SIMULATED founder», «Болор (fictional)»), on
a fictional tenant, on the replica, to exercise the gates. No real wording was signed.

**No model was called.** The 16 model cases need `--with-model`, the one paid pre-publish
check (D-151); `ANTHROPIC_API_KEY` is not set in this session, so it was not run and cost
nothing. On a real tenant it runs once, after both gates, before `--publish`.
