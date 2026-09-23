---
enabled: true
paths:
  - packages/durable-actors/src/handles/**
  - packages/durable-actors/src/actor/**
  - packages/durable-actors/src/index.ts
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/api/01-server-api.md
---

# Public actor capabilities do not expose internal execution

The public `Actors` service only mints command ids. Raw `register`, `execute`,
and actor-id minting belong to package-internal runtime capabilities, and an
actor definition must not expose its internal-command handle through a symbol,
property, or public export. `X.create()` exists only on minted actors.

Violations: adding raw execution or registration methods back to the exported
`Actors` service; putting a System/internal handle on an actor definition even
under an obscure symbol; exposing `InternalActors` at a package entry point;
making `X.create()` callable on named or singleton actors.

Clean: runtime and tests use a package-internal capability; an internal handle
is held in a private registry; ordinary server code uses public handles and
minted identities. System attribution is trusted server input, not external
authentication. Flag only an exposed capability or invalid mint type visible
in changed code, not the mere existence of internal methods in package files.
