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
---

# Contention tests use independent connections

A test asserting lock contention, isolation, or concurrent-writer behavior
needs genuinely independent database connections — two clients, pools, or
processes that can hold conflicting locks at once. A single connection or a
serialized harness cannot produce contention.

Violations: "concurrent" sends sequenced on one connection; asserting a lock
timeout without a second connection holding the lock; running a contention
case on PGlite (its sole connection makes `independentConnections: false`
mandatory) and claiming the contention was exercised; interleaving steps on
one client and calling it a race.

Clean: the Postgres-only shared cases run against `TEST_DATABASE_URL` with a
second connection; PGlite reports them through `registrar.skip` by name.

Flag only a visible fake-contention construction. Sequential tests of
non-concurrency behavior are fine; do not demand a second connection from
single-writer cases.
