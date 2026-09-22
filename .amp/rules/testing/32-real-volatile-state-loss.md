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

# Recovery tests actually lose volatile state

A test claiming crash or restart recovery must destroy the volatile authority:
a real process kill (SIGKILL suite), a fresh layer/runtime build, or a new
activation. Re-invoking a handler, calling a "recover" helper, or clearing a
local variable while the same activation and memory live on is not recovery.

Violations: asserting "recovered" state that the still-running activation
could have served from memory; a crash test that never kills or rebuilds
anything; simulating restart by calling the same in-process instance again;
asserting durable rows were rewritten when they were merely re-read.

Clean: crash hooks fire inside the turn before a real fault boundary; a
separate pool inspects durable rows while the original process is dead; a
fresh process completes the persisted message with one transition.

Flag only a visible fake-recovery assertion. In-process multi-runner
simulation is allowed for serialization coverage but must not be presented as
multi-process fencing evidence — flag the claim, not the simulation.
