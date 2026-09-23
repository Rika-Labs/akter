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
  - docs/contracts/03-transactions.md
  - docs/architecture/transaction-catalog.md
---

# One transaction per turn

One framework-owned transaction atomically contains everything a turn produces:
generation fence, receipt, decoded/migrated and dirty state, actor-owned rows
and blobs, durable events, timers, actor/workflow intents, and effect outbox
rows. A failure before commit exposes none of them.

Violations: opening a second connection or transaction inside a turn; writing
the failure receipt in a separate commit from the fence; publishing events,
intents, or staged notifications before the outer commit; leaving staged
snapshot/broadcast notifications alive after rollback.

Clean: every write goes through the transaction-bound client; a savepoint for
the declared-failure boundary is acceptable only where the backend has proven
that behavior.

Flag only a visible second commit path or pre-commit publication. Do not flag
work the contract schedules after commit (replies, delivery, broadcast flush),
and do not assume unseen writes escape the transaction.
