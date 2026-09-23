---
enabled: true
paths:
  - packages/durable-actors/src/**/*.test.ts
  - packages/durable-actors/src/testing/**
exclude: []
on: code-change
severity: info
threshold: 0.9
priority: -10
---

# Ordering comes from barriers, not sleeps

A test that requires two actions to overlap or sequence must synchronize on an
explicit barrier — a latch, deferred, signaled crash point, pause/release
hook, or awaited condition — never on a fixed `setTimeout`/`Effect.sleep`
delay that hopes the other side finished.

Violations: `await sleep(500)` then asserting another operation "must have"
run; racing delivery against a wall-clock delay; polling without a timeout
bound or a condition; using sleeps to manufacture lock contention instead of
holding the lock on a second connection.

Clean: `TurnHooks` pause/release points, deferred barriers the test controls,
`vi.waitFor`/condition waits with bounded timeouts, and signaled crash
barriers like the SIGKILL suite uses.

Flag only a visible timing-dependent assertion. Legitimate time-bounded waits
(asserting something does NOT happen within a bound, polling a condition with
deadline) are fine — flag sleeps that order work, not sleeps that bound it.
