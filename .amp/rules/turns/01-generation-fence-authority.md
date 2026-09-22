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
  - docs/contracts/01-actor-authority.md
---

# Generation fence is the only commit authority

A command turn commits only under the database generation fence: the actor's
generation row is locked with `SELECT ... FOR UPDATE` inside the turn
transaction (on Neki, `__neki.tx_mode='single'` is also set on the pinned
connection), and a stale generation is a retryable defect that never reaches a
commit.

Violations: committing or writing durable rows on the strength of a lease,
shard routing, an in-memory ownership flag, or TypeScript types alone; fencing
in a second transaction separate from the turn's writes; treating a
stale-generation failure as terminal instead of `RetryTurn`/redelivery.

Clean: the fence read is the first statement of the single turn transaction on
its pinned connection.

Flag only a visible path that commits or mutates without the fence. Do not
demand fencing from code that cannot commit (queries, read-only contexts,
migrations, test helpers), and do not infer missing locks in unseen code.
