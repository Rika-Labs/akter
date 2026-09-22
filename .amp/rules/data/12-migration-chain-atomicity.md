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
  - docs/contracts/06-storage-ownership.md
  - docs/contracts/03-transactions.md
---

# State migration is complete and atomic

A turn decodes stored `actor_state` through the complete declared `migrations`
chain to the current shape before the handler runs, and writes the current
shape on successful commit. Migration writes are business work: an unhandled
declared failure or pre-commit crash discards them. An invalid chain fails at
`Actor.make`, not at first decode.

Violations: decoding only the latest migration step instead of the full chain;
persisting intermediate upcast results before the outer commit; keeping
migration writes after a declared failure rolled business work back;
deferring chain validation to decode time.

Clean: sequential upcast from the stored version inside the turn transaction;
failure leaves the stored row untouched for redelivery.

Flag only a visible truncation, ordering, or atomicity defect. Do not demand a
migration for a stored version you cannot see, and do not flag intentionally
seeded old-version rows in tests — they exist to exercise this path.
