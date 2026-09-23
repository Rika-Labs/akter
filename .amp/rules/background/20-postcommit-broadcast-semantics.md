---
enabled: true
paths:
  - packages/durable-actors/src/runtime/connections/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 0
contextFiles:
  - docs/contracts/07-realtime.md
  - docs/contracts/03-transactions.md
---

# Broadcast is post-commit and never transactional

`ctx.connections.broadcast` frames flush only after the turn commits and are
discarded on rollback. Broadcast is best-effort: loss after commit is not
recovered, and it must never be implemented or described as transactional
delivery — durable output uses events or command intents.

Violations: writing frames to sockets inside the transaction; delivering
staged frames after a rollback; retrying or replaying broadcast frames as if
they were durable; presenting broadcast semantics as guaranteed delivery in
docs or option names.

Clean: frames staged during the turn flush once after commit; rollback drops
them; durable fan-out goes through `ctx.emit`.

Flag only a visible ordering or durability-claim defect. Connection-state
parking that wakes an activation on an inbound frame is required behavior —
do not flag it. This subsystem is not yet implemented; match only real code,
not `.gitkeep` placeholders.
