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
  - docs/contracts/02-command-turns.md
---

# Creation marker commits with its first success

For actors declaring `Lifecycle.createdBy`, the turn resolves the receipt
first, then checks the `created` marker under the generation lock: a
non-creating command on an uncreated actor fails `NotCreated` with no receipt;
a failed creating turn keeps its error receipt and stays uncreated; the first
success sets `created` in the same commit as state and receipt.

Violations: setting `created` before the handler commits or in a separate
transaction; writing a receipt for the rejected non-creating command; treating
a failed creating turn as created; checking `created` outside the generation
lock so a concurrent turn can race past it; marking a successful command as
created when no `Lifecycle.createdBy` is declared, so adding that policy later
mistakenly unlocks a pre-policy actor.

Flag only a visible ordering or atomicity break in the creation path. Actors
without `createdBy` must leave the marker false; do not demand a creation check
for them, and do not flag the receiptless `NotCreated` rejection (it is required).
