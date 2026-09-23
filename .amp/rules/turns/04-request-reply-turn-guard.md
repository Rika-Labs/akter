---
enabled: true
paths:
  - packages/durable-actors/src/runtime/**
  - packages/durable-actors/src/handles/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 15
contextFiles:
  - docs/contracts/01-actor-authority.md
  - docs/api/02-context.md
---

# Request/reply never crosses a turn boundary

The runtime guard must reject a request/reply call made inside a turn —
including a handle acquired before the turn began — with `Request/reply inside
a turn`, and the enclosing transaction must roll back. Cross-actor work from a
turn exists only as durable intents.

Violations: a guard that checks handles only at acquisition time and misses
pre-captured ones; catching or downgrading the guard error so the turn can
continue; permitting request/reply on any context that reaches it inside a turn
because TypeScript would have blocked it anyway — the runtime remains the final
authority.

Clean: `X.intents(id)` methods record transaction-bound intents (the M0 code
has no intents yet); outside a turn, request/reply handles work normally.

Flag only a visible gap in the guard or a visible in-turn request/reply. Tests
and fixtures that deliberately exercise the guard are expected, not defects.
