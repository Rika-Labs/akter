---
enabled: true
paths:
  - packages/durable-actors/src/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 15
contextFiles:
  - docs/contracts/10-security.md
  - docs/contracts/08-background-work.md
---

# Revocation blocks access, not accepted obligations

Losing authorization stops new external admissions and result reads; it never
implicitly cancels durable work already accepted — pending turns, intents,
workflows, and parked sessions' recorded obligations continue under their
persisted attribution unless explicitly canceled.

Violations: deleting or dropping queued intents, workflow executions, or
effect records when a principal is revoked; refusing trusted internal
redelivery because the originating caller lost access; treating revocation as
a cascade cancel; letting a parked session resume or replay without
reauthorization inside the documented bound.

Clean: admission checks current authorization; recovery replays the recorded
obligation; cancellation is an explicit operation; applications may reauthorize
sensitive steps.

Flag only a visible revocation-cascade or stale-access extension. Explicit
application-level cancellation on revocation is a feature, not a violation —
check that it is invoked deliberately, not implied.
