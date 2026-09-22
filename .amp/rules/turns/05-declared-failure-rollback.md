---
enabled: true
paths:
  - packages/durable-actors/src/runtime/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/contracts/02-command-turns.md
  - docs/contracts/03-transactions.md
---

# Declared failures roll back everything but the receipt

An unhandled declared failure discards all business work — dirty state,
migration writes, owned rows, blobs, events, timers, actor/workflow intents,
effect obligations, staged snapshot/broadcast notifications — while the fence
and the terminal failure receipt commit in that same transaction. The retained
failure later replays without rerunning the handler, even if business
conditions changed.

Violations: persisting state or rows written before the failure; committing
the failure receipt in a second transaction; delivering an intent or staged
notification from the failed turn; converting the declared failure into a
retryable defect/redelivery; reevaluating the operation on replay.

Clean: a handler that catches the error and returns success commits normally;
an intentionally persisted rejection is an output-schema value.

Flag only a visible leak of business work across the failure boundary or a
second commit. Do not demand rollback code you cannot see, and do not flag the
committed failure receipt itself — it is the required outcome.
