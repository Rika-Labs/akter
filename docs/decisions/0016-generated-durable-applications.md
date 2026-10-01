# ADR 0016: Generated durable applications

**Status:** exploratory product direction; security and implementation gated (2026-09-23)

**Responsibility:** define a safer alternative to arbitrary generated servers for dynamic applications.

**Authority:** product and security direction.

**Owner role:** product/security.

**Change policy:** this ADR must be replaced before claiming hostile-code isolation or multi-tenant generated applications.

## Context

Rivet Dynamic Apps deploys generated HTTP applications inside isolated agentOS VMs. Akter can instead generate a contract plus handlers and derive ownership-scoped storage, OpenAPI, MCP, live queries, receipts, and tests. This could make durable data and validation the product boundary, but generated code is still untrusted until an actual isolation mechanism proves otherwise.

## Decision

M8 will investigate generated Durable Actor applications as a gated control-plane feature:

1. Generate a contract and handler source, never execute it directly in the control plane.
2. Typecheck, lint, validate schema ownership, dry-run migrations against an isolated database branch, run `ActorTest` smoke and failure cases, and produce a signed immutable build.
3. Activate only a versioned build behind tenant-scoped credentials, resource limits, and an explicit rollback pointer.
4. Keep generated applications out of the host process unless a separately reviewed sandbox boundary exists. TypeScript capabilities and Postgres RLS are defense-in-depth, not hostile-code isolation.
5. Derive HTTP, OpenAPI, MCP, Promise clients, and observation surfaces from the validated contract. Keep deployment, activation, and rollback in control-plane actors.

The first release target is trusted or reviewable generated applications. Arbitrary hostile user code remains unsupported until a sandbox provider and a threat-model review prove isolation.

## Consequences

Applications get a constrained, inspectable backend model instead of an arbitrary server. The platform can validate behavior before activation and retain durable deployment history. The approach gives up unrestricted Node APIs and requires a supported framework surface for generated code.

## Alternatives rejected

- Running generated HTTP servers in the API process: unsafe and incompatible with the threat model.
- Calling capability types a sandbox: compile-time restrictions cannot contain malicious runtime code.
- Copying Dynamic Apps exactly: duplicates VM infrastructure and leaves relational authority outside the actor contract.

## Evidence and revisit conditions

M8 requires adversarial generated-code tests, tenant-isolation tests, migration rollback, build reproducibility, activation rollback, resource limits, and a reviewed isolation threat model. Revisit the boundary if the project chooses to provide a first-party VM or limits the product to trusted code generation.

See [illustrative API sketches](../api/post-foundation-sketches.md) and the [research sources](../../research/v5/SOURCES.md).
