---
enabled: true
paths:
  - packages/durable-actors/src/**/*.test.ts
  - packages/durable-actors/src/testing/**
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 0
contextFiles:
  - docs/verification/01-conformance.md
---

# Skips are explicit, gated, and never counted as passes

A skipped case must be reported by name through the harness (`registrar.skip`,
`it.skipIf`, `describe.skipIf`) with a real environmental gate — never skipped
silently, never conditioned on an arbitrary flag, and never recorded in
evidence as a pass.

Violations: returning early from a test body to emulate a skip; wrapping the
assertion in `if (hasPostgres)` so the test passes vacuously; catching the
failure and skipping retroactively; marking a capability "supported" in docs
or ledgers on the strength of skipped cases; `it.skip` without an
environmental reason.

Clean: `registrar.skip` reports the case name for backends lacking
`independentConnections`; `it.skipIf(!process.env.TEST_DATABASE_URL)` carries
its reason; a skipped provider test stays explicitly unsupported in evidence.

Flag only a visible silent or dishonest skip. Skipping for a documented,
missing external dependency is the intended mechanism — do not flag the skip
itself.
