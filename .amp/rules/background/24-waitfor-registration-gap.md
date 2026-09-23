---
enabled: true
paths:
  - packages/durable-actors/src/runtime/workflows/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 10
contextFiles:
  - docs/contracts/05-messaging.md
  - docs/contracts/08-background-work.md
---

# waitFor registration has no start-to-wait gap

`waitFor(Event, { where, timeout })` observes only the owner actor's committed
events and closes the registration race: an owner event published between
workflow start and wait registration must still resolve the wait. Timeout
returns `Option.none`; the wait survives restart through durable registration.

Violations: subscribing only to events that arrive after registration (the
gap); matching events across owners or tenants; returning an error, hanging,
or returning a wrong value on timeout; registering the wait in process memory
where restart loses it.

Clean: registration is durable before the wait is observable, and matching
reads committed owner events including ones that predate registration.

Flag only a visible gap, scope, or timeout-semantics defect. This subsystem is
not yet implemented; match only real code, not `.gitkeep` placeholders, and do
not demand wait machinery from unrelated scheduling code.
