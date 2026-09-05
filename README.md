# Dala AI

Dalatech's multi-tenant AI staff platform for Mongolian SMBs.

Businesses hire AI staff the way they would hire people — by the role, per month.
One codebase, one deployment, and a configuration per tenant.

| Role | What it does | Status |
|---|---|---|
| **Reception AI** | Inbound Messenger and Instagram DMs and comment replies. Answers from the tenant's own knowledge base and hands booking requests to the tenant's booking link. | Phase 3 — building |
| **Customer Care AI** | Outbound SMS: reminders, win-back, review requests. | Seam only — gated on a Mongolian SIP trunk |
| **Analytics AI** | Monthly per-tenant report: conversations, bookings driven, revenue attributed. | Phase 3 |
| **Voice AI** | Inbound voice. | Phase 4 — seam only |

Plus an internal **Quality layer** that reviews conversations, flags unanswered
questions, and proposes knowledge-base updates for the founder's approval. It is
admin-only, never client-facing, and can never apply a change by itself.

Separate business from Core Language (`dalatech-english`) — shared lessons only,
zero shared code, customers, or databases.

## The test every design decision is measured against

> Onboarding client #3 must be filling in a config, not writing code.

Everything that distinguishes one customer from another is a row. If a design
needs a per-tenant code branch, it is wrong.

## Where things are

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The reviewable summary — start here |
| [`docs/architecture/`](docs/architecture/) | The full design, by dimension |
| [`docs/architecture/09-reconciliation.md`](docs/architecture/09-reconciliation.md) | The arbitration. Takes precedence over every section file |
| [`docs/architecture/10-completeness.md`](docs/architecture/10-completeness.md) | What no section addressed, and the CLAUDE.md carry-forward audit |
| [`CLAUDE.md`](CLAUDE.md) | Rules and pointers for working in this repository |

**This paragraph used to say "nothing is built yet". It is out of date and the
correction matters more than the fact.** V1's code path exists: 63 modules, 714 tests,
14 migrations. The Meta app `dalatech` exists and holds `pages_messaging` at Advanced
Access. The Supabase project exists (`tlggenaatnopnxzbkbuf`, PostgreSQL 17.6) and carries
migrations `0001`–`0012`. What does **not** exist is Anthropic, QStash and a deployment —
so nothing has ever reached a customer. [`docs/STATUS.md`](docs/STATUS.md) is the honest
account, kept current; this file is not the place to look for status.
