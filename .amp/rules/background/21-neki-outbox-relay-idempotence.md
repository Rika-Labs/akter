---
enabled: true
paths:
  - packages/durable-actors/src/runtime/database/neki/**
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

# Neki relay preserves one logical intent

On Neki, the turn writes the tenant-shard `actor_outbox` row inside the turn
transaction, and the relay transfers it to `cluster_messages` after COMMIT
using the intent's stable id. Recovery resumes unrelayed rows with the
original identity: a crash after destination insert but before source
acknowledgment produces no second logical intent and no repeated receiver
transition.

Violations: generating a new intent id on relay retry; acknowledging the
source row before the destination insert commits; treating an unacknowledged
row as never-sent and re-inserting unconditionally; skipping receiver
receipt deduplication because the relay "already delivered".

Clean: relay idempotence keys on the stable intent id; acknowledgment happens
strictly after destination commit; at-least-once delivery is absorbed by
receiver receipts.

Flag only a visible identity regeneration or acknowledgment-ordering defect.
This adapter is not yet implemented; match only real code, not `.gitkeep`
placeholders.
