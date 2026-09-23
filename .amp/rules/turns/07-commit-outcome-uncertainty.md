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

# Uncertain commit stays uncertain

When a commit's outcome is unknown — the connection dropped or the error
arrived after `COMMIT` was issued — the turn MUST NOT resolve to a terminal
success or failure. Recovery resolves through the durable receipt, not through
assumptions about what the database did.

Violations: catching a commit error and returning success or a typed failure
to the caller; writing a failure receipt "just in case" after an ambiguous
commit; issuing a retry on the assumption that the earlier attempt definitely
failed; reporting the command as completed based on local state alone.

Clean: the ambiguous outcome stays in the retryable-defect path — the
activation restarts, the same envelope is redelivered, and the receipt resolves
which transition actually committed.

Flag only a visible collapse of ambiguity into a definite verdict. A clearly
failed commit (rollback observed on the same connection) is not ambiguous;
do not flag tests that inject definite failures.
