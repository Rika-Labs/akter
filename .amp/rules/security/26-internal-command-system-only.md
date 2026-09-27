---
enabled: true
paths:
  - packages/durable-actors/src/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/contracts/10-security.md
  - docs/contracts/02-command-turns.md
---

# Internal commands are System-only and never public

Internal commands are absent from public handles, the `@durable-actors/core/client`
Promise client, and served endpoints. They run only through framework System
handles; a non-`System` caller reaching one is a deterministic defect — `Die`,
rollback, cause recorded — not an `ActorError` and not a forgeable result path.
System attribution preserves `source`, optional `ref`, and `onBehalfOf`.

Violations: exporting an internal command on a public or client-facing handle;
mapping the non-System attempt to a normal declared error that commits a
receipt; trusting caller-supplied `System` attribution from an untrusted edge;
an internal result command reachable via HTTP.

Clean: internal membership is filtered at handle construction; the defect path
applies inside the turn.

Flag only a visible exposure or wrong error class. Tests driving internal
commands through the `system` handle of `ActorTest` are the intended path —
do not flag them.
