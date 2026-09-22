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

# Durable obligations are recorded, then executed post-commit

Work that must survive a crash — actor/workflow intents, timers, effects — is
recorded inside the turn transaction and executed only after commit. A
rollback delivers nothing: no intent reaches a receiver, no effect reaches a
provider.

Violations: executing an external effect inline during the handler; queuing
intents or timers in process memory where a rollback cannot retract them;
delivering an intent or starting an effect before the committing transaction
finishes; treating at-least-once intent delivery as an exactly-once external
effect guarantee — receiver receipts provide the deduplication.

Clean: `ctx.perform`, `ctx.self.X.send/after/at`, and workflow start/cancel
write durable rows in the transaction; executors and relays run post-commit
with stable identities.

Flag only a visible inline execution or in-memory obligation. Best-effort
broadcast is explicitly non-durable and not covered here — do not flag it for
lacking a durable record.
