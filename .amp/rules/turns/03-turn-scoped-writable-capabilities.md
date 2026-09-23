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
  - docs/api/02-context.md
  - docs/contracts/01-actor-authority.md
---

# Writable capabilities are scoped to a live turn

Durable mutation exists only on the command context (`CommandContext` in M0,
`X.Turn` in the target API) inside a live command turn;
transaction-bound capabilities are invalid the moment that turn ends. Query,
stream, connection, wake/sleep/defect, `run`, and workflow contexts expose
read-only capabilities only.

Violations: a state setter or scoped-row writer callable outside a turn;
capturing state setters, row or blob writers into a callback, stream, forked
fiber, or activation-local value that outlives the turn; silently substituting an unscoped or pooled client
when the transaction-bound capability is unavailable — unavailability must be
an error, never a bypass.

Clean: off-turn code receives `ScopedRead`/`BlobRead`/`StateSnapshot`, and
escaped capabilities reject at runtime.

Flag only a visible capability escape or fallback. Handle acquisition before a
turn (`X.get`, `Actor.as`) is legal and not a violation; do not flag read-only
access or demand capabilities in code that has none.
