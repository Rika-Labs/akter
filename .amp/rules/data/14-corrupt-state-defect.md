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
  - docs/contracts/09-recovery.md
---

# Corrupt durable data is a defect, never a reset

A stored `actor_state` row that fails schema decode is a deterministic defect:
the turn rolls back, the caller receives `Die`, the cause is recorded (the M0
`onDefect` hook runs with read-only `WakeContext`; ADR 0012 removes the hook in
favor of span telemetry), and the stored bytes are preserved for repair. Corrupt data is
never silently replaced with defaults or an initial state.

Violations: catching a decode error and substituting `State.initial` or an
empty/default value; deleting or overwriting the undecodable row; letting a
migration upcast swallow a decode failure and continue; running any defect
reaction with write capabilities.

Clean: decode failure propagates as the defect path; the hook's lazy read-only
`state` effect may itself die on the same corruption and that is expected.

Flag only a visible default/reset/substitution on the decode path.
Deliberately corrupt seeded rows in tests and fixtures exercise this path —
do not flag them.
