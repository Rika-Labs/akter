---
enabled: true
paths:
  - packages/durable-actors/src/state/**
  - packages/durable-actors/src/runtime/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 10
contextFiles:
  - docs/contracts/06-storage-ownership.md
  - docs/contracts/02-command-turns.md
---

# State.maxBytes measures UTF-8 bytes before commit

`State.maxBytes` is enforced against the UTF-8 encoded byte length of the
committed state value, inside the turn and before business state commits.
Overflow is a deterministic defect: rollback, `Die` to the caller, `onDefect`
hook, actor stays resident.

Violations: measuring JavaScript string `.length` or UTF-16 code units instead
of encoded bytes; checking the limit after the write commits; applying the
limit to blobs (`actor_blobs` are exempt); treating overflow as a retryable
defect or a declared application error.

Clean: `TextEncoder`/equivalent byte measurement on the serialized value
before the state write is staged for commit.

Flag only a visible measurement-unit or ordering defect. Do not demand the
check in serialization code that never persists, and do not flag blob writes
for missing the limit — they are contractually exempt.
