---
enabled: true
paths:
  - packages/durable-actors/src/**/*.test.ts
  - packages/durable-actors/src/testing/**
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 5
contextFiles:
  - docs/verification/01-conformance.md
  - docs/verification/02-failure-matrix.md
---

# Evidence matches the mechanism it claims

A test or doc claiming a guarantee must exercise the real mechanism that
provides it: lock contention and concurrency claims need real Postgres with
independent connections; PGlite results never generalize to multi-process
behavior; a skipped provider/backend case is not a pass; a typechecked sketch
is not runtime evidence.

Violations: asserting fence or lock behavior while mocking the lock or running
on a single shared connection; presenting a PGlite result as proof of Postgres
contention behavior; recording a `registrar.skip` outcome as passing evidence;
claiming Neki behavior without a Neki run.

Clean: the conformance suite routes contention cases to Postgres, reports
unsupported backends by name through `registrar.skip`, and the ledger records
revision, backend, and command for each claim.

Flag only a visible mechanism/claim mismatch in the test or its description.
Do not flag a correctly scoped unit test, and do not demand Postgres for
cases that are explicitly shared-suite transactional checks.
