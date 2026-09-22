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
  - docs/verification/invariants.md
---

# Foreign mutation is rejected atomically

A mutation touching rows owned by another tenant or actor fails as a whole —
invariant A4: a foreign write cannot partially succeed. Ownership override
attempts, missing scope, and mutation outside a command turn are rejected
without any committed effect.

Violations: applying only the in-scope portion of a mixed-owner write;
honoring a caller-supplied `tenant_id`/`actor_id` that disagrees with trusted
context; executing raw SQL that bypasses ownership enforcement instead of
rejecting it; returning success after skipping the foreign rows.

Clean: the whole statement is rejected (or constrained so foreign rows cannot
be affected) before any write lands; the rejection surfaces as an error in the
turn.

Flag only a visible partial-application or override-acceptance path.
Cross-actor reads through the `Database` tag are a sanctioned read path — do
not flag them, and do not demand mutation support that the adapter matrix does
not claim.
