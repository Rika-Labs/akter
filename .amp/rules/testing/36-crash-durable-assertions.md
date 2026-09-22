---
enabled: true
paths:
  - packages/durable-actors/src/**/*.test.ts
  - examples/**/*.test.ts
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 5
contextFiles:
  - docs/verification/02-failure-matrix.md
---

# Crash assertions verify durable truth

A failure-matrix row asserts durable reality: the committed rows, the caller's
result, retry identity, activation state, and the next delivery — inspected
through the database or a fresh authority, not merely the absence of a thrown
exception in the killed process.

Violations: a crash test that only asserts the process exited or the call
rejected; checking recovery by reading through the same in-memory activation
that survived; asserting "no duplicate" by counting handler invocations in the
crashed process rather than committed transitions; skipping the caller-visible
result or receipt-replay leg of the row.

Clean: a separate pool inspects `actor_state`/receipt rows after the fault; a
same-command-id retry replays the committed outcome; one transition is
asserted across redelivery.

Flag only a visible assertion gap in a crash/failure test — e.g. a kill with
no durable inspection at all. Do not demand every matrix column from every
test; a narrowly scoped crash case is fine when its own claim is asserted.
