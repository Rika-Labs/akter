---
enabled: true
paths:
  - packages/durable-actors/src/runtime/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 15
contextFiles:
  - docs/contracts/03-transactions.md
  - docs/contracts/09-recovery.md
---

# Outbox delivery preserves one logical intent

Every backend writes intents and timers to the sending actor's `actor_outbox`
inside the turn transaction ([ADR 0011](../../../docs/decisions/0011-direct-commands-outbox-and-performance.md)).
After COMMIT, the relay delivers each due row as a direct command whose command
id is the stable intent id, and deletes the row only after the receiver's
receipt commits. A crash after the receiver commits but before deletion
redelivers the same id, and the receiver replays its receipt.

Violations: generating a new intent or command id on redelivery; deleting the
outbox row before the receiver's receipt commits; writing intents anywhere
other than the sender's `actor_outbox` in the turn transaction; skipping
receiver receipt deduplication because the relay "already delivered".

Clean: delivery keys on the stable intent id; deletion happens strictly after
the receiver commits; at-least-once delivery is absorbed by receiver receipts.

Flag only a visible identity regeneration or deletion-ordering defect. The
outbox is not yet implemented; match only real code, not `.gitkeep`
placeholders.
