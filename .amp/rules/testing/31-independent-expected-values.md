---
enabled: true
paths:
  - packages/durable-actors/src/**/*.test.ts
  - examples/**/*.test.ts
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 0
---

# Expected values are derived independently

A test's expected value must be a literal or an independently computed
constant — never produced by calling the implementation under test, reading
back the value it just wrote, or snapshotting whatever the code emitted.

Violations: `expect(result).toBe(produceResult(input))` where
`produceResult` is the function under test; asserting a stored row equals a
value read through the same code path that wrote it; a snapshot asserted
without any independent expectation; computing expected state by replaying
the handler's own logic.

Clean: literals, hand-computed tables, or a second derivation that shares no
code with the implementation — including asserting against raw SQL rows for
durable results.

Flag only a visible circular assertion. Helper functions that merely build
inputs (not expectations) are fine; do not flag setup code, and do not demand
independent derivations for assertions about shape or type only.
