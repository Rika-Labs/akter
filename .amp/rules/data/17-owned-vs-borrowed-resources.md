---
enabled: true
paths:
  - packages/durable-actors/src/runtime/database/**
  - packages/durable-actors/src/testing/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: warning
threshold: 0.9
priority: 0
contextFiles:
  - docs/verification/01-conformance.md
---

# Owned resources are closed; borrowed ones are not

A layer or harness that creates a resource (a PGlite instance, a pool, a
connection) owns its lifecycle and closes it on release. A resource supplied
by the caller is borrowed: the consumer must not close, dispose, or monkey-
patch it — including replacing methods such as `query`.

Violations: closing or disposing a caller-provided client in a `Layer` finalizer
or `Scope` release; patching a borrowed client's methods; leaking an owned
resource by never registering its release; treating "borrowed" and "owned"
interchangeably in construction options.

Clean: owned instances get `Effect.acquireRelease`/`Scope` cleanup; borrowed
instances pass through untouched; the conformance cases "owns a fresh
database per layer build and closes both instances" and "leaves a borrowed
client open and does not replace its query method" encode this.

Flag only a visible lifecycle inversion. Do not infer ownership from naming
alone — check who constructed the resource in the visible code.
