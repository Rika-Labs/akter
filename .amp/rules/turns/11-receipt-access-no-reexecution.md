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
  - docs/contracts/04-receipts.md
  - docs/contracts/02-command-turns.md
---

# Receipt resolution never re-executes

Resolving a retained receipt returns the committed output or declared failure
directly: it skips state migration and handler execution entirely, and receipt
access is checked without rerunning the handler. A denied caller does not fall
through to a fresh execution; knowledge of a command id grants nothing.

Violations: an authorization failure on receipt read that proceeds into the
handler path; replay that re-runs state decode or the handler "to verify";
treating an unknown-to-that-caller receipt as absent and executing; letting
receipt reads bypass the current-authorization check because the caller once
held access.

Clean: insert-or-resolve happens inside the turn; resolve short-circuits to
the stored outcome after the access check; denial is terminal.

Flag only a visible fall-through or re-execution on the resolve path. A
genuinely absent receipt proceeding to first execution is the normal path —
do not flag it.
